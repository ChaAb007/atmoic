import { createHash } from 'node:crypto';

export interface SyncWindowConfig {
  /** Length of one full cycle, e.g. one hour. */
  cycleMs: number;
  /** The cycle is split into this many windows; each client gets one. */
  slots: number;
  /** At most this many clients sync in one tick. */
  maxConcurrent: number;
  /** At most this many learning events are applied per client per window. */
  batchSize: number;
}

export const DEFAULT_SYNC: SyncWindowConfig = {
  cycleMs: 3_600_000,
  slots: 12,
  maxConcurrent: 4,
  batchSize: 500,
};

/** A client's window is fixed by its id, so clients spread across the cycle instead of syncing together. */
export function slotFor(tenantId: string, slots: number): number {
  const digest = createHash('sha256').update(tenantId).digest();
  return digest.readUInt32BE(0) % slots;
}

export function openSlot(now: Date, config: SyncWindowConfig): number {
  const within = ((now.getTime() % config.cycleMs) + config.cycleMs) % config.cycleMs;
  return Math.floor(within / (config.cycleMs / config.slots));
}

export function cycleIndex(now: Date, config: SyncWindowConfig): number {
  return Math.floor(now.getTime() / config.cycleMs);
}

export function isWindowOpen(tenantId: string, now: Date, config: SyncWindowConfig): boolean {
  return slotFor(tenantId, config.slots) === openSlot(now, config);
}
