import type {
  ClassifierResult,
  Experience,
  InputContext,
  IntentValue,
  LearningEvent,
  Level,
  Link,
  LinkKind,
  Memory,
  MemoryStatus,
  Statement,
  StatementKind,
  Summary,
  TrackRecord,
  WeightsTable,
} from './types.ts';

export interface MemoryFilter {
  level?: Level;
  levels?: Level[];
  status?: MemoryStatus;
  partyId?: string;
  dealId?: string;
  experienceIds?: string[];
  dueBefore?: string;
}

export interface ExperienceFilter {
  partyId?: string;
  dealId?: string;
  eventType?: string;
  from?: string;
  to?: string;
}

export interface SummaryHit {
  summary: Summary;
  similarity: number;
}

/**
 * Storage contract. The host application Atomic is installed in supplies the implementation
 * (its own database, one per client). Atomic never assumes a particular database.
 */
export interface StorageAdapter {
  appendExperience(experience: Experience): Promise<void>;
  getExperience(id: string): Promise<Experience | undefined>;
  listExperiences(filter: ExperienceFilter): Promise<Experience[]>;

  putStatement(statement: Statement): Promise<void>;

  putMemory(memory: Memory): Promise<void>;
  updateMemory(id: string, patch: Partial<Memory>): Promise<void>;
  getMemory(id: string): Promise<Memory | undefined>;
  findMemories(filter: MemoryFilter): Promise<Memory[]>;

  putSummary(summary: Summary): Promise<void>;
  getSummary(experienceId: string): Promise<Summary | undefined>;
  /** Nearest summaries by vector. `partyIds` empty or absent = whole tenant. */
  searchSummaries(vector: number[], k: number, filter?: { partyIds?: string[]; excludeIds?: string[] }): Promise<SummaryHit[]>;

  getLink(from: string, to: string, kind: LinkKind): Promise<Link | undefined>;
  getLinkById(id: string): Promise<Link | undefined>;
  putLink(link: Link): Promise<void>;
  linksTouching(id: string): Promise<Link[]>;

  getTrackRecord(subject: string, intent: IntentValue): Promise<TrackRecord | undefined>;
  putTrackRecord(record: TrackRecord): Promise<void>;

  getWeights(): Promise<WeightsTable | undefined>;
  putWeights(weights: WeightsTable): Promise<void>;

  /** Learning waits here until the tenant's sync window. */
  appendLearning(event: LearningEvent): Promise<void>;
  takeLearning(limit: number): Promise<LearningEvent[]>;
  pendingLearning(): Promise<number>;
}

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export interface Classifier {
  classify(input: { text: string; nearby: string[]; context: InputContext; recalled: Memory[] }): Promise<ClassifierResult>;
}

export interface SplitStatement {
  speaker?: string;
  text: string;
}

export interface Splitter {
  split(raw: string): Promise<SplitStatement[]>;
}

export interface Summarizer {
  summarize(experience: Experience, kept: { text: string; level: Level }[]): Promise<string>;
}

/** Decides whether a business event fulfils a time-bound memory. */
export interface OutcomeMatcher {
  match(memory: Memory, events: Experience[]): Experience | undefined;
}

export interface Clock {
  now(): Date;
}

export interface Models {
  embedder: Embedder;
  classifier: Classifier;
  splitter?: Splitter;
  summarizer?: Summarizer;
  outcomeMatcher?: OutcomeMatcher;
}
