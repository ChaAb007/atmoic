import { cloneWeights, DEFAULT_WEIGHTS } from './config.ts';
import type { AtomicConfig } from './config.ts';
import type { StorageAdapter } from './ports.ts';
import type { LearningEvent, LearningSignal, WeightsTable } from './types.ts';

const DAY_MS = 86_400_000;

const STRENGTHEN: LearningSignal[] = ['confirmed', 'good_outcome', 'repeat'];
const WEAKEN: LearningSignal[] = ['rejected', 'bad_outcome'];

export function adjustStrength(strength: number, signal: LearningSignal, config: AtomicConfig): number {
  if (STRENGTHEN.includes(signal)) return strength + config.alpha * (1 - strength);
  if (WEAKEN.includes(signal)) return strength - config.beta * strength;
  return strength;
}

/** Decay is computed when read and never written back, so reading cannot reset the clock. */
export function effectiveStrength(strength: number, lastUsedAt: string, now: Date, config: AtomicConfig): number {
  const last = Date.parse(lastUsedAt);
  if (Number.isNaN(last)) return strength;
  const days = Math.max(0, (now.getTime() - last) / DAY_MS);
  return strength * Math.exp(-config.lambda * days);
}

export interface SyncResult {
  applied: number;
  skipped: number;
}

/** Applies buffered learning in order. Runs only inside the tenant's sync window. */
export async function applyLearning(
  storage: StorageAdapter,
  events: LearningEvent[],
  config: AtomicConfig,
): Promise<SyncResult> {
  let applied = 0;
  let skipped = 0;
  let weights: WeightsTable | undefined;
  for (const event of events) {
    if (event.target === 'link') {
      const link = await storage.getLinkById(event.id);
      if (!link) { skipped++; continue; }
      await storage.putLink({
        ...link,
        strength: adjustStrength(link.strength, event.signal, config),
        confirms: link.confirms + (STRENGTHEN.includes(event.signal) ? 1 : 0),
        rejects: link.rejects + (WEAKEN.includes(event.signal) ? 1 : 0),
        lastUsedAt: event.at,
      });
    } else if (event.target === 'memory') {
      const memory = await storage.getMemory(event.id);
      if (!memory) { skipped++; continue; }
      await storage.updateMemory(memory.id, {
        strength: adjustStrength(memory.strength, event.signal, config),
        lastUsedAt: event.at,
      });
    } else if (event.target === 'track_record') {
      const record = (await storage.getTrackRecord(event.subject, event.intent))
        ?? { subject: event.subject, intent: event.intent, kept: 0, total: 0 };
      await storage.putTrackRecord({ ...record, kept: record.kept + (event.kept ? 1 : 0), total: record.total + 1 });
    } else {
      weights ??= cloneWeights((await storage.getWeights()) ?? DEFAULT_WEIGHTS);
      const row = weights[event.kind];
      const step = event.signal === 'missed' ? config.weightStep : -config.weightStep;
      for (const angle of event.angles) row[angle] = Math.min(5, Math.max(0, row[angle] + step));
    }
    applied++;
  }
  if (weights) await storage.putWeights(weights);
  return { applied, skipped };
}
