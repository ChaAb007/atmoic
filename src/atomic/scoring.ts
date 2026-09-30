import {
  ANGLES,
  CERTAINTY_SCORE,
  CHANGE_SCORE,
  EMOTION_SCORE,
  INTENT_SCORE,
  RISK_SCORE,
  STANCE_SCORE,
  TYPE_SCORE,
} from './config.ts';
import type { AtomicConfig } from './config.ts';
import type {
  AngleName,
  Angles,
  Facts,
  Fundamental,
  KindGuess,
  Level,
  StatementKind,
  TrackRecord,
  WeightRow,
  WeightsTable,
} from './types.ts';

const FACT_FIELDS: (keyof Facts)[] = ['qty', 'rate', 'amount', 'date', 'item', 'place'];

export function specificsCount(facts: Facts): number {
  return FACT_FIELDS.filter((field) => facts[field] !== undefined && facts[field] !== '').length;
}

export function angleScore(angles: Angles, angle: AngleName): number {
  switch (angle) {
    case 'type': return TYPE_SCORE[angles.type];
    case 'intent': return INTENT_SCORE[angles.intent];
    case 'stance': return STANCE_SCORE[angles.stance];
    case 'emotion': return EMOTION_SCORE[angles.emotion];
    case 'specifics': return Math.min(1, specificsCount(angles.specifics) / 3);
    case 'change': return CHANGE_SCORE[angles.change];
    case 'risk': return RISK_SCORE[angles.risk];
    case 'trust': return angles.trust ? 1 : 0;
  }
}

/** Weighted content score, 0..1. Certainty is not part of it; it is applied as a multiplier. */
export function contentScore(angles: Angles, weights: WeightRow): number {
  let total = 0;
  let sum = 0;
  for (const angle of ANGLES) {
    total += weights[angle];
    sum += weights[angle] * angleScore(angles, angle);
  }
  return total === 0 ? 0 : sum / total;
}

/**
 * Track record as a 0..1 reliability. No history counts as reliable, so newcomers are not penalised
 * before they have made a promise: (kept + 2) / (total + 2).
 */
export function reliability(record: TrackRecord | undefined): number {
  if (!record || record.total === 0) return 1;
  return (record.kept + 2) / (record.total + 2);
}

export function certaintyFactor(certainty: number, config: AtomicConfig): number {
  return config.certaintyFloor + (1 - config.certaintyFloor) * certainty;
}

export function wordingCertainty(angles: Angles): number {
  return CERTAINTY_SCORE[angles.certainty];
}

export interface KindChoice {
  kind: StatementKind;
  content: number;
}

/** Per-statement kind: among the kinds the classifier is reasonably sure of, the one that scores highest. */
export function chooseKind(angles: Angles, kinds: KindGuess[], weights: WeightsTable, config: AtomicConfig): KindChoice {
  const sorted = [...kinds].sort((left, right) => right.confidence - left.confidence);
  const candidates = sorted.filter((guess) => guess.confidence >= config.kindConfidence);
  if (candidates.length === 0 && sorted.length > 0) candidates.push(sorted[0]);
  if (candidates.length === 0) candidates.push({ kind: 'general_chat', confidence: 1 });
  let best: KindChoice | undefined;
  for (const candidate of candidates) {
    const content = contentScore(angles, weights[candidate.kind]);
    if (!best || content > best.content) best = { kind: candidate.kind, content };
  }
  return best!;
}

/** Safety overrides: these always reach L1 and never learn. */
export function isOverride(angles: Angles, kind: StatementKind, fundamental: Fundamental): boolean {
  if (angles.intent !== 'commit') return false;
  const facts = angles.specifics;
  if (facts.date !== undefined) return true;
  if (facts.amount !== undefined || facts.qty !== undefined) return true;
  return fundamental.criticalKinds.includes(kind);
}

export function levelFor(relevance: number, importance: number, override: boolean, config: AtomicConfig): Level {
  if (relevance < config.relevanceThreshold) return 'L3';
  if (override || importance >= config.importanceThreshold) return 'L1';
  return 'L2';
}
