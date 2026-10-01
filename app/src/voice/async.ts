/** Small async building blocks shared by the voice adapters. */

/** A promise that is settled from outside, exactly once. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  private resolver: (value: T) => void = () => undefined;
  private done = false;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolver = resolve;
    });
  }

  get settled(): boolean {
    return this.done;
  }

  /** Settles the promise; later calls are ignored. */
  resolve(value: T): void {
    if (this.done) return;
    this.done = true;
    this.resolver(value);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for `work` to settle (success or failure), but never longer than `ms`. */
export async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([work.then(ignore, ignore), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

export function ignore(): undefined {
  return undefined;
}

/** What Capacitor's addListener resolves with. */
export interface ListenerHandle {
  remove(): Promise<void>;
}

/**
 * Tracks plugin listeners so one call can remove them all, including listeners whose
 * registration is still in flight when the owner is done.
 */
export class ListenerBag {
  private readonly handles: Promise<ListenerHandle | undefined>[] = [];
  private closed = false;

  /** Tracks a registration; resolves once the listener is registered (or failed to register). */
  add(registration: Promise<ListenerHandle>): Promise<void> {
    const handle = registration.then(
      (registered) => {
        if (!this.closed) return registered;
        // The owner finished while this listener was being registered.
        void removeQuietly(registered);
        return undefined;
      },
      ignore,
    );
    this.handles.push(handle);
    return handle.then(ignore);
  }

  async removeAll(): Promise<void> {
    this.closed = true;
    const handles = await Promise.all(this.handles.splice(0));
    await Promise.all(handles.map((handle) => (handle ? removeQuietly(handle) : undefined)));
  }
}

function removeQuietly(handle: ListenerHandle): Promise<void> {
  return handle.remove().catch(ignore);
}
