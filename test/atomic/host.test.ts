import assert from 'node:assert/strict';
import test from 'node:test';
import { AtomicHost } from '../../src/atomic/host.ts';
import { InMemoryStorage } from '../../src/atomic/memory-storage.ts';
import { slotFor } from '../../src/atomic/sync.ts';
import type { Input } from '../../src/atomic/types.ts';
import { ABC_FUNDAMENTAL, KeywordClassifier, TestClock, topicEmbedder } from './helpers.ts';

const SYNC = { cycleMs: 12 * 60_000, slots: 12, maxConcurrent: 2, batchSize: 3 };
const CYCLE_START = Date.parse('2026-10-01T00:00:00.000Z');

function windowStart(tenantId: string, cycle = 0): string {
  return new Date(CYCLE_START + cycle * SYNC.cycleMs + slotFor(tenantId, SYNC.slots) * 60_000 + 1000).toISOString();
}

function makeHost(clock = new TestClock('2026-10-01T00:00:00.000Z')) {
  const created: string[] = [];
  const stores = new Map<string, InMemoryStorage>();
  const host = new AtomicHost({
    storageFor: async (tenantId) => {
      created.push(tenantId);
      const storage = new InMemoryStorage();
      stores.set(tenantId, storage);
      return storage;
    },
    fundamentalFor: (tenantId) => ({ ...ABC_FUNDAMENTAL, businessName: tenantId }),
    models: { embedder: topicEmbedder, classifier: new KeywordClassifier() },
    sync: SYNC,
    clock,
  });
  return { host, created, stores, clock };
}

const order = (raw: string): Input => ({
  context: { kind: 'user_user', topic: 'order nails payment', partyId: 'customer-1', dealId: 'd1' },
  participants: ['Nikhil', 'Vinod'],
  raw,
});

test('clients are opened on demand, once, each with its own storage', async () => {
  const { host, created } = makeHost();
  assert.deepEqual(host.openTenants(), []);
  const [first, second] = await Promise.all([host.open('abc'), host.open('abc')]);
  assert.equal(first, second);
  assert.deepEqual(created, ['abc']);
  const other = await host.open('xyz');
  assert.notEqual(other, first);
  assert.deepEqual(created, ['abc', 'xyz']);
  assert.equal(other.fundamental.businessName, 'xyz');
});

test("one client's memory is invisible to another", async () => {
  const { host } = makeHost();
  const abc = await host.open('abc');
  const xyz = await host.open('xyz');
  await abc.process(order('Vinod: 3 ton wire nails chahiye'));
  const fromXyz = await xyz.recall({ kind: 'user_user', topic: 'order nails', partyId: 'customer-1' }, 'wire nails');
  assert.equal(fromXyz.memories.length, 0);
  const fromAbc = await abc.recall({ kind: 'user_user', topic: 'order nails', partyId: 'customer-1' }, 'wire nails');
  assert.ok(fromAbc.memories.length > 0);
});

test('a client whose storage fails to open can be retried', async () => {
  let attempts = 0;
  const host = new AtomicHost({
    storageFor: async () => {
      attempts++;
      if (attempts === 1) throw new Error('db not ready');
      return new InMemoryStorage();
    },
    fundamentalFor: () => ABC_FUNDAMENTAL,
    models: { embedder: topicEmbedder, classifier: new KeywordClassifier() },
  });
  await assert.rejects(host.open('abc'), /db not ready/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(await host.open('abc'));
  assert.equal(attempts, 2);
});

test('learning is applied only inside the client window, once per cycle', async () => {
  const { host, clock } = makeHost();
  const abc = await host.open('abc');
  const result = await abc.process(order('Vinod: 3 ton wire nails chahiye'));
  const id = result.statements[0].memoryId;
  await abc.feedback('memory', id, 'confirmed');

  const slot = slotFor('abc', SYNC.slots);
  clock.set(new Date(CYCLE_START + ((slot + 6) % SYNC.slots) * 60_000 + 1000).toISOString());
  assert.deepEqual(await host.tick(), []);
  assert.equal(await abc.pendingLearning(), 1);

  clock.set(windowStart('abc'));
  assert.deepEqual(await host.tick(), [{ tenantId: 'abc', applied: 1 }]);
  assert.equal(await abc.pendingLearning(), 0);

  await abc.feedback('memory', id, 'confirmed');
  assert.deepEqual(await host.tick(), [], 'already synced this cycle');
  assert.equal(await abc.pendingLearning(), 1);

  clock.set(windowStart('abc', 1));
  assert.deepEqual(await host.tick(), [{ tenantId: 'abc', applied: 1 }]);
});

test('a big backlog is applied in batches across ticks inside the same window', async () => {
  const { host, clock } = makeHost();
  const abc = await host.open('abc');
  const result = await abc.process(order('Vinod: 3 ton wire nails chahiye'));
  for (let index = 0; index < 7; index++) await abc.feedback('memory', result.statements[0].memoryId, 'confirmed');
  clock.set(windowStart('abc'));
  assert.deepEqual(await host.tick(), [{ tenantId: 'abc', applied: 3 }]);
  assert.deepEqual(await host.tick(), [{ tenantId: 'abc', applied: 3 }]);
  assert.deepEqual(await host.tick(), [{ tenantId: 'abc', applied: 1 }]);
  assert.deepEqual(await host.tick(), []);
});

test('at most maxConcurrent clients sync in one tick', async () => {
  const { host, clock } = makeHost();
  const sameSlot: string[] = [];
  const target = slotFor('abc', SYNC.slots);
  for (let index = 0; sameSlot.length < 3; index++) {
    if (slotFor(`client-${index}`, SYNC.slots) === target) sameSlot.push(`client-${index}`);
  }
  for (const tenant of sameSlot) await host.open(tenant);
  clock.set(windowStart('abc'));
  assert.equal((await host.tick()).length, 2);
  assert.equal((await host.tick()).length, 1);
  assert.equal((await host.tick()).length, 0);
});

test('clients in different windows sync at different times', async () => {
  const { host, clock } = makeHost();
  let other = 'client-0';
  for (let index = 0; slotFor(other, SYNC.slots) === slotFor('abc', SYNC.slots); index++) other = `client-${index}`;
  await host.open('abc');
  await host.open(other);
  clock.set(windowStart('abc'));
  assert.deepEqual((await host.tick()).map((item) => item.tenantId), ['abc']);
  clock.set(windowStart(other));
  assert.deepEqual((await host.tick()).map((item) => item.tenantId), [other]);
});

test('closing a client drops it from syncing', async () => {
  const { host, clock } = makeHost();
  await host.open('abc');
  host.close('abc');
  clock.set(windowStart('abc'));
  assert.deepEqual(await host.tick(), []);
  assert.deepEqual(host.openTenants(), []);
});
