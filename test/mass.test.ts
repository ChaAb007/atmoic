import assert from 'node:assert/strict';
import test from 'node:test';
import { decayedMass } from '../src/mass.ts';

test('mass falls by whole days since the last reference', () => {
  const now = new Date('2026-03-20T00:00:00.000Z');
  assert.equal(decayedMass(5, '2026-03-18T00:00:00.000Z', now), 3);
  assert.equal(decayedMass(1, '2026-03-01T00:00:00.000Z', now), 0);
  assert.equal(decayedMass(4, '2026-03-20T00:00:00.000Z', now), 4);
});
