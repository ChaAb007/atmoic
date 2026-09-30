import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AtomicStore } from '../src/store.ts';

test('recording an object makes the next recall return it with a higher mass', () => {
  const store = new AtomicStore(join(mkdtempSync(join(tmpdir(), 'atomic-')), 'atomic.sqlite'));
  const first = store.upsertObject({ type: 'invoice', key: 'INV-709', name: 'Invoice 709' });
  const second = store.upsertObject({ type: 'invoice', key: 'INV-709', name: 'Invoice 709' });
  assert.equal(second.mass, first.mass + 1);

  store.recordAtom({
    verb: 'ask',
    objectKeys: [{ type: 'invoice', key: 'INV-709' }],
    evidence: 'chat',
  });
  const recalled = store.recall('INV-709', [], 5);
  assert.equal(recalled.objects.length, 1);
  assert.equal(recalled.objects[0].key, 'INV-709');
  assert.ok(recalled.objects[0].mass >= 3);
  assert.equal(recalled.atoms.length, 1);
  store.close();
});
