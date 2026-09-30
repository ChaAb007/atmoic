import type { ExperienceFilter, MemoryFilter, StorageAdapter, SummaryHit } from './ports.ts';
import type {
  Experience,
  IntentValue,
  LearningEvent,
  Link,
  LinkKind,
  Memory,
  Statement,
  Summary,
  TrackRecord,
  WeightsTable,
} from './types.ts';
import { cosine } from './vector.ts';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Reference adapter kept in process memory, for tests and local runs.
 * Production storage comes from the host application through `StorageAdapter`.
 */
export class InMemoryStorage implements StorageAdapter {
  private readonly experiences = new Map<string, Experience>();
  private readonly statements = new Map<string, Statement>();
  private readonly memories = new Map<string, Memory>();
  private readonly summaries = new Map<string, Summary>();
  private readonly links = new Map<string, Link>();
  private readonly records = new Map<string, TrackRecord>();
  private weights: WeightsTable | undefined;
  private learning: LearningEvent[] = [];
  private seq = 0;

  async appendExperience(experience: Experience): Promise<void> {
    if (this.experiences.has(experience.id)) throw new Error(`experience ${experience.id} already recorded`);
    this.experiences.set(experience.id, deepFreeze(copy(experience)));
  }

  async getExperience(id: string): Promise<Experience | undefined> {
    return this.experiences.get(id);
  }

  async listExperiences(filter: ExperienceFilter): Promise<Experience[]> {
    return [...this.experiences.values()].filter((experience) =>
      (filter.partyId === undefined || experience.context.partyId === filter.partyId)
      && (filter.dealId === undefined || experience.context.dealId === filter.dealId)
      && (filter.eventType === undefined || experience.event?.type === filter.eventType)
      && (filter.from === undefined || experience.occurredAt >= filter.from)
      && (filter.to === undefined || experience.occurredAt <= filter.to));
  }

  async putStatement(statement: Statement): Promise<void> {
    this.statements.set(statement.id, copy(statement));
  }

  statementCount(): number {
    return this.statements.size;
  }

  async putMemory(memory: Memory): Promise<void> {
    this.memories.set(memory.id, copy(memory));
  }

  async updateMemory(id: string, patch: Partial<Memory>): Promise<void> {
    const current = this.memories.get(id);
    if (!current) throw new Error(`memory ${id} not found`);
    this.memories.set(id, { ...current, ...copy(patch), id });
  }

  async getMemory(id: string): Promise<Memory | undefined> {
    const memory = this.memories.get(id);
    return memory && copy(memory);
  }

  async findMemories(filter: MemoryFilter): Promise<Memory[]> {
    const levels = filter.levels ?? (filter.level ? [filter.level] : undefined);
    const ids = filter.experienceIds && new Set(filter.experienceIds);
    return [...this.memories.values()]
      .filter((memory) =>
        (!levels || levels.includes(memory.level))
        && (filter.status === undefined || memory.status === filter.status)
        && (filter.partyId === undefined || memory.partyId === filter.partyId)
        && (filter.dealId === undefined || memory.dealId === filter.dealId)
        && (!ids || ids.has(memory.experienceId))
        && (filter.dueBefore === undefined || (memory.dueAt !== undefined && memory.dueAt < filter.dueBefore)))
      .map(copy);
  }

  async putSummary(summary: Summary): Promise<void> {
    this.summaries.set(summary.experienceId, copy(summary));
  }

  async getSummary(experienceId: string): Promise<Summary | undefined> {
    const summary = this.summaries.get(experienceId);
    return summary && copy(summary);
  }

  async searchSummaries(
    vector: number[],
    k: number,
    filter: { partyIds?: string[]; excludeIds?: string[] } = {},
  ): Promise<SummaryHit[]> {
    const parties = filter.partyIds?.length ? new Set(filter.partyIds) : undefined;
    const excluded = new Set(filter.excludeIds ?? []);
    return [...this.summaries.values()]
      .filter((summary) => !excluded.has(summary.experienceId))
      .filter((summary) => !parties || (summary.partyId !== undefined && parties.has(summary.partyId)))
      .map((summary) => ({ summary: copy(summary), similarity: cosine(vector, summary.vector) }))
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, k);
  }

  async getLink(from: string, to: string, kind: LinkKind): Promise<Link | undefined> {
    const link = [...this.links.values()].find((item) => item.from === from && item.to === to && item.kind === kind);
    return link && copy(link);
  }

  async getLinkById(id: string): Promise<Link | undefined> {
    const link = this.links.get(id);
    return link && copy(link);
  }

  async putLink(link: Link): Promise<void> {
    this.links.set(link.id, copy(link));
  }

  async linksTouching(id: string): Promise<Link[]> {
    return [...this.links.values()].filter((link) => link.from === id || link.to === id).map(copy);
  }

  allLinks(): Link[] {
    return [...this.links.values()].map(copy);
  }

  async getTrackRecord(subject: string, intent: IntentValue): Promise<TrackRecord | undefined> {
    const record = this.records.get(`${subject}\u0000${intent}`);
    return record && copy(record);
  }

  async putTrackRecord(record: TrackRecord): Promise<void> {
    this.records.set(`${record.subject}\u0000${record.intent}`, copy(record));
  }

  async getWeights(): Promise<WeightsTable | undefined> {
    return this.weights && copy(this.weights);
  }

  async putWeights(weights: WeightsTable): Promise<void> {
    this.weights = copy(weights);
  }

  async appendLearning(event: LearningEvent): Promise<void> {
    this.learning.push({ ...copy(event), seq: ++this.seq });
  }

  async takeLearning(limit: number): Promise<LearningEvent[]> {
    return this.learning.splice(0, limit);
  }

  async pendingLearning(): Promise<number> {
    return this.learning.length;
  }
}
