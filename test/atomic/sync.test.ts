import assert from 'node:assert/strict';
import test from 'node:test';
import { cycleIndex, DEFAULT_SYNC, isWindowOpen, openSlot, slotFor } from '../../src/atomic/sync.ts';

const config = { ...DEFAULT_SYNC, cycleMs: 3_600_000, slots: 12 };

test('a client always gets the same slot, inside the range', () => {
  for (const tenant of ['abc', 'xyz', 'client-42']) {
    const slot = slotFor(tenant, 12);
    assert.equal(slotFor(tenant, 12), slot);
    assert.ok(slot >= 0 && slot < 12);
  }
});

test('clients spread across windows instead of syncing together', () => {
  const counts = new Array(12).fill(0);
  for (let index = 0; index < 1200; index++) counts[slotFor(`client-${index}`, 12)]++;
  assert.ok(counts.every((count) => count > 50), `uneven spread ${counts.join(',')}`);
  assert.ok(Math.max(...counts) < 200, `uneven spread ${counts.join(',')}`);
});

test('the open slot walks through the cycle', () => {
  assert.equal(openSlot(new Date('2026-10-01T10:00:00.000Z'), config), 0);
  assert.equal(openSlot(new Date('2026-10-01T10:04:59.999Z'), config), 0);
  assert.equal(openSlot(new Date('2026-10-01T10:05:00.000Z'), config), 1);
  assert.equal(openSlot(new Date('2026-10-01T10:59:59.999Z'), config), 11);
  assert.equal(cycleIndex(new Date('2026-10-01T10:30:00.000Z'), config) + 1, cycleIndex(new Date('2026-10-01T11:30:00.000Z'), config));
});

test('a client window is open in exactly one slot per cycle', () => {
  const start = Date.parse('2026-10-01T10:00:00.000Z');
  const open = [];
  for (let slot = 0; slot < 12; slot++) {
    if (isWindowOpen('abc', new Date(start + slot * 300_000 + 1000), config)) open.push(slot);
  }
  assert.deepEqual(open, [slotFor('abc', 12)]);
});
