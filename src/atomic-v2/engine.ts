import { ANCHORS, anchorsFingerprint } from './anchors.ts';
import type { AnchorSet } from './anchors.ts';
import { DEFAULT_V2_CONFIG } from './config.ts';
import type { AtomicV2Config } from './config.ts';
import {
  allocate,
  buildProbes,
  compose,
  memoryChecks,
  pieceImportance,
  probeScore,
  readEmotion,
  referenceProfile,
  splitPieces,
  summarize,
  unitCorrectness,
} from './layers.ts';
import type { AnchorVectors, Probes, ScoredPiece } from './layers.ts';
import { loadExperience, parseMemoryFile, storeExperience } from './store.ts';
import type { MemoryFile, MemoryStore } from './store.ts';
import { SUB_LAYERS } from './types.ts';
import type { Embedder, Experience, ExperienceKind, Level, Profile, RecallItem, RecallResult } from './types.ts';
import { clamp01, cosine, packVector, unpackVector } from './vectors.ts';

const DAY_MS = 86_400_000;

export interface OpenOptions {
  embedder: Embedder;
  store: MemoryStore;
  config?: Partial<AtomicV2Config>;
  now?: () => Date;
  /** Progress while anchors are embedded or old memory is re-embedded for a new embedder. */
  onProgress?(stage: 'anchors' | 'migrate', done: number, total: number): void;
}

export interface ProcessInput {
  ask: string;
  response: string;
  /** When the ask was made; defaults to now. */
  at?: string;
  /** Ids of the memories that were recalled into context for this exchange. */
  recalled?: string[];
}

export interface Stats {
  embedder: string;
  experiences: number;
  byKind: Record<ExperienceKind, number>;
  oldest?: string;
  newest?: string;
}

/**
 * Atomic v2 memory for one person on one device. The only things it keeps are experiences
 * (ask + response units after the four layers); there is no chat session.
 */
export class AtomicV2 {
  readonly config: AtomicV2Config;
  private readonly embedder: Embedder;
  private readonly store: MemoryStore;
  private readonly now: () => Date;
  private probes!: Probes;
  private anchorCache: MemoryFile['anchors'];
  private experiences: Experience[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(options: OpenOptions) {
    this.embedder = options.embedder;
    this.store = options.store;
    this.config = { ...DEFAULT_V2_CONFIG, ...options.config, weights: { ...DEFAULT_V2_CONFIG.weights, ...options.config?.weights } };
    this.now = options.now ?? (() => new Date());
  }

  static async open(options: OpenOptions): Promise<AtomicV2> {
    const atomic = new AtomicV2(options);
    const file = parseMemoryFile(await options.store.load());
    await atomic.loadAnchors(file, options.onProgress);
    if (file && file.embedder === options.embedder.id) {
      atomic.experiences = file.experiences.map(loadExperience);
    } else if (file?.experiences.length) {
      await atomic.migrate(file, options.onProgress);
    }
    await atomic.save();
    return atomic;
  }

  get size(): number {
    return this.experiences.length;
  }

  /** Newest first. */
  list(limit = 50): Experience[] {
    return this.experiences.slice(-limit).reverse();
  }

  get(id: string): Experience | undefined {
    return this.experiences.find((experience) => experience.id === id);
  }

  stats(): Stats {
    const byKind: Record<ExperienceKind, number> = { work: 0, growth: 0, emotional: 0, casual: 0 };
    for (const experience of this.experiences) byKind[experience.kind]++;
    return {
      embedder: this.embedder.id,
      experiences: this.experiences.length,
      byKind,
      oldest: this.experiences[0]?.at,
      newest: this.experiences.at(-1)?.at,
    };
  }

  /**
   * What memory brings to a new ask. Read-only: recalling something never strengthens it.
   * Only experiences that match the ask come back; nothing is included just because it was recent.
   */
  async recall(ask: string, options: { limit?: number; minSimilarity?: number } = {}): Promise<RecallResult> {
    const [query] = await this.embedder.embed([ask]);
    const now = this.now().getTime();
    const minimum = options.minSimilarity ?? this.config.recallMinSimilarity;
    const items: RecallItem[] = [];
    for (const experience of this.experiences) {
      const candidates: [RecallItem['matched'], number][] = [
        ['combined', cosine(query, experience.combined)],
        ['unit', cosine(query, experience.unitVector)],
        // A new question often mirrors an old one ("who is Arjun?" after "hiring Arjun as ..."), so the old ask
        // alone is compared too; the full exchange would dilute it.
        ['ask', cosine(query, experience.askVector)],
        ...(['L1', 'L2', 'L3', 'L4'] as const)
          .filter((level) => experience.levelVectors[level])
          .map((level): [Level, number] => [level, cosine(query, experience.levelVectors[level])]),
      ];
      const [matched, similarity] = candidates.reduce((best, entry) => (entry[1] > best[1] ? entry : best));
      if (similarity < minimum) continue;
      const days = Math.max(0, (now - Date.parse(experience.at)) / DAY_MS);
      const score = similarity
        * (0.6 + 0.4 * experience.importance)
        * (0.6 + 0.4 * this.effectiveStrength(experience))
        * (0.75 + 0.25 * Math.exp(-days / 30));
      items.push({ experience, score, similarity, matched });
    }
    items.sort((left, right) => right.score - left.score);
    return { query, items: items.slice(0, options.limit ?? this.config.recallLimit) };
  }

  /** Push one ask + response through the four layers and keep the experience. */
  process(input: ProcessInput): Promise<Experience> {
    return this.serial(async () => {
      // An exchange dated in the past (imported history) is judged only against what came before it.
      const at = Date.parse(input.at ?? this.now().toISOString());
      const past = this.experiences.filter((experience) => Date.parse(experience.at) <= at);
      const experience = await this.build(input, crypto.randomUUID(), past);
      this.reactToEarlier(experience);
      // Keep time order, so "newest first" and follow-up windows hold for back-dated exchanges too.
      const later = this.experiences.findIndex((other) => Date.parse(other.at) > at);
      if (later === -1) this.experiences.push(experience);
      else this.experiences.splice(later, 0, experience);
      await this.save();
      return experience;
    });
  }

  /** Explicit thumbs up/down on an exchange; also credits or blames the memories it used. */
  feedback(id: string, good: boolean): Promise<void> {
    return this.serial(async () => {
      const experience = this.get(id);
      if (!experience) throw new Error(`experience ${id} not found`);
      const at = this.now().toISOString();
      experience.feedback = good ? 'good' : 'bad';
      experience.satisfaction = good ? Math.max(experience.satisfaction, 0.9) : Math.min(experience.satisfaction, 0.1);
      this.adjust(experience, good, at);
      for (const usedId of experience.recalled) {
        const used = this.get(usedId);
        if (used) this.adjust(used, good, at);
      }
      await this.save();
    });
  }

  forget(id: string): Promise<boolean> {
    return this.serial(async () => {
      const before = this.experiences.length;
      this.experiences = this.experiences.filter((experience) => experience.id !== id);
      await this.save();
      return this.experiences.length < before;
    });
  }

  clear(): Promise<void> {
    return this.serial(async () => {
      this.experiences = [];
      await this.save();
    });
  }

  exportJson(): string {
    return JSON.stringify(this.toFile());
  }

  effectiveStrength(experience: Experience): number {
    const days = Math.max(0, (this.now().getTime() - Date.parse(experience.lastUsedAt)) / DAY_MS);
    return experience.strength * Math.exp(-this.config.lambda * days);
  }

  private adjust(experience: Experience, good: boolean, at: string) {
    experience.strength = good
      ? experience.strength + this.config.alpha * (1 - experience.strength)
      : experience.strength - this.config.beta * experience.strength;
    experience.lastUsedAt = at;
  }

  /** The person's next ask can be a reaction to an earlier exchange: praise or a correction changes its satisfaction. */
  private reactToEarlier(next: Experience) {
    const now = Date.parse(next.at);
    const window = this.config.followupMinutes * 60_000;
    const recent = this.experiences.filter((experience) => {
      const age = now - Date.parse(experience.at);
      return age >= 0 && age <= window;
    });
    if (!recent.length) return;
    const latest = recent.at(-1)!;
    const correction = probeScore(next.askVector, this.probes.correction);
    const delta = 0.3 * next.valence - 0.5 * correction;
    if (Math.abs(delta) < 0.05) return;
    for (const earlier of recent) {
      const related = earlier === latest || cosine(next.unitVector, earlier.unitVector) >= this.config.followupSimilarity;
      if (!related) continue;
      earlier.satisfaction = clamp01(earlier.satisfaction + delta);
      this.adjust(earlier, delta > 0, next.at);
    }
  }

  private async build(input: ProcessInput, id: string, past: Experience[]): Promise<Experience> {
    const config = this.config;
    const at = input.at ?? this.now().toISOString();
    const ask = input.ask.trim();
    const response = input.response.trim() || '(no response)';
    const raw = splitPieces(ask, response);
    const [askVector, responseVector, unitVector, ...pieceVectors] = await this.embedder.embed([
      ask, response, `${ask}\n${response}`, ...raw.map((piece) => piece.text),
    ]);

    // Layer 1: relevance of each piece to the other side of the unit; the most relevant goes through first.
    const ranked = raw
      .map((piece, index) => ({
        ...piece,
        vector: pieceVectors[index],
        relevance: clamp01(cosine(pieceVectors[index], piece.side === 'ask' ? responseVector : askVector)),
      }))
      .sort((left, right) => right.relevance - left.relevance)
      .map((piece, order) => ({ ...piece, order }));

    // Layer 2: reference checks per piece, then the task <-> response and memory checks for the unit.
    const checks = memoryChecks(unitVector, at, past, config);
    const scored: ScoredPiece[] = ranked.map((piece) => {
      if (piece.order >= config.maxPieces) return { ...piece, profile: {}, importance: 0, levels: [] };
      const { profile } = referenceProfile(piece.vector, piece.side, this.probes);
      profile.novelty = checks.novelty;
      profile.trust = checks.trustSignal;
      profile.situation = checks.situation;
      return { ...piece, profile, importance: 0, levels: [] };
    });
    const askIntent = Math.max(0, ...scored.filter((piece) => piece.side === 'ask').map((piece) => piece.profile.intent ?? 0));
    const correctness = unitCorrectness(askVector, responseVector, askIntent, this.probes, config);
    for (const piece of scored) {
      if (piece.order >= config.maxPieces) continue;
      piece.profile.correctness = piece.side === 'response'
        ? correctness * (0.5 + 0.5 * clamp01((piece.relevance - config.correctnessBase) / (1 - config.correctnessBase)))
        : 0;
      piece.importance = pieceImportance(piece.profile, piece.relevance, config);
      // Layer 3: a piece goes to every level it carries.
      piece.levels = allocate(piece.profile, config);
    }

    // L4 and Layer 4: summary, level vectors, and one combined vector that keeps the whole unit.
    const summary = summarize(ask, scored);
    const [summaryVector] = await this.embedder.embed([summary]);
    const composition = compose(scored, unitVector, summaryVector, config);

    const profile = Object.fromEntries(SUB_LAYERS.map((name) => [name, 0])) as Profile;
    for (const piece of scored) {
      for (const name of SUB_LAYERS) profile[name] = Math.max(profile[name], piece.profile[name] ?? 0);
    }
    profile.correctness = correctness;
    const importances = scored.map((piece) => piece.importance).sort((left, right) => right - left);
    const topThree = importances.slice(0, 3);
    const importance = clamp01(
      0.7 * (importances[0] ?? 0)
      + 0.3 * (topThree.reduce((sum, value) => sum + value, 0) / Math.max(1, topThree.length))
      + config.historyBoost * checks.historyPull
      + 0.1 * checks.novelty * (importances[0] ?? 0)
      + 0.1 * checks.trustSignal
      + 0.1 * checks.situation,
    );
    const feeling = readEmotion(askVector, this.probes);
    const valence = Math.abs(feeling.valence) > 0.05 ? feeling.valence : 0;

    return {
      id,
      at,
      ask,
      response,
      unitVector,
      askVector,
      responseVector,
      pieces: scored.map(({ vector: _vector, ...piece }) => piece),
      summary,
      levelVectors: composition.levelVectors,
      levelWeights: composition.levelWeights,
      combined: composition.combined,
      kind: composition.kind,
      profile,
      importance,
      valence,
      satisfaction: askIntent >= 0.5 ? Math.max(0.2, correctness) : 0.6,
      historyPull: checks.historyPull,
      strength: config.startStrength,
      lastUsedAt: at,
      recalled: input.recalled ?? [],
    };
  }

  private async loadAnchors(file: MemoryFile | undefined, onProgress?: OpenOptions['onProgress']) {
    const fingerprint = anchorsFingerprint();
    const cached = file?.anchors;
    if (cached && cached.embedder === this.embedder.id && cached.fingerprint === fingerprint) {
      this.probes = buildProbes(Object.fromEntries(
        Object.entries(cached.vectors).map(([set, vectors]) => [set, vectors.map(unpackVector)]),
      ) as AnchorVectors);
      this.anchorCache = cached;
      return;
    }
    const sets = Object.keys(ANCHORS) as AnchorSet[];
    const anchors = {} as AnchorVectors;
    for (const [index, set] of sets.entries()) {
      onProgress?.('anchors', index, sets.length);
      anchors[set] = await this.embedder.embed(ANCHORS[set]);
    }
    onProgress?.('anchors', sets.length, sets.length);
    this.probes = buildProbes(anchors);
    this.anchorCache = {
      embedder: this.embedder.id,
      fingerprint,
      vectors: Object.fromEntries(sets.map((set) => [set, anchors[set].map(packVector)])) as Record<AnchorSet, ReturnType<typeof packVector>[]>,
    };
  }

  /** A different embedder: rebuild every experience from its raw text, keeping what was learned about it. */
  private async migrate(file: MemoryFile, onProgress?: OpenOptions['onProgress']) {
    const old = [...file.experiences].sort((left, right) => left.at.localeCompare(right.at));
    const rebuilt: Experience[] = [];
    for (const [index, stored] of old.entries()) {
      onProgress?.('migrate', index, old.length);
      const fresh = await this.build({ ask: stored.ask, response: stored.response, at: stored.at, recalled: stored.recalled }, stored.id, rebuilt);
      rebuilt.push({
        ...fresh,
        satisfaction: stored.satisfaction,
        strength: stored.strength,
        lastUsedAt: stored.lastUsedAt,
        feedback: stored.feedback,
      });
    }
    onProgress?.('migrate', old.length, old.length);
    this.experiences = rebuilt;
  }

  private toFile(): MemoryFile {
    return {
      format: 'atomic-v2',
      version: 1,
      embedder: this.embedder.id,
      savedAt: this.now().toISOString(),
      anchors: this.anchorCache,
      experiences: this.experiences.map(storeExperience),
    };
  }

  private save(): Promise<void> {
    return this.store.save(JSON.stringify(this.toFile()));
  }

  /** One change at a time, so the file on disk always matches memory. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
