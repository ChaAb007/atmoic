import type { SubLayer } from './types.ts';

export interface AtomicV2Config {
  /** Pieces that go through Layers 2-3, highest relevance first; the rest stay as raw text only. */
  maxPieces: number;
  /** Sub-layer scores below this add nothing to importance. */
  noiseFloor: number;
  /** How strongly each sub-layer adds to importance (noisy-OR). */
  combineFactor: number;
  weights: Record<SubLayer, number>;
  /** A piece goes to every level whose group score reaches this. */
  allocThreshold: number;
  /** Total L1-L3 weight below this makes the experience casual. */
  casualThreshold: number;
  /** Ask/response similarity at which an answer starts to count as on target. Tune per embedder. */
  correctnessBase: number;
  correctnessSharpness: number;
  /** Past experiences at least this similar are "the same thing" for history and trust. */
  similarThreshold: number;
  /** Importance added per unit of past negative experience on the same thing. */
  historyBoost: number;
  /** A new ask within this many minutes and this similar is a reaction to an earlier exchange. */
  followupMinutes: number;
  followupSimilarity: number;
  /** Situation awareness fades over this many days. */
  situationDays: number;
  /** Share of the combined vector given to the whole unit (the rest goes to the level vectors). */
  unitShare: number;
  recallLimit: number;
  /** Below this similarity nothing is recalled. Tune per embedder. */
  recallMinSimilarity: number;
  startStrength: number;
  alpha: number;
  beta: number;
  /** Strength decay per day without use, applied when read. */
  lambda: number;
}

export const DEFAULT_V2_CONFIG: AtomicV2Config = {
  maxPieces: 24,
  noiseFloor: 0.2,
  combineFactor: 0.55,
  weights: {
    facts: 1, intelligence: 0.9, novelty: 0.7,
    emotion: 1, attention: 0.7, relationship: 0.9, trust: 0.7,
    intent: 1, decision: 1.15, commitment: 1.2, correctness: 0.8,
    time: 0.9, pressure: 1.1, risk: 1.15, situation: 0.7,
  },
  allocThreshold: 0.5,
  casualThreshold: 0.35,
  correctnessBase: 0.3,
  correctnessSharpness: 12,
  similarThreshold: 0.55,
  historyBoost: 0.3,
  followupMinutes: 30,
  followupSimilarity: 0.5,
  situationDays: 2,
  unitShare: 0.5,
  recallLimit: 6,
  recallMinSimilarity: 0.35,
  startStrength: 0.5,
  alpha: 0.2,
  beta: 0.3,
  lambda: 0.01,
};
