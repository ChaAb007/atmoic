export type ContextKind = 'user_user' | 'user_agent' | 'agent_agent' | 'agent_task' | 'event';

export type StatementKind =
  | 'order'
  | 'payment'
  | 'rate_negotiation'
  | 'purchase'
  | 'dispatch'
  | 'production'
  | 'complaint'
  | 'staff'
  | 'agent_task'
  | 'general_chat';

export type Level = 'L1' | 'L2' | 'L3';

export type MemoryStatus = 'active' | 'replaced' | 'fulfilled' | 'broken';

export type LinkKind = 'similar' | 'same_deal' | 'replaces' | 'promise_outcome';

export type TypeValue =
  | 'order' | 'payment' | 'rate' | 'delivery' | 'complaint' | 'stock'
  | 'question' | 'opinion' | 'greeting' | 'small_talk' | 'joke';
export type IntentValue =
  | 'commit' | 'decide' | 'cancel' | 'request' | 'assign' | 'negotiate' | 'confirm' | 'none';
export type StanceValue = 'agree' | 'disagree' | 'neutral';
export type EmotionValue = 'angry' | 'urgent' | 'worried' | 'happy' | 'neutral';
export type CertaintyValue = 'firm' | 'tentative' | 'guess' | 'rumour';
export type ChangeValue = 'contradiction' | 'update' | 'new' | 'repeat';
export type RiskValue = 'high' | 'medium' | 'low';

/** Concrete details pulled out of a statement. `date` is an ISO date when the classifier could resolve one. */
export interface Facts {
  qty?: number;
  unit?: string;
  rate?: number;
  amount?: number;
  /** Local business date (YYYY-MM-DD), resolved once against when the words were said. */
  date?: string;
  /** Date range, e.g. "Diwali ke baad" -> dateFrom only. */
  dateFrom?: string;
  dateTo?: string;
  /** The original time words ("kal", "last Wednesday"). */
  datePhrase?: string;
  /** Time words that name no date ("jaldi"); the agent should ask. */
  dateUnresolved?: boolean;
  item?: string;
  place?: string;
}

export interface Angles {
  type: TypeValue;
  intent: IntentValue;
  stance: StanceValue;
  emotion: EmotionValue;
  certainty: CertaintyValue;
  specifics: Facts;
  change: ChangeValue;
  risk: RiskValue;
  trust: boolean;
}

export interface KindGuess {
  kind: StatementKind;
  confidence: number;
}

export interface ClassifierResult {
  angles: Angles;
  kinds: KindGuess[];
  /** Optional per-statement party / deal when one chat touches several deals. */
  partyId?: string;
  dealId?: string;
  /** A completed action this statement reports, e.g. order_created, order_sent, invoice_created. */
  action?: string;
}

export interface ExperienceContext {
  kind: ContextKind;
  partyId?: string;
  dealId?: string;
  channel?: string;
}

/** Raw record. Append-only: never updated after it is stored. */
export interface Experience {
  id: string;
  context: ExperienceContext;
  participants: string[];
  raw: string;
  language?: string;
  occurredAt: string;
  recordedAt: string;
  /** For business events (payment received, goods dispatched). */
  event?: { type: string; facts?: Facts };
}

export interface Statement {
  id: string;
  experienceId: string;
  speaker?: string;
  position: number;
  text: string;
  vector: number[];
}

export interface Scores {
  statementId: string;
  relevance: number;
  angles?: Angles;
  kind?: StatementKind;
  content?: number;
  certainty?: number;
  importance?: number;
  override?: boolean;
}

export interface Memory {
  id: string;
  level: Level;
  statementId: string;
  experienceId: string;
  content: string;
  vector: number[];
  facts: Facts;
  kind?: StatementKind;
  intent?: IntentValue;
  /** Angles that scored above zero; used when a user says a memory was missed or was noise. */
  firedAngles?: AngleName[];
  speaker?: string;
  /** Everyone in the experience; used for "did Amit do it" and for access. */
  participants: string[];
  /** Completed action reported by this statement, or the business event type. */
  action?: string;
  /** For short replies ("OK sir"): the line being answered. */
  replyTo?: string;
  /** When the experience happened. */
  occurredAt: string;
  partyId?: string;
  dealId?: string;
  dueAt?: string;
  certainty: number;
  importance: number;
  status: MemoryStatus;
  replacedBy?: string;
  strength: number;
  lastUsedAt: string;
  lastOutcome?: 'good' | 'bad';
  createdAt: string;
}

export interface Summary {
  experienceId: string;
  text: string;
  vector: number[];
  participants: string[];
  partyId?: string;
  dealId?: string;
  occurredAt: string;
}

export interface Link {
  id: string;
  from: string;
  to: string;
  kind: LinkKind;
  strength: number;
  confirms: number;
  rejects: number;
  lastUsedAt: string;
}

export interface TrackRecord {
  subject: string;
  intent: IntentValue;
  kept: number;
  total: number;
}

export type LearningSignal =
  | 'confirmed'
  | 'good_outcome'
  | 'repeat'
  | 'rejected'
  | 'bad_outcome'
  | 'missed'
  | 'dismissed';

/** A learning change waiting for the tenant's sync window. */
export type LearningEvent =
  | { seq?: number; at: string; target: 'link' | 'memory'; id: string; signal: LearningSignal }
  | { seq?: number; at: string; target: 'track_record'; subject: string; intent: IntentValue; kept: boolean }
  | { seq?: number; at: string; target: 'weights'; kind: StatementKind; angles: AngleName[]; signal: 'missed' | 'dismissed' };

export type AngleName = 'type' | 'intent' | 'stance' | 'emotion' | 'specifics' | 'change' | 'risk' | 'trust';

export type WeightRow = Record<AngleName, number>;
export type WeightsTable = Record<StatementKind, WeightRow>;

/** What a participant is. Set by the owner, never changed by learning. */
export interface Fundamental {
  businessName: string;
  domain: string;
  owner: string;
  /** Actions that always need the owner's approval (e.g. rate_change, discount, credit_terms). */
  approvalRequired: string[];
  /** Parties restricted to advance payment. */
  advanceOnly: string[];
  /** Kinds whose commitments always go to L1 (e.g. payment). */
  criticalKinds: StatementKind[];
  version: number;
}

export interface InputContext {
  kind: ContextKind;
  /** Words describing what this conversation is about; drives relevance. */
  topic: string;
  partyId?: string;
  dealId?: string;
  /** Parties recall may search across; defaults to [partyId]. */
  partyIds?: string[];
  channel?: string;
}

export interface Input {
  id?: string;
  context: InputContext;
  participants: string[];
  /** Participants that are agents, not people. Emotion is read only from people. */
  agents?: string[];
  /** One line per statement, optionally "Speaker: text". */
  raw: string;
  language?: string;
  occurredAt?: string;
  event?: { type: string; facts?: Facts };
}

export type Mode = 'ASK' | 'WARN' | 'ACT_AND_TELL';

export interface Task {
  action: string;
  partyId?: string;
  memoryId?: string;
  linkId?: string;
}

/** Who is asking. The owner sees everything; staff and agents see their own work and their parties; externals see only conversations they were in. */
export interface Viewer {
  id: string;
  role: 'owner' | 'staff' | 'agent' | 'external';
  parties?: string[];
}

/** Names the host knows, so a question like "Sharma ji ka order" can be tied to a party and a person. */
export interface Directory {
  parties?: { id: string; names: string[] }[];
  people?: { id: string; names: string[] }[];
  actions?: { id: string; words: string[] }[];
}

export interface RecallOptions {
  viewer?: Viewer;
  /** Only memories from experiences this person took part in. */
  actor?: string;
  /** Only memories reporting this completed action. */
  action?: string;
  /** Local date range (YYYY-MM-DD). */
  from?: string;
  to?: string;
  /** Read party, person, action and dates from the question text (default true). */
  fromQuestion?: boolean;
}
