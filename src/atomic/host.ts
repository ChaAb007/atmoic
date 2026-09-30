import type { AtomicConfig } from './config.ts';
import { AtomicEngine } from './engine.ts';
import type { Clock, Models, StorageAdapter } from './ports.ts';
import { cycleIndex, DEFAULT_SYNC, isWindowOpen } from './sync.ts';
import type { SyncWindowConfig } from './sync.ts';
import type { Fundamental } from './types.ts';

export interface HostOptions {
  /** Supplied by the application Atomic is installed in: one database per client. */
  storageFor(tenantId: string): StorageAdapter | Promise<StorageAdapter>;
  fundamentalFor(tenantId: string): Fundamental | Promise<Fundamental>;
  models: Models;
  config?: Partial<AtomicConfig>;
  sync?: Partial<SyncWindowConfig>;
  clock?: Clock;
}

export interface TickResult {
  tenantId: string;
  applied: number;
}

/** Opens a client's memory on demand and syncs each client's learning only in its own window. */
export class AtomicHost {
  readonly sync: SyncWindowConfig;
  private readonly options: HostOptions;
  private readonly clock: Clock;
  private readonly engines = new Map<string, Promise<AtomicEngine>>();
  private readonly lastSyncedCycle = new Map<string, number>();

  constructor(options: HostOptions) {
    this.options = options;
    this.sync = { ...DEFAULT_SYNC, ...options.sync };
    this.clock = options.clock ?? { now: () => new Date() };
  }

  open(tenantId: string): Promise<AtomicEngine> {
    let engine = this.engines.get(tenantId);
    if (!engine) {
      engine = (async () => new AtomicEngine({
        tenantId,
        storage: await this.options.storageFor(tenantId),
        fundamental: await this.options.fundamentalFor(tenantId),
        models: this.options.models,
        config: this.options.config,
        clock: this.clock,
      }))();
      engine.catch(() => this.engines.delete(tenantId));
      this.engines.set(tenantId, engine);
    }
    return engine;
  }

  close(tenantId: string): void {
    this.engines.delete(tenantId);
    this.lastSyncedCycle.delete(tenantId);
  }

  openTenants(): string[] {
    return [...this.engines.keys()];
  }

  /**
   * Call periodically. Syncs only clients whose window is open and that have not synced this cycle,
   * at most `maxConcurrent` per tick; the rest wait for the next tick inside the same window.
   */
  async tick(): Promise<TickResult[]> {
    const now = this.clock.now();
    const cycle = cycleIndex(now, this.sync);
    const due = [...this.engines.keys()]
      .filter((tenantId) => isWindowOpen(tenantId, now, this.sync))
      .filter((tenantId) => this.lastSyncedCycle.get(tenantId) !== cycle)
      .slice(0, this.sync.maxConcurrent);
    return Promise.all(due.map(async (tenantId) => {
      const engine = await this.open(tenantId);
      const result = await engine.sync(this.sync.batchSize);
      if ((await engine.pendingLearning()) === 0) this.lastSyncedCycle.set(tenantId, cycle);
      return { tenantId, applied: result.applied };
    }));
  }
}
