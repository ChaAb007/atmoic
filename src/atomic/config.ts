import { DEFAULT_DATE_OPTIONS } from './dates.ts';
import type { DateOptions } from './dates.ts';
import type {
  AngleName,
  CertaintyValue,
  ChangeValue,
  EmotionValue,
  IntentValue,
  RiskValue,
  StanceValue,
  TypeValue,
  WeightsTable,
} from './types.ts';

export const ANGLES: AngleName[] = ['type', 'intent', 'stance', 'emotion', 'specifics', 'change', 'risk', 'trust'];

export const TYPE_SCORE: Record<TypeValue, number> = {
  order: 1, payment: 1, rate: 1, delivery: 1, complaint: 1, stock: 1,
  question: 0.6, opinion: 0.4, greeting: 0, small_talk: 0, joke: 0,
};

export const INTENT_SCORE: Record<IntentValue, number> = {
  commit: 1, decide: 1, cancel: 1, request: 0.8, assign: 0.8, negotiate: 0.6, confirm: 0.5, none: 0,
};

export const STANCE_SCORE: Record<StanceValue, number> = { disagree: 1, agree: 0.4, neutral: 0 };

export const EMOTION_SCORE: Record<EmotionValue, number> = {
  angry: 1, urgent: 1, worried: 0.7, happy: 0.2, neutral: 0,
};

export const CERTAINTY_SCORE: Record<CertaintyValue, number> = {
  firm: 1, tentative: 0.5, guess: 0.3, rumour: 0.1,
};

export const CHANGE_SCORE: Record<ChangeValue, number> = {
  contradiction: 1, update: 0.9, new: 0.7, repeat: 0.2,
};

export const RISK_SCORE: Record<RiskValue, number> = { high: 1, medium: 0.5, low: 0.1 };

/** Weights per context kind, 0 = ignore, 5 = matters most (spec v1, frozen). */
export const DEFAULT_WEIGHTS: WeightsTable = {
  order:            { type: 3, intent: 5, stance: 2, emotion: 1, specifics: 5, change: 4, risk: 4, trust: 1 },
  payment:          { type: 3, intent: 5, stance: 2, emotion: 2, specifics: 5, change: 3, risk: 5, trust: 4 },
  rate_negotiation: { type: 3, intent: 4, stance: 5, emotion: 1, specifics: 5, change: 5, risk: 3, trust: 2 },
  purchase:         { type: 3, intent: 5, stance: 2, emotion: 1, specifics: 5, change: 4, risk: 4, trust: 3 },
  dispatch:         { type: 3, intent: 4, stance: 1, emotion: 2, specifics: 5, change: 5, risk: 5, trust: 2 },
  production:       { type: 3, intent: 3, stance: 1, emotion: 2, specifics: 4, change: 4, risk: 5, trust: 1 },
  complaint:        { type: 3, intent: 3, stance: 4, emotion: 5, specifics: 4, change: 3, risk: 5, trust: 4 },
  staff:            { type: 3, intent: 4, stance: 2, emotion: 3, specifics: 4, change: 3, risk: 3, trust: 3 },
  agent_task:       { type: 2, intent: 5, stance: 5, emotion: 1, specifics: 4, change: 4, risk: 5, trust: 0 },
  general_chat:     { type: 2, intent: 2, stance: 2, emotion: 3, specifics: 2, change: 2, risk: 2, trust: 3 },
};

export interface AtomicConfig {
  /** Relevance below this goes to L3. Tune per embedding model. */
  relevanceThreshold: number;
  /** Importance at or above this goes to L1. */
  importanceThreshold: number;
  /** Floor of the certainty multiplier: factor = floor + (1 - floor) * certainty. */
  certaintyFloor: number;
  /** Minimum confidence for a kind to be considered for a statement. */
  kindConfidence: number;
  /** Learning rates. */
  alpha: number;
  beta: number;
  /** Decay per day of link / memory strength (read time only). */
  lambda: number;
  /** Effective strength at or above this lets the agent act and tell. */
  actThreshold: number;
  /** A recalled memory this close to the query counts as an answer; below it recall climbs a level. */
  answerThreshold: number;
  recallCandidates: number;
  recallTop: number;
  recallBudget: number;
  linkCandidates: number;
  /** Minimum summary similarity for a past experience to be linked. */
  linkThreshold: number;
  startStrength: { memory: number; similar: number; same_deal: number; replaces: number; promise_outcome: number };
  /** How far a weight moves on a missed / dismissed signal. */
  weightStep: number;
  /** Intents whose certainty is scaled by the speaker's track record. */
  trackedIntents: IntentValue[];
  /** A reply this short ("OK sir") is judged together with the line it answers. */
  replyWords: number;
  /** Local time zone and festival calendar for date words. */
  dates: DateOptions;
}

export const DEFAULT_CONFIG: AtomicConfig = {
  relevanceThreshold: 0.35,
  importanceThreshold: 0.5,
  certaintyFloor: 0.4,
  kindConfidence: 0.3,
  alpha: 0.2,
  beta: 0.3,
  lambda: 0.01,
  actThreshold: 0.75,
  answerThreshold: 0.5,
  recallCandidates: 20,
  recallTop: 3,
  recallBudget: 12,
  linkCandidates: 10,
  linkThreshold: 0.5,
  startStrength: { memory: 0.5, similar: 0.3, same_deal: 0.5, replaces: 1, promise_outcome: 1 },
  weightStep: 0.25,
  trackedIntents: ['commit'],
  replyWords: 4,
  dates: DEFAULT_DATE_OPTIONS,
};

export function cloneWeights(weights: WeightsTable): WeightsTable {
  return JSON.parse(JSON.stringify(weights)) as WeightsTable;
}
