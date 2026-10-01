import type { AnchorSet } from './anchors.ts';
import type { AtomicV2Config } from './config.ts';
import { SUB_LAYERS } from './types.ts';
import type { Experience, ExperienceKind, Level, Piece, Profile, Side, SubLayer } from './types.ts';
import { blend, clamp01, cosine, normalize, sigmoid } from './vectors.ts';

export type AnchorVectors = Record<AnchorSet, number[][]>;

/**
 * A calibrated direction for one reference set: the mean of its examples minus the mean of all sets, so the
 * shared meaning (anger, a decision, a deadline) remains and the topics of individual examples cancel out.
 * The threshold sits halfway between how its own examples and everyone else's project onto it, so the same
 * code works for any embedder without hand tuning.
 */
export interface Probe {
  direction: number[];
  threshold: number;
  /** Logistic slope: own examples land near 0.88, others near 0.12. */
  slope: number;
}

export type Probes = Record<AnchorSet, Probe>;

function mean(vectors: number[][]): number[] {
  const sum = new Array<number>(vectors[0].length).fill(0);
  for (const vector of vectors) {
    const unit = normalize(vector);
    for (let index = 0; index < sum.length; index++) sum[index] += unit[index] / vectors.length;
  }
  return sum;
}

export function buildProbes(anchors: AnchorVectors): Probes {
  const sets = Object.keys(anchors) as AnchorSet[];
  const centroids = Object.fromEntries(sets.map((set) => [set, mean(anchors[set])])) as Record<AnchorSet, number[]>;
  const center = mean(sets.map((set) => centroids[set]));
  const probes = {} as Probes;
  for (const set of sets) {
    const direction = normalize(centroids[set].map((value, index) => value - center[index]));
    const own = anchors[set].map((vector) => cosine(vector, direction));
    const others = sets.filter((other) => other !== set).flatMap((other) => anchors[other].map((vector) => cosine(vector, direction)));
    const ownMean = own.reduce((sum, value) => sum + value, 0) / own.length;
    const otherMean = others.reduce((sum, value) => sum + value, 0) / others.length;
    const gap = Math.max(0.05, ownMean - otherMean);
    probes[set] = { direction, threshold: (ownMean + otherMean) / 2, slope: 4 / gap };
  }
  return probes;
}

export function probeScore(vector: number[], probe: Probe): number {
  return sigmoid(probe.slope * (cosine(vector, probe.direction) - probe.threshold));
}

const DAY_MS = 86_400_000;

/** Sub-layers read only from the person: an AI response has no feelings, attention, authority or pressure. */
const HUMAN_ONLY: SubLayer[] = ['emotion', 'attention', 'relationship', 'pressure'];

export interface RawPiece {
  side: Side;
  text: string;
}

/** Split the ask and the response into sentence-sized pieces; very short fragments join their neighbour. */
export function splitPieces(ask: string, response: string, maxPerSide = 30): RawPiece[] {
  const split = (side: Side, text: string): RawPiece[] => {
    const sentences = text
      .split(/(?<=[.!?।])\s+|\n+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    const merged: string[] = [];
    for (const sentence of sentences) {
      const words = sentence.split(/\s+/).length;
      if (words < 3 && merged.length) merged[merged.length - 1] += ` ${sentence}`;
      else merged.push(sentence);
    }
    if (merged.length > 1 && merged[0].split(/\s+/).length < 3) merged.splice(0, 2, `${merged[0]} ${merged[1]}`);
    return merged.slice(0, maxPerSide).map((piece) => ({ side, text: piece }));
  };
  return [...split('ask', ask), ...split('response', response)];
}

export interface EmotionReading {
  intensity: number;
  valence: number;
}

export function readEmotion(vector: number[], probes: Probes): EmotionReading {
  const positive = probeScore(vector, probes.emotionPositive);
  const negative = probeScore(vector, probes.emotionNegative);
  return { intensity: Math.max(positive, negative), valence: positive - negative };
}

/** Layer 2, meaning checks: every sub-layer judged against reference sentences for one piece. */
export function referenceProfile(vector: number[], side: Side, probes: Probes): { profile: Partial<Profile>; emotion: EmotionReading } {
  const check = (set: AnchorSet) => probeScore(vector, probes[set]);
  const emotion = readEmotion(vector, probes);
  const profile: Partial<Profile> = {
    facts: check('facts'),
    intelligence: check('intelligence'),
    intent: check('intent'),
    decision: check('decision'),
    commitment: check('commitment'),
    time: check('time'),
    risk: check('risk'),
    pressure: check('pressure'),
    relationship: check('relationship'),
    emotion: emotion.intensity,
    attention: Math.max(0, check('engaged') - check('disengaged')),
  };
  if (side === 'response') for (const name of HUMAN_ONLY) profile[name] = 0;
  return { profile, emotion: side === 'response' ? { intensity: 0, valence: 0 } : emotion };
}

export interface UnitMemoryChecks {
  novelty: number;
  situation: number;
  trust: number;
  /** Strength of the trust signal either way: |trust - 0.5| * 2. */
  trustSignal: number;
  historyPull: number;
}

/** Layer 2, memory checks: compare the whole unit with what has been lived before. */
export function memoryChecks(unitVector: number[], at: string, past: Experience[], config: AtomicV2Config): UnitMemoryChecks {
  const now = Date.parse(at);
  let maxSimilarity = 0;
  let situation = 0;
  let trustWeight = 0;
  let trustSum = 0;
  let historyPull = 0;
  for (const experience of past) {
    const similarity = Math.max(0, cosine(unitVector, experience.unitVector));
    maxSimilarity = Math.max(maxSimilarity, similarity);
    const days = Math.max(0, (now - Date.parse(experience.at)) / DAY_MS);
    situation = Math.max(situation, similarity * Math.exp(-days / config.situationDays));
    if (similarity < config.similarThreshold) continue;
    const weight = similarity - config.similarThreshold + 0.05;
    trustWeight += weight;
    trustSum += weight * experience.satisfaction;
    const unhappy = experience.satisfaction < 0.35 ? (0.35 - experience.satisfaction) / 0.35 : 0;
    const negativity = Math.max(0, -experience.valence, unhappy);
    historyPull = Math.max(historyPull, similarity * negativity);
  }
  const trust = trustWeight > 0 ? trustSum / trustWeight : 0.5;
  return {
    novelty: past.length ? clamp01(1 - maxSimilarity) : 1,
    situation: clamp01(situation),
    trust,
    trustSignal: clamp01(Math.abs(trust - 0.5) * 2),
    historyPull: clamp01(historyPull),
  };
}

/** Task <-> response check: did the response actually answer the ask? 0..1 for the whole unit. */
export function unitCorrectness(
  askVector: number[],
  responseVector: number[],
  askIntent: number,
  probes: Probes,
  config: AtomicV2Config,
): number {
  const aligned = sigmoid(config.correctnessSharpness * (cosine(askVector, responseVector) - config.correctnessBase));
  const failed = probeScore(responseVector, probes.failure);
  return clamp01(aligned * (1 - failed) * (0.3 + 0.7 * askIntent));
}

/** Layer 2 combination: sub-layers above the noise floor add up (noisy-OR), scaled by Layer 1 relevance. */
export function pieceImportance(profile: Partial<Profile>, relevance: number, config: AtomicV2Config): number {
  let missing = 1;
  for (const name of SUB_LAYERS) {
    if (name === 'novelty' || name === 'trust' || name === 'situation') continue; // unit-level, added once per unit
    const value = profile[name] ?? 0;
    const counted = Math.max(0, (value - config.noiseFloor) / (1 - config.noiseFloor)) * config.weights[name];
    missing *= 1 - config.combineFactor * Math.min(1, counted);
  }
  return clamp01((1 - missing) * (0.6 + 0.4 * relevance));
}

/** Layer 3 group scores: L1 work/current, L2 past/future/growth/decision, L3 emotional. */
export function levelGroups(profile: Partial<Profile>): Record<'L1' | 'L2' | 'L3', number> {
  const value = (name: SubLayer) => profile[name] ?? 0;
  return {
    L1: Math.max(value('facts'), value('intent'), value('commitment'), value('time'), 0.8 * value('correctness'), 0.7 * value('pressure'), 0.6 * value('relationship')),
    L2: Math.max(value('intelligence'), value('decision'), value('risk')),
    L3: Math.max(value('emotion'), 0.8 * value('attention'), 0.8 * value('pressure'), 0.8 * value('relationship')),
  };
}

export function allocate(profile: Partial<Profile>, config: AtomicV2Config): Level[] {
  const groups = levelGroups(profile);
  return (['L1', 'L2', 'L3'] as const).filter((level) => groups[level] >= config.allocThreshold);
}

export interface ScoredPiece extends Piece {
  vector: number[];
}

export interface Composition {
  levelVectors: Partial<Record<Level, number[]>>;
  levelWeights: Record<Level, number>;
  combined: number[];
  kind: ExperienceKind;
}

/** Layers 3-4: level vectors from their pieces, then one combined vector that keeps the whole unit in it. */
export function compose(
  pieces: ScoredPiece[],
  unitVector: number[],
  summaryVector: number[],
  config: AtomicV2Config,
): Composition {
  const levelVectors: Partial<Record<Level, number[]>> = {};
  const levelWeights: Record<Level, number> = { L1: 0, L2: 0, L3: 0, L4: 0 };
  for (const level of ['L1', 'L2', 'L3'] as const) {
    const parts = pieces
      .filter((piece) => piece.levels.includes(level))
      .map((piece) => ({
        vector: piece.vector,
        weight: levelGroups(piece.profile)[level] * (0.5 + 0.5 * piece.relevance) * (0.5 + 0.5 * piece.importance),
      }));
    if (!parts.length) continue;
    levelWeights[level] = parts.reduce((sum, part) => sum + part.weight, 0);
    levelVectors[level] = blend(parts);
  }
  const carried = levelWeights.L1 + levelWeights.L2 + levelWeights.L3;
  levelWeights.L4 = Math.max(0.5, 0.25 * carried);
  levelVectors.L4 = summaryVector;
  const total = carried + levelWeights.L4;
  const combined = blend([
    { vector: unitVector, weight: config.unitShare },
    ...(['L1', 'L2', 'L3', 'L4'] as const)
      .filter((level) => levelVectors[level])
      .map((level) => ({ vector: levelVectors[level]!, weight: (1 - config.unitShare) * (levelWeights[level] / total) })),
  ]);
  const dominant = (['L1', 'L2', 'L3'] as const).reduce((best, level) => (levelWeights[level] > levelWeights[best] ? level : best), 'L1');
  const kind: ExperienceKind = carried < config.casualThreshold
    ? 'casual'
    : dominant === 'L1' ? 'work' : dominant === 'L2' ? 'growth' : 'emotional';
  return { levelVectors, levelWeights, combined, kind };
}

/** L4: a small summary of both sides, from the most relevant piece of each. */
export function summarize(ask: string, pieces: Piece[]): string {
  const top = (side: Side) => pieces.filter((piece) => piece.side === side).sort((left, right) => right.relevance - left.relevance)[0]?.text ?? '';
  const trim = (text: string) => (text.length > 160 ? `${text.slice(0, 157)}…` : text);
  const askPart = ask.split(/\s+/).length <= 25 ? ask.trim() : top('ask');
  const responsePart = top('response');
  return responsePart ? `${trim(askPart)} → ${trim(responsePart)}` : trim(askPart);
}
