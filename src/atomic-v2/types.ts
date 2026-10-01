/**
 * Atomic v2: one ask + one response is one unit. Everything after embedding works on vectors;
 * the raw text is kept only so exact figures ("3%", "₹2.34 lakh") can be read back at answer time.
 */

/** The fifteen ways a person weighs what was said (Layer 2 sub-layers). */
export type SubLayer =
  // what is said
  | 'facts'
  | 'intelligence'
  | 'novelty'
  // who and how
  | 'emotion'
  | 'attention'
  | 'relationship'
  | 'trust'
  // what it means for the work
  | 'intent'
  | 'decision'
  | 'commitment'
  | 'correctness'
  // around it
  | 'time'
  | 'pressure'
  | 'risk'
  | 'situation';

export const SUB_LAYERS: readonly SubLayer[] = [
  'facts', 'intelligence', 'novelty',
  'emotion', 'attention', 'relationship', 'trust',
  'intent', 'decision', 'commitment', 'correctness',
  'time', 'pressure', 'risk', 'situation',
];

export type Profile = Record<SubLayer, number>;

/** Memory levels are kinds, not ranks. */
export type Level = 'L1' | 'L2' | 'L3' | 'L4';

/** L1 work / current · L2 past, future, growth, business decision · L3 emotional · L4 summary of both. */
export type ExperienceKind = 'work' | 'growth' | 'emotional' | 'casual';

export type Side = 'ask' | 'response';

/** Batch text embedder. Vectors from one embedder are only comparable with each other. */
export interface Embedder {
  readonly id: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** One piece of a unit (a sentence of the ask or the response) after Layers 1-3. */
export interface Piece {
  side: Side;
  text: string;
  /** Layer 1: how relevant this piece is to the other side of the unit, 0..1. */
  relevance: number;
  /** Order it went through the layers (0 = most relevant, processed first). */
  order: number;
  /** Layer 2: score per sub-layer, 0..1. Empty when the piece fell outside the processing budget. */
  profile: Partial<Profile>;
  importance: number;
  /** Layer 3: every level this piece was allocated to (a piece can carry work and emotion at once). */
  levels: Level[];
}

export interface Experience {
  id: string;
  /** When the ask was made (ISO). */
  at: string;
  ask: string;
  response: string;
  /** The ask and the response embedded together, once. */
  unitVector: number[];
  askVector: number[];
  responseVector: number[];
  pieces: Piece[];
  /** L4: a small summary of both sides. */
  summary: string;
  /** Layer 3 level vectors; a level with nothing allocated is absent. */
  levelVectors: Partial<Record<Level, number[]>>;
  /** How much each level carries; the largest of L1-L3 decides the kind. */
  levelWeights: Record<Level, number>;
  /** Layer 4: one embedding carrying the meaning; the components above are kept, so nothing is lost. */
  combined: number[];
  kind: ExperienceKind;
  /** Highest score each sub-layer reached anywhere in the unit. */
  profile: Profile;
  importance: number;
  /** Feeling of the person asking, -1 (negative) .. 1 (positive). */
  valence: number;
  /** How well this exchange went, 0..1; updated by the person's next reaction and by feedback. */
  satisfaction: number;
  /** Importance added because the same thing went badly (emotionally) before. */
  historyPull: number;
  /** Learned strength, 0..1; decays with time at read, never written back on read. */
  strength: number;
  lastUsedAt: string;
  /** Memories that were recalled into context when this exchange happened. */
  recalled: string[];
  feedback?: 'good' | 'bad';
}

export interface RecallItem {
  experience: Experience;
  score: number;
  similarity: number;
  /** Which part matched best. */
  matched: Level | 'combined' | 'unit' | 'ask';
}

export interface RecallResult {
  query: number[];
  items: RecallItem[];
}
