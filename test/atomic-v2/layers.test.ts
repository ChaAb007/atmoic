import assert from 'node:assert/strict';
import test from 'node:test';
import { ANCHORS } from '../../src/atomic-v2/anchors.ts';
import { DEFAULT_V2_CONFIG } from '../../src/atomic-v2/config.ts';
import {
  allocate,
  buildProbes,
  compose,
  levelGroups,
  pieceImportance,
  probeScore,
  splitPieces,
  summarize,
} from '../../src/atomic-v2/layers.ts';
import type { AnchorVectors, ScoredPiece } from '../../src/atomic-v2/layers.ts';
import { blend, cosine, packVector, unpackVector } from '../../src/atomic-v2/vectors.ts';
import { ConceptEmbedder } from './helpers.ts';

async function probes() {
  const embedder = new ConceptEmbedder();
  const anchors = {} as AnchorVectors;
  for (const [set, sentences] of Object.entries(ANCHORS)) anchors[set as keyof AnchorVectors] = await embedder.embed(sentences);
  return { probes: buildProbes(anchors), embedder };
}

test('vectors survive int8 packing with ~1% cosine error', () => {
  const vector = Array.from({ length: 384 }, (_, index) => Math.sin(index * 1.7) * (index % 7 === 0 ? 3 : 0.4));
  const restored = unpackVector(packVector(vector));
  assert.equal(restored.length, 384);
  assert.ok(cosine(vector, restored) > 0.999);
  assert.deepEqual(unpackVector(packVector([0, 0, 0])), [0, 0, 0]);
});

test('blend weighs and normalises; zero weights and empty vectors are ignored', () => {
  const mixed = blend([{ vector: [1, 0], weight: 3 }, { vector: [0, 1], weight: 1 }, { vector: [], weight: 5 }, { vector: [5, 5], weight: 0 }]);
  assert.ok(Math.abs(Math.hypot(...mixed) - 1) < 1e-9);
  assert.ok(mixed[0] > mixed[1]);
  assert.deepEqual(blend([]), []);
});

test('pieces: sentences per side, short fragments join a neighbour, Hindi danda splits', () => {
  const pieces = splitPieces('Hi. Please make the invoice for AVI today. Thanks!', 'Done. Invoice 1041 is ready for AVI. यह भेज दिया। अब चेक करें');
  assert.deepEqual(pieces.map((piece) => piece.text), [
    'Hi. Please make the invoice for AVI today. Thanks!',
    'Done. Invoice 1041 is ready for AVI.',
    'यह भेज दिया।',
    'अब चेक करें',
  ]);
  assert.deepEqual(pieces.map((piece) => piece.side), ['ask', 'response', 'response', 'response']);
  assert.equal(splitPieces('a '.repeat(10), 'one two three. '.repeat(50)).filter((piece) => piece.side === 'response').length, 30);
});

test('probes are calibrated: each set scores its own examples high and the others low', async () => {
  const { probes: calibrated, embedder } = await probes();
  for (const set of ['decision', 'commitment', 'pressure', 'emotionNegative', 'risk'] as const) {
    const own = await embedder.embed(ANCHORS[set]);
    const mean = own.reduce((sum, vector) => sum + probeScore(vector, calibrated[set]), 0) / own.length;
    assert.ok(mean > 0.7, `${set} own mean ${mean}`);
  }
  const [greeting] = await embedder.embed(['hello, good morning']);
  for (const set of ['decision', 'commitment', 'pressure', 'emotionNegative', 'risk'] as const) {
    assert.ok(probeScore(greeting, calibrated[set]) < 0.3, set);
  }
});

test('a topic word in an example does not make an unrelated piece score on that angle', async () => {
  const { probes: calibrated, embedder } = await probes();
  // "I'm worried about the payment" is an emotion example; a neutral payment question must not read as emotional.
  const [question] = await embedder.embed(['Is the payment from AVI late?']);
  assert.ok(probeScore(question, calibrated.emotionNegative) < 0.5);
});

test('importance: noisy-OR over sub-layers above the noise floor, scaled by relevance', () => {
  const config = DEFAULT_V2_CONFIG;
  assert.equal(pieceImportance({}, 1, config), 0);
  assert.equal(pieceImportance({ facts: config.noiseFloor }, 1, config), 0, 'noise adds nothing');
  const one = pieceImportance({ decision: 1 }, 1, config);
  const two = pieceImportance({ decision: 1, risk: 1 }, 1, config);
  assert.ok(two > one && one > 0);
  assert.ok(pieceImportance({ decision: 1 }, 0, config) < one, 'less relevant pieces matter less');
  assert.equal(pieceImportance({ novelty: 1, trust: 1, situation: 1 }, 1, config), 0, 'unit-level checks are added once per unit');
});

test('allocation: L1 work, L2 growth/decision, L3 emotional, and a piece can carry several', () => {
  const config = DEFAULT_V2_CONFIG;
  assert.deepEqual(allocate({ facts: 0.9 }, config), ['L1']);
  assert.deepEqual(allocate({ decision: 0.8 }, config), ['L2']);
  assert.deepEqual(allocate({ emotion: 0.9 }, config), ['L3']);
  assert.deepEqual(allocate({ intent: 0.9, risk: 0.7, emotion: 0.6 }, config), ['L1', 'L2', 'L3']);
  assert.deepEqual(allocate({ facts: 0.3, emotion: 0.2 }, config), []);
  assert.ok(levelGroups({ pressure: 1 }).L3 > 0.5 && levelGroups({ pressure: 1 }).L1 > 0.5, 'pressure is both work and feeling');
});

function piece(levels: ScoredPiece['levels'], vector: number[], profile: ScoredPiece['profile'], relevance = 1): ScoredPiece {
  return { side: 'ask', text: 'x', order: 0, relevance, importance: 0.8, levels, profile, vector };
}

test('composition keeps the whole unit in the combined vector and picks the dominant kind', () => {
  const config = DEFAULT_V2_CONFIG;
  const unit = [1, 1, 1, 0];
  const work = compose([piece(['L1'], [1, 0, 0, 0], { facts: 1 }), piece(['L3'], [0, 0, 1, 0], { emotion: 0.6 })], unit, [0, 1, 0, 0], config);
  assert.equal(work.kind, 'work');
  assert.ok(cosine(work.combined, unit) > 0.8, 'meaning of the whole unit is kept');
  for (const level of ['L1', 'L3', 'L4'] as const) assert.ok(cosine(work.combined, work.levelVectors[level]) > 0.2, level);
  assert.equal(work.levelVectors.L2, undefined);
  const emotional = compose([piece(['L3'], [0, 0, 1, 0], { emotion: 1 })], unit, [0, 1, 0, 0], config);
  assert.equal(emotional.kind, 'emotional');
  const growth = compose([piece(['L2'], [0, 0, 0, 1], { decision: 1 })], unit, [0, 1, 0, 0], config);
  assert.equal(growth.kind, 'growth');
  const casual = compose([], unit, [0, 1, 0, 0], config);
  assert.equal(casual.kind, 'casual');
  assert.ok(casual.levelWeights.L4 >= 0.5, 'the summary always carries weight');
});

test('L4 summary joins the ask and the most relevant part of the response', () => {
  const summary = summarize('apply 3 percent discount for AVI', [
    { side: 'response', text: 'Done.', relevance: 0.1, order: 1, profile: {}, importance: 0, levels: [] },
    { side: 'response', text: 'A 3 percent discount is applied.', relevance: 0.9, order: 0, profile: {}, importance: 0, levels: [] },
  ]);
  assert.equal(summary, 'apply 3 percent discount for AVI → A 3 percent discount is applied.');
});
