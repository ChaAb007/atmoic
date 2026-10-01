import { randomUUID } from 'node:crypto';
import { ANGLES, DEFAULT_CONFIG, DEFAULT_WEIGHTS } from './config.ts';
import type { AtomicConfig } from './config.ts';
import { defaultOutcomeMatcher, extractiveSummarizer, lineSplitter } from './defaults.ts';
import { localDayRange, resolveDate } from './dates.ts';
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
  Directory,
  Fundamental,
  Input,
  InputContext,
  LearningSignal,
  Level,
  Link,
  LinkKind,
  Memory,
  Mode,
  RecallOptions,
  Task,
  Viewer,
} from './types.ts';
import { cosine } from './vector.ts';

const DAY_MS = 86_400_000;
const COMPARED_FACTS: (keyof Facts)[] = ['qty', 'rate', 'amount', 'date'];
const CREDIT_ACTIONS = ['credit_terms', 'dispatch_on_credit', 'accept_order_on_credit'];

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

export interface RecallScope {
  partyIds?: string[];
  actor?: string;
  action?: string;
  /** Local dates, YYYY-MM-DD. */
  from?: string;
  to?: string;
}

export interface Ambiguity {
  kind: 'party' | 'person';
  ids: string[];
}

export interface RecallResult {
  experiences: RecalledExperience[];
  memories: Memory[];
  /** Highest level recall had to climb to. */
  climbedTo: Level;
  /** False means an explicit "nothing found" for this scope. */
  found: boolean;
  /** The limits recall applied, including those read from the question. */
  scope: RecallScope;
  /** When nothing matched the dates: the latest matching experience outside them. */
  nearest?: Memory[];
  /** A name matched more than one party or person: ask which one. */
  ambiguous?: Ambiguity[];
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
  action?: string;
  replyTo?: string;
  facts?: Facts;
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
  /** Names of parties, people and actions, so questions can be scoped. */
  directory?: Directory;
}

/** One client's memory. Every client gets its own engine and its own storage. */
export class AtomicEngine {
  readonly tenantId: string;
  readonly config: AtomicConfig;
  private readonly storage: StorageAdapter;
  private readonly models: Required<Models>;
  private readonly clock: Clock;
  private fundamentalValue: Fundamental;
  private directory: Directory;
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
    this.directory = options.directory ?? {};
  }

  setDirectory(directory: Directory): void {
    this.directory = directory;
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
    const recall = await this.recall(input.context, input.raw, { fromQuestion: false });
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

  /**
   * Step A. With scope limits (person, action, dates) recall returns every matching memory, or an explicit
   * "not found" plus the nearest match outside the dates. Without limits it reads L4 summaries first and climbs
   * L1 -> L2 -> L3 until an answer-close memory is found. Read-only, and filtered by what the viewer may see.
   */
  async recall(context: InputContext, text = '', options: RecallOptions = {}): Promise<RecallResult> {
    const now = this.clock.now();
    const scope = this.scopeOf(context, text, options, now);
    if (scope.ambiguous.length) {
      return { experiences: [], memories: [], climbedTo: 'L1', found: false, scope: scope.limits, ambiguous: scope.ambiguous };
    }
    const { partyIds, actor, action, from, to } = scope.limits;
    const visible = (memory: Memory) => this.visibleTo(options.viewer, memory.participants, memory.partyId);

    if (actor || action || from || to) {
      const window = from || to
        ? localDayRange(from ?? '1970-01-01', to ?? '9999-12-31', this.config.dates.utcOffsetMinutes)
        : undefined;
      const base = { partyIds, participant: actor, status: 'active' as const, levels: ['L1', 'L2'] as Level[] };
      const matched = (await this.storage.findMemories({
        ...base, action, occurredFrom: window?.fromIso, occurredTo: window?.toIso,
      })).filter(visible);
      let memories = matched;
      if (action && matched.length) {
        const experienceIds = [...new Set(matched.map((memory) => memory.experienceId))];
        memories = (await this.storage.findMemories({ status: 'active', levels: ['L1', 'L2'], experienceIds })).filter(visible);
      }
      memories.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || left.level.localeCompare(right.level));
      const result: RecallResult = {
        experiences: [], memories: memories.slice(0, this.config.recallBudget), climbedTo: 'L2',
        found: memories.length > 0, scope: scope.limits,
      };
      if (!result.found && window) {
        const outside = (await this.storage.findMemories({ ...base, action })).filter(visible);
        outside.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
        const latest = outside[0];
        if (latest) result.nearest = outside.filter((memory) => memory.experienceId === latest.experienceId);
      }
      return result;
    }

    const query = await this.models.embedder.embed(`${context.topic}\n${text}`);
    const hits = await this.storage.searchSummaries(query, this.config.recallCandidates, { partyIds });
    const scored: RecalledExperience[] = [];
    for (const hit of hits) {
      if (!this.visibleTo(options.viewer, hit.summary.participants, hit.summary.partyId)) continue;
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
        const found = (await this.storage.findMemories({ level, status: 'active', experienceIds })).filter(visible);
        found.sort((left, right) => cosine(right.vector, query) - cosine(left.vector, query));
        memories.push(...found);
        if (memories.some((memory) => cosine(memory.vector, query) >= this.config.answerThreshold)) break;
      }
    }
    const kept = memories.slice(0, this.config.recallBudget);
    return { experiences: top, memories: kept, climbedTo, found: kept.length > 0, scope: scope.limits };
  }

  /** Decision #6: the owner sees everything; staff and agents their own work and parties; externals their own chats. */
  private visibleTo(viewer: Viewer | undefined, participants: string[], partyId?: string): boolean {
    if (!viewer || viewer.role === 'owner' || viewer.id === this.fundamentalValue.owner) return true;
    if (participants.includes(viewer.id)) return true;
    if (viewer.role === 'external') return false;
    return Boolean(partyId && viewer.parties?.includes(partyId));
  }

  /** What the question limits: party, person, completed action and dates ("today", "last Wednesday"). */
  private scopeOf(context: InputContext, text: string, options: RecallOptions, now: Date) {
    const limits: RecallScope = {
      partyIds: context.partyIds ?? (context.partyId ? [context.partyId] : undefined),
      actor: options.actor,
      action: options.action,
      from: options.from,
      to: options.to,
    };
    const ambiguous: Ambiguity[] = [];
    if (options.fromQuestion === false || !text) return { limits, ambiguous };
    const lower = ` ${text.toLowerCase()} `;
    /** Length of the longest name mentioned; the most specific mention wins ("Sharma Traders" over "Sharma"). */
    const longest = (names: string[]) => Math.max(0, ...names
      .filter((name) => new RegExp(`\\b${escapeRegExp(name.toLowerCase())}\\b`).test(lower))
      .map((name) => name.length));
    const pick = (entries: { id: string; names: string[] }[]) => {
      const scored = entries.map((entry) => ({ id: entry.id, length: longest(entry.names) })).filter((entry) => entry.length > 0);
      const best = Math.max(0, ...scored.map((entry) => entry.length));
      return scored.filter((entry) => entry.length === best).map((entry) => entry.id);
    };
    const directory = this.directory;
    if (!limits.partyIds && directory.parties) {
      const ids = pick(directory.parties);
      if (ids.length > 1) ambiguous.push({ kind: 'party', ids });
      else if (ids.length === 1) limits.partyIds = ids;
    }
    if (!limits.actor && directory.people) {
      const ids = pick(directory.people);
      if (ids.length > 1) ambiguous.push({ kind: 'person', ids });
      else if (ids.length === 1) limits.actor = ids[0];
    }
    if (!limits.action && directory.actions) {
      limits.action = pick(directory.actions.map((item) => ({ id: item.id, names: item.words })))[0];
    }
    if (!limits.from && !limits.to) {
      const resolved = resolveDate(text, now, this.config.dates);
      if (resolved?.date) { limits.from = resolved.date; limits.to = resolved.date; }
      else if (resolved?.from || resolved?.to) { limits.from = resolved.from; limits.to = resolved.to; }
    }
    return { limits, ambiguous };
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
    /** Tool results and business events are records of work done: always classified, never filtered out. */
    const isRecord = context.kind === 'agent_task' || context.kind === 'event';
    let previous: { text: string; speaker?: string; facts: Facts } | undefined;

    for (const [position, piece] of pieces.entries()) {
      const speaker = piece.speaker && input.participants.includes(piece.speaker) ? piece.speaker : undefined;
      const text = speaker ? piece.text : (piece.speaker ? `${piece.speaker}: ${piece.text}` : piece.text);
      const vector = await this.models.embedder.embed(text);
      const statementId = randomUUID();
      await this.storage.putStatement({ id: statementId, experienceId: experience.id, speaker, position, text, vector });

      // A short reply ("OK sir", "haan") is judged together with the line it answers.
      const isReply = Boolean(previous && previous.speaker !== speaker && wordCount(text) <= this.config.replyWords);
      const replyTo = isReply ? previous!.text : undefined;
      let relevance = cosine(vector, contextVector);
      if (replyTo) relevance = Math.max(relevance, cosine(await this.models.embedder.embed(`${replyTo}\n${text}`), contextVector));

      const base = {
        id: randomUUID(), statementId, experienceId: experience.id, content: replyTo ? `${text} (re: ${replyTo})` : text,
        vector, speaker, participants: experience.participants, occurredAt: experience.occurredAt, replyTo,
        status: 'active' as const, strength: this.config.startStrength.memory, lastUsedAt: now, createdAt: now,
      };

      if (!isRecord && relevance < this.config.relevanceThreshold) {
        await this.storage.putMemory({
          ...base, level: 'L3', facts: {}, partyId: context.partyId, dealId: context.dealId, certainty: 1, importance: 0,
        });
        traces.push({ text, speaker, relevance, level: 'L3', memoryId: base.id });
        kept.push({ text, level: 'L3' });
        previous = { text, speaker, facts: {} };
        continue;
      }

      const result = await this.models.classifier.classify({
        text, nearby, context, recalled, occurredAt: experience.occurredAt, replyTo,
      });
      const partyId = result.partyId ?? context.partyId;
      const dealId = result.dealId ?? context.dealId;
      const angles: Angles = { ...result.angles, specifics: { ...result.angles.specifics } };
      // Emotion is read only from people: agent replies, tool output and business events carry none.
      const fromAgent = context.kind === 'event'
        || (speaker ? (input.agents ?? []).includes(speaker) : context.kind === 'agent_task' || context.kind === 'agent_agent');
      if (fromAgent) angles.emotion = 'neutral';
      this.resolveDates(angles.specifics, text, experience.occurredAt);
      if (replyTo && previous) angles.specifics = { ...previous.facts, ...angles.specifics };
      const action = result.action ?? (context.kind === 'event' ? input.event?.type : undefined);

      const match = action ? { sameIds: [] as string[] } as { change?: ChangeValue; sameIds: string[] }
        : await this.compareWithMemory(angles.specifics, partyId, dealId);
      if (match.change && angles.change !== 'contradiction') angles.change = match.change;

      const choice = chooseKind(angles, result.kinds, weights, this.config);
      let certainty = wordingCertainty(angles);
      const subject = partyId ?? speaker;
      if (subject && this.config.trackedIntents.includes(angles.intent)) {
        certainty *= reliability(await this.storage.getTrackRecord(subject, angles.intent));
      }
      const importance = choice.content * certaintyFactor(certainty, this.config);
      const override = isOverride(angles, choice.kind, this.fundamentalValue);
      // Completed actions and business events are facts of record: always L1.
      const level: Level = action ? 'L1' : levelFor(relevance, importance, override, this.config);
      const firedAngles = ANGLES.filter((angle: AngleName) => angleScore(angles, angle) > 0);

      const memory: Memory = {
        ...base,
        level,
        facts: angles.specifics,
        kind: choice.kind,
        intent: angles.intent,
        firedAngles,
        action,
        partyId,
        dealId,
        dueAt: angles.intent === 'commit' ? angles.specifics.date ?? angles.specifics.dateTo : undefined,
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
        override: override || Boolean(action), change: angles.change, memoryId: memory.id, replaced, action, replyTo,
        facts: angles.specifics,
      });
      kept.push({ text, level });
      previous = { text, speaker, facts: angles.specifics };
    }

    const summaryText = await this.models.summarizer.summarize(experience, kept);
    const summaryVector = await this.models.embedder.embed(summaryText);
    const links = await this.linkExperience(experience, summaryVector, now);
    await this.storage.putSummary({
      experienceId: experience.id, text: summaryText, vector: summaryVector, participants: experience.participants,
      partyId: context.partyId, dealId: context.dealId, occurredAt: experience.occurredAt,
    });
    return { experienceId: experience.id, statements: traces, summary: summaryText, links };
  }

  /** #0: relative time words become real dates once, against when they were said. The classifier's dates win. */
  private resolveDates(facts: Facts, text: string, occurredAt: string): void {
    if (facts.date || facts.dateFrom || facts.dateTo) return;
    const resolved = resolveDate(text, occurredAt, this.config.dates);
    if (!resolved) return;
    facts.datePhrase = resolved.phrase;
    if (resolved.unresolved) facts.dateUnresolved = true;
    if (resolved.date) facts.date = resolved.date;
    if (resolved.from) facts.dateFrom = resolved.from;
    if (resolved.to) facts.dateTo = resolved.to;
  }

  /** Same party + deal with a shared fact: equal values = repeat, different values = update. */
  private async compareWithMemory(facts: Facts, partyId?: string, dealId?: string) {
    const result: { change?: ChangeValue; sameIds: string[] } = { sameIds: [] };
    if (!partyId || !dealId) return result;
    const active = await this.storage.findMemories({ level: 'L1', status: 'active', partyId, dealId });
    for (const memory of active) {
      if (memory.action) continue;
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
    // Records of what happened (events, completed actions) never replace a statement, and are never replaced.
    if (!memory.partyId || !memory.dealId || memory.action) return [];
    const active = await this.storage.findMemories({
      level: 'L1', status: 'active', partyId: memory.partyId, dealId: memory.dealId,
    });
    const replaced: string[] = [];
    for (const old of active) {
      if (old.id === memory.id || old.action) continue;
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
      // A date-only due date lasts until the end of that local business day.
      const dueEnd = memory.dueAt.length === 10
        ? Date.parse(localDayRange(memory.dueAt, memory.dueAt, this.config.dates.utcOffsetMinutes).toIso) + 1
        : Date.parse(memory.dueAt);
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
