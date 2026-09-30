import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG, DEFAULT_WEIGHTS } from '../../src/atomic/config.ts';
import { adjustStrength, applyLearning, effectiveStrength } from '../../src/atomic/learning.ts';
import { InMemoryStorage } from '../../src/atomic/memory-storage.ts';
import type { Link, Memory } from '../../src/atomic/types.ts';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);

function link(id: string, strength = 0.5): Link {
  return { id, from: 'a', to: 'b', kind: 'similar', strength, confirms: 0, rejects: 0, lastUsedAt: '2026-10-01T00:00:00.000Z' };
}

function memory(id: string, strength = 0.5): Memory {
  return {
    id, level: 'L1', statementId: 's', experienceId: 'e', content: 'x', vector: [1], facts: {}, certainty: 1, importance: 1,
    status: 'active', strength, lastUsedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z',
  };
}

test('confirmation, good outcome and repetition strengthen towards 1', () => {
  close(adjustStrength(0.5, 'confirmed', DEFAULT_CONFIG), 0.6);
  close(adjustStrength(0.5, 'good_outcome', DEFAULT_CONFIG), 0.6);
  close(adjustStrength(0.5, 'repeat', DEFAULT_CONFIG), 0.6);
  let strength = 0.5;
  for (let index = 0; index < 100; index++) strength = adjustStrength(strength, 'confirmed', DEFAULT_CONFIG);
  assert.ok(strength < 1 && strength > 0.999);
});

test('rejection and bad outcome weaken towards 0; other signals leave strength alone', () => {
  close(adjustStrength(0.5, 'rejected', DEFAULT_CONFIG), 0.35);
  close(adjustStrength(0.5, 'bad_outcome', DEFAULT_CONFIG), 0.35);
  close(adjustStrength(0.5, 'missed', DEFAULT_CONFIG), 0.5);
  let strength = 0.9;
  for (let index = 0; index < 100; index++) strength = adjustStrength(strength, 'rejected', DEFAULT_CONFIG);
  assert.ok(strength > 0 && strength < 0.001);
});

test('decay is exponential in days since last use and never grows strength', () => {
  const now = new Date('2026-10-31T00:00:00.000Z');
  close(effectiveStrength(0.8, '2026-10-01T00:00:00.000Z', now, DEFAULT_CONFIG), 0.8 * Math.exp(-0.3));
  close(effectiveStrength(0.8, '2026-10-31T00:00:00.000Z', now, DEFAULT_CONFIG), 0.8);
  close(effectiveStrength(0.8, '2026-11-30T00:00:00.000Z', now, DEFAULT_CONFIG), 0.8);
  close(effectiveStrength(0.8, 'not a date', now, DEFAULT_CONFIG), 0.8);
});

test('decay works for fractions of a day (no rounding that resets the clock)', () => {
  const now = new Date('2026-10-01T12:00:00.000Z');
  assert.ok(effectiveStrength(0.8, '2026-10-01T00:00:00.000Z', now, DEFAULT_CONFIG) < 0.8);
});

test('applyLearning updates links, memories and track records in order', async () => {
  const storage = new InMemoryStorage();
  await storage.putLink(link('l1'));
  await storage.putMemory(memory('m1'));
  const result = await applyLearning(storage, [
    { at: '2026-10-02T00:00:00.000Z', target: 'link', id: 'l1', signal: 'confirmed' },
    { at: '2026-10-03T00:00:00.000Z', target: 'link', id: 'l1', signal: 'rejected' },
    { at: '2026-10-02T00:00:00.000Z', target: 'memory', id: 'm1', signal: 'good_outcome' },
    { at: '2026-10-02T00:00:00.000Z', target: 'track_record', subject: 'sharma', intent: 'commit', kept: false },
    { at: '2026-10-03T00:00:00.000Z', target: 'track_record', subject: 'sharma', intent: 'commit', kept: true },
    { at: '2026-10-03T00:00:00.000Z', target: 'link', id: 'missing', signal: 'confirmed' },
  ], DEFAULT_CONFIG);
  assert.deepEqual(result, { applied: 5, skipped: 1 });
  const updated = (await storage.getLinkById('l1'))!;
  close(updated.strength, 0.6 * 0.7);
  assert.equal(updated.confirms, 1);
  assert.equal(updated.rejects, 1);
  assert.equal(updated.lastUsedAt, '2026-10-03T00:00:00.000Z');
  close((await storage.getMemory('m1'))!.strength, 0.6);
  assert.deepEqual(await storage.getTrackRecord('sharma', 'commit'), { subject: 'sharma', intent: 'commit', kept: 1, total: 2 });
});

test('weights move by a step per signal and stay within 0..5', async () => {
  const storage = new InMemoryStorage();
  const missed = Array.from({ length: 30 }, () => ({
    at: '2026-10-02T00:00:00.000Z', target: 'weights' as const, kind: 'general_chat' as const, angles: ['emotion' as const], signal: 'missed' as const,
  }));
  await applyLearning(storage, missed, DEFAULT_CONFIG);
  assert.equal((await storage.getWeights())!.general_chat.emotion, 5);
  await applyLearning(storage, [
    { at: '2026-10-02T00:00:00.000Z', target: 'weights', kind: 'order', angles: ['trust', 'stance'], signal: 'dismissed' },
  ], DEFAULT_CONFIG);
  const weights = (await storage.getWeights())!;
  assert.equal(weights.order.trust, DEFAULT_WEIGHTS.order.trust - DEFAULT_CONFIG.weightStep);
  assert.equal(weights.order.stance, DEFAULT_WEIGHTS.order.stance - DEFAULT_CONFIG.weightStep);
  assert.equal(DEFAULT_WEIGHTS.order.trust, 1, 'defaults are never mutated');
  const floor = Array.from({ length: 30 }, () => ({
    at: '2026-10-02T00:00:00.000Z', target: 'weights' as const, kind: 'order' as const, angles: ['trust' as const], signal: 'dismissed' as const,
  }));
  await applyLearning(storage, floor, DEFAULT_CONFIG);
  assert.equal((await storage.getWeights())!.order.trust, 0);
});
