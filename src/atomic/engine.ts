import { randomUUID } from 'node:crypto';
import { ANGLES, DEFAULT_CONFIG, DEFAULT_WEIGHTS } from './config.ts';
import type { AtomicConfig } from './config.ts';
import { defaultOutcomeMatcher, extractiveSummarizer, lineSplitter } from './defaults.ts';
import { applyLearning, effectiveStrength } from './learning.ts';
import type { SyncResult } from './learning.ts';
import type { Clock, Models, StorageAdapter } from './ports.ts';
import {
  angleScore,
  certaintyFactor,
  chooseKind,
  isOverride,
  levelFor,
  reliability,
  wordingCertainty,
} from './scoring.ts';
import type {
  AngleName,
  Angles,
  ChangeValue,
  Experience,
  Facts,
  Fundamental,
  Input,
  InputContext,
  LearningSignal,
  Level,
  Link,
  LinkKind,
  Memory,
  Mode,
  Task,
} from './types.ts';
import { cosine } from './vector.ts';

const DAY_MS = 86_400_000;
const COMPARED_FACTS: (keyof Facts)[] = ['qty', 'rate', 'amount', 'date'];
const CREDIT_ACTIONS = ['credit_terms', 'dispatch_on_credit', 'accept_order_on_credit'];

function freezeFundamental(fundamental: Fundamental): Fundamental {
  return Object.freeze({
    ...fundamental,
    approvalRequired: Object.freeze([...fundamental.approvalRequired]) as string[],
    advanceOnly: Object.freeze([...fundamental.advanceOnly]) as string[],
    criticalKinds: Object.freeze([...fundamental.criticalKinds]) as Fundamental['criticalKinds'],
  });
}

export interface RecalledExperience {
  experienceId: string;
  summary: string;
  score: number;
}

export interface RecallResult {
  experiences: RecalledExperience[];
  memories: Memory[];
  /** Highest level recall had to climb to. */
  climbedTo: Level;
}

export interface StatementTrace {
  text: string;
  speaker?: string;
  relevance: number;
  level: Level;
  kind?: string;
  content?: number;
  certainty?: number;
  importance?: number;
  override?: boolean;
  change?: ChangeValue;
  memoryId: string;
  replaced?: string[];
}

export interface ProcessResult {
  experienceId: string;
  statements: StatementTrace[];
  summary: string;
  links: Link[];
}

export interface Decision {
  mode: Mode;
  reason: string;
}

export interface DueCheckResult {
  fulfilled: string[];
  broken: string[];
}

export interface EngineOptions {
  tenantId: string;
  storage: StorageAdapter;
  models: Models;
  fundamental: Fundamental;
  config?: Partial<AtomicConfig>;
  clock?: Clock;
}

/** One client's memory. Every client gets its own engine and its own storage. */
export class AtomicEngine {
  readonly tenantId: string;
  readonly config: AtomicConfig;
  private readonly storage: StorageAdapter;
  private readonly models: Required<Models>;
  private readonly clock: Clock;
  private fundamentalValue: Fundamental;
  private queue: Promise<void> = Promise.resolve();
  private readonly processed: ProcessResult[] = [];
  readonly errors: Error[] = [];

  constructor(options: EngineOptions) {
    this.tenantId = options.tenantId;
    this.storage = options.storage;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.clock = options.clock ?? { now: () => new Date() };
    this.models = {
      splitter: lineSplitter,
      summarizer: extractiveSummarizer,
      outcomeMatcher: defaultOutcomeMatcher,
      ...options.models,
    } as Required<Models>;
    this.fundamentalValue = freezeFundamental(options.fundamental);
  }

  get fundamental(): Fundamental {
    return this.fundamentalValue;
  }

  /** Only the owner changes Fundamental; learning never does. */
  setFundamental(next: Omit<Fundamental, 'version'>, changedBy: string): Fundamental {
    if (changedBy !== this.fundamentalValue.owner) {
      throw new Error(`only ${this.fundamentalValue.owner} can change Fundamental`);
    }
    this.fundamentalValue = freezeFundamental({ ...next, version: this.fundamentalValue.version + 1 });
    return this.fundamentalValue;
  }

  /** Fast path: recall while the user waits, then queue the layers in the background. */
  async onInput(input: Input): Promise<{ experienceId: string; recall: RecallResult }> {
    const experienceId = input.id ?? randomUUID();
    const recall = await this.recall(input.context, input.raw);
    this.queue = this.queue
      .then(async () => { this.processed.push(await this.process({ ...input, id: experienceId }, recall.memories)); })
      .catch((error: unknown) => { this.errors.push(error instanceof Error ? error : new Error(String(error))); });
    return { experienceId, recall };
  }

  /** Waits for queued background processing; returns what was processed since the last drain. */
  async drain(): Promise<ProcessResult[]> {
    await this.queue;
    return this.processed.splice(0);
  }

  /** Step A. L4 summaries first, then climb L1 -> L2 -> L3 until an answer-close memory is found. Read-only. */
  async recall(context: InputContext, text = ''): Promise<RecallResult> {
    const now = this.clock.now();
    const query = await this.models.embedder.embed(`${context.topic}\n${text}`);
    const partyIds = context.partyIds ?? (context.partyId ? [context.partyId] : undefined);
    const hits = await this.storage.searchSummaries(query, this.config.recallCandidates, { partyIds });
    const scored: RecalledExperience[] = [];
    for (const hit of hits) {
      const links = await this.storage.linksTouching(hit.summary.experienceId);
      const strongest = links.length
        ? Math.max(...links.map((link) => effectiveStrength(link.strength, link.lastUsedAt, now, this.config)))
        : this.config.startStrength.memory;
      const days = Math.max(0, (now.getTime() - Date.parse(hit.summary.occurredAt)) / DAY_MS);
      const recency = 1 / (1 + days / 30);
      scored.push({
        experienceId: hit.summary.experienceId,
        summary: hit.summary.text,
        score: hit.similarity * (0.5 + 0.5 * strongest) * recency,
      });
    }
    const top = scored.sort((left, right) => right.score - left.score).slice(0, this.config.recallTop);
    const experienceIds = top.map((item) => item.experienceId);
    const memories: Memory[] = [];
    let climbedTo: Level = 'L1';
    if (experienceIds.length) {
      for (const level of ['L1', 'L2', 'L3'] as Level[]) {
        climbedTo = level;
        const found = await this.storage.findMemories({ level, status: 'active', experienceIds });
        found.sort((left, right) => cosine(right.vector, query) - cosine(left.vector, query));
        memories.push(...found);
        if (memories.some((memory) => cosine(memory.vector, query) >= this.config.answerThreshold)) break;
      }
    }
    return { experiences: top, memories: memories.slice(0, this.config.recallBudget), climbedTo };
  }

  /** Steps 0-3, L4 and B. */
  async process(input: Input, recalled: Memory[] = []): Promise<ProcessResult> {
    const now = this.clock.now().toISOString();
    const context = input.context;
    const experience: Experience = {
      id: input.id ?? randomUUID(),
      context: { kind: context.kind, partyId: context.partyId, dealId: context.dealId, channel: context.channel },
      participants: [...input.participants],
      raw: input.raw,
      language: input.language,
      occurredAt: input.occurredAt ?? now,
      recordedAt: now,
      event: input.event,
    };
    await this.storage.appendExperience(experience);

    const pieces = await this.models.splitter.split(input.raw);
    const nearby = pieces.map((piece) => piece.text);
    const contextVector = await this.models.embedder.embed(context.topic);
    const weights = (await this.storage.getWeights()) ?? DEFAULT_WEIGHTS;
    const traces: StatementTrace[] = [];
    const kept: { text: string; level: Level }[] = [];

    for (const [position, piece] of pieces.entries()) {
      const speaker = piece.speaker && input.participants.includes(piece.speaker) ? piece.speaker : undefined;
      const text = speaker ? piece.text : (piece.speaker ? `${piece.speaker}: ${piece.text}` : piece.text);
      const vector = await this.models.embedder.embed(text);
      const statementId = randomUUID();
      await this.storage.putStatement({ id: statementId, experienceId: experience.id, speaker, position, text, vector });
      const relevance = cosine(vector, contextVector);
      const base = {
        id: randomUUID(), statementId, experienceId: experience.id, content: text, vector, speaker,
        status: 'active' as const, strength: this.config.startStrength.memory, lastUsedAt: now, createdAt: now,
      };

      if (relevance < this.config.relevanceThreshold) {
        await this.storage.putMemory({
          ...base, level: 'L3', facts: {}, partyId: context.partyId, dealId: context.dealId, certainty: 1, importance: 0,
        });
        traces.push({ text, speaker, relevance, level: 'L3', memoryId: base.id });
        kept.push({ text, level: 'L3' });
        continue;
      }

      const result = await this.models.classifier.classify({ text, nearby, context, recalled });
      const partyId = result.partyId ?? context.partyId;
      const dealId = result.dealId ?? context.dealId;
      const angles: Angles = { ...result.angles, specifics: { ...result.angles.specifics } };
      const match = await this.compareWithMemory(angles.specifics, partyId, dealId);
      if (match.change && angles.change !== 'contradiction') angles.change = match.change;

      const choice = chooseKind(angles, result.kinds, weights, this.config);
      let certainty = wordingCertainty(angles);
      const subject = partyId ?? speaker;
      if (subject && this.config.trackedIntents.includes(angles.intent)) {
        certainty *= reliability(await this.storage.getTrackRecord(subject, angles.intent));
      }
      const importance = choice.content * certaintyFactor(certainty, this.config);
      const override = isOverride(angles, choice.kind, this.fundamentalValue);
      const level = levelFor(relevance, importance, override, this.config);
      const firedAngles = ANGLES.filter((angle: AngleName) => angleScore(angles, angle) > 0);

      const memory: Memory = {
        ...base,
        level,
        facts: angles.specifics,
        kind: choice.kind,
        intent: angles.intent,
        firedAngles,
        partyId,
        dealId,
        dueAt: angles.intent === 'commit' ? angles.specifics.date : undefined,
        certainty,
        importance,
      };
      await this.storage.putMemory(memory);

      const replaced = level === 'L1' ? await this.replaceOlder(memory) : [];
      if (angles.change === 'repeat') {
        for (const id of match.sameIds) await this.queueLearning('memory', id, 'repeat');
      }
      traces.push({
        text, speaker, relevance, level, kind: choice.kind, content: choice.content, certainty, importance,
        override, change: angles.change, memoryId: memory.id, replaced,
      });
      kept.push({ text, level });
    }

    const summaryText = await this.models.summarizer.summarize(experience, kept);
    const summaryVector = await this.models.embedder.embed(summaryText);
    const links = await this.linkExperience(experience, summaryVector, now);
    await this.storage.putSummary({
      experienceId: experience.id, text: summaryText, vector: summaryVector,
      partyId: context.partyId, dealId: context.dealId, occurredAt: experience.occurredAt,
    });
    return { experienceId: experience.id, statements: traces, summary: summaryText, links };
  }

  /** Same party + deal with a shared fact: equal values = repeat, different values = update. */
  private async compareWithMemory(facts: Facts, partyId?: string, dealId?: string) {
    const result: { change?: ChangeValue; sameIds: string[] } = { sameIds: [] };
    if (!partyId || !dealId) return result;
    const active = await this.storage.findMemories({ level: 'L1', status: 'active', partyId, dealId });
    for (const memory of active) {
      if (facts.item && memory.facts.item && facts.item !== memory.facts.item) continue;
      const shared = COMPARED_FACTS.filter((key) => facts[key] !== undefined && memory.facts[key] !== undefined);
      if (!shared.length) continue;
      if (shared.some((key) => facts[key] !== memory.facts[key])) result.change = 'update';
      else {
        result.sameIds.push(memory.id);
        result.change ??= 'repeat';
      }
    }
    return result;
  }

  /** Decision #1: same party + deal and a changed fact -> new replaces old; old is kept and linked. */
  private async replaceOlder(memory: Memory): Promise<string[]> {
    if (!memory.partyId || !memory.dealId) return [];
    const active = await this.storage.findMemories({
      level: 'L1', status: 'active', partyId: memory.partyId, dealId: memory.dealId,
    });
    const replaced: string[] = [];
    for (const old of active) {
      if (old.id === memory.id) continue;
      if (memory.facts.item && old.facts.item && memory.facts.item !== old.facts.item) continue;
      const shared = COMPARED_FACTS.filter((key) => memory.facts[key] !== undefined && old.facts[key] !== undefined);
      if (!shared.length || shared.every((key) => memory.facts[key] === old.facts[key])) continue;
      await this.storage.updateMemory(old.id, { status: 'replaced', replacedBy: memory.id });
      await this.putLink(memory.id, old.id, 'replaces', this.config.startStrength.replaces, memory.createdAt);
      replaced.push(old.id);
    }
    return replaced;
  }

  /** Step B. Link the new experience to close past experiences; nothing old is rewritten. */
  private async linkExperience(experience: Experience, vector: number[], now: string): Promise<Link[]> {
    const hits = await this.storage.searchSummaries(vector, this.config.linkCandidates, { excludeIds: [experience.id] });
    const links: Link[] = [];
    for (const hit of hits) {
      if (hit.similarity < this.config.linkThreshold) continue;
      const past = hit.summary;
      const sameDeal = Boolean(experience.context.dealId)
        && past.dealId === experience.context.dealId
        && past.partyId === experience.context.partyId;
      const kind: LinkKind = sameDeal ? 'same_deal' : 'similar';
      links.push(await this.putLink(experience.id, past.experienceId, kind, this.config.startStrength[kind], now));
    }
    return links;
  }

  private async putLink(from: string, to: string, kind: LinkKind, strength: number, at: string): Promise<Link> {
    const existing = await this.storage.getLink(from, to, kind);
    if (existing) return existing;
    const link: Link = { id: randomUUID(), from, to, kind, strength, confirms: 0, rejects: 0, lastUsedAt: at };
    await this.storage.putLink(link);
    return link;
  }

  /** User feedback and outcomes. Strength changes wait for the sync window. */
  async feedback(target: 'link' | 'memory', id: string, signal: LearningSignal): Promise<void> {
    await this.queueLearning(target, id, signal);
  }

  /** The outcome itself is a fact and lands now; the strength change waits for sync. */
  async recordOutcome(memoryId: string, good: boolean): Promise<void> {
    await this.storage.updateMemory(memoryId, { lastOutcome: good ? 'good' : 'bad' });
    await this.queueLearning('memory', memoryId, good ? 'good_outcome' : 'bad_outcome');
  }

  /** The user had to repeat something stored below L1: promote it now, raise its angles' weights at sync. */
  async reportMissed(memoryId: string): Promise<void> {
    const memory = await this.storage.getMemory(memoryId);
    if (!memory) throw new Error(`memory ${memoryId} not found`);
    await this.storage.updateMemory(memoryId, { level: 'L1' });
    if (memory.kind && memory.firedAngles?.length) {
      await this.storage.appendLearning({
        at: this.clock.now().toISOString(), target: 'weights', kind: memory.kind, angles: memory.firedAngles, signal: 'missed',
      });
    }
  }

  /** The user dismissed an L1 memory as noise: demote it now, lower its angles' weights at sync. */
  async dismiss(memoryId: string): Promise<void> {
    const memory = await this.storage.getMemory(memoryId);
    if (!memory) throw new Error(`memory ${memoryId} not found`);
    await this.storage.updateMemory(memoryId, { level: 'L2' });
    if (memory.kind && memory.firedAngles?.length) {
      await this.storage.appendLearning({
        at: this.clock.now().toISOString(), target: 'weights', kind: memory.kind, angles: memory.firedAngles, signal: 'dismissed',
      });
    }
  }

  private async queueLearning(target: 'link' | 'memory', id: string, signal: LearningSignal): Promise<void> {
    await this.storage.appendLearning({ at: this.clock.now().toISOString(), target, id, signal });
  }

  /** Decision #4: Fundamental first, then last outcome, then strength. */
  async askOrAct(task: Task): Promise<Decision> {
    const fundamental = this.fundamentalValue;
    if (task.partyId && fundamental.advanceOnly.includes(task.partyId) && CREDIT_ACTIONS.includes(task.action)) {
      return { mode: 'WARN', reason: `${task.partyId} is advance-only` };
    }
    if (fundamental.approvalRequired.includes(task.action)) {
      return { mode: 'ASK', reason: `${task.action} needs ${fundamental.owner}'s approval` };
    }
    const now = this.clock.now();
    if (task.memoryId) {
      const memory = await this.storage.getMemory(task.memoryId);
      if (!memory) return { mode: 'ASK', reason: 'no memory of doing this before' };
      if (memory.lastOutcome === 'bad') return { mode: 'WARN', reason: 'this failed last time' };
      const strength = effectiveStrength(memory.strength, memory.lastUsedAt, now, this.config);
      if (strength >= this.config.actThreshold) return { mode: 'ACT_AND_TELL', reason: `strength ${strength.toFixed(2)}` };
      return { mode: 'ASK', reason: `strength ${strength.toFixed(2)} is below ${this.config.actThreshold}` };
    }
    if (task.linkId) {
      const link = await this.storage.getLinkById(task.linkId);
      if (!link) return { mode: 'ASK', reason: 'no link' };
      const strength = effectiveStrength(link.strength, link.lastUsedAt, now, this.config);
      if (strength >= this.config.actThreshold) return { mode: 'ACT_AND_TELL', reason: `strength ${strength.toFixed(2)}` };
      return { mode: 'ASK', reason: `strength ${strength.toFixed(2)} is below ${this.config.actThreshold}` };
    }
    return { mode: 'ASK', reason: 'no memory of doing this before' };
  }

  /** Daily: promises whose date has passed are matched with business events and learned from. */
  async dueCheck(): Promise<DueCheckResult> {
    const now = this.clock.now();
    const result: DueCheckResult = { fulfilled: [], broken: [] };
    const open = await this.storage.findMemories({ level: 'L1', status: 'active' });
    for (const memory of open) {
      if (!memory.dueAt) continue;
      const dueEnd = Date.parse(memory.dueAt) + (memory.dueAt.length === 10 ? DAY_MS : 0);
      if (Number.isNaN(dueEnd) || now.getTime() < dueEnd) continue;
      const events = await this.storage.listExperiences({ partyId: memory.partyId });
      const outcome = this.models.outcomeMatcher.match(memory, events);
      const kept = Boolean(outcome && Date.parse(outcome.occurredAt) < dueEnd);
      await this.storage.updateMemory(memory.id, {
        status: kept ? 'fulfilled' : 'broken',
        lastOutcome: kept ? 'good' : 'bad',
      });
      if (outcome) await this.putLink(memory.id, outcome.id, 'promise_outcome', this.config.startStrength.promise_outcome, now.toISOString());
      const subject = memory.partyId ?? memory.speaker;
      if (subject && memory.intent) {
        await this.storage.appendLearning({ at: now.toISOString(), target: 'track_record', subject, intent: memory.intent, kept });
      }
      await this.queueLearning('memory', memory.id, kept ? 'good_outcome' : 'bad_outcome');
      (kept ? result.fulfilled : result.broken).push(memory.id);
    }
    return result;
  }

  /** Applies buffered learning. The host calls this only inside the client's sync window. */
  async sync(limit = Number.POSITIVE_INFINITY): Promise<SyncResult> {
    const events = await this.storage.takeLearning(limit);
    return applyLearning(this.storage, events, this.config);
  }

  async pendingLearning(): Promise<number> {
    return this.storage.pendingLearning();
  }
}
