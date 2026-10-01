import { Deferred } from './async.ts';

/** How long one listen may run before it is wound down. All values in milliseconds. */
export interface ListenTiming {
  /** Hard cap on a single listen. */
  maxMs: number;
  /** Give up when nothing at all has been heard for this long. */
  noSpeechMs: number;
  /** Once something was heard, end after this long without a new transcript. */
  trailingSilenceMs: number;
  /** After the engine stops capturing, how long to wait for its final transcript. */
  finalResultGraceMs: number;
}

export const DEFAULT_LISTEN_TIMING: ListenTiming = {
  maxMs: 30_000,
  noSpeechMs: 8_000,
  trailingSilenceMs: 2_500,
  finalResultGraceMs: 1_200,
};

export interface ListenSessionOptions {
  timing: ListenTiming;
  onPartial(text: string): void;
  /** Asks the speech engine to stop capturing; its final transcript may still follow. */
  stopEngine(): void;
}

type Phase = 'open' | 'ending' | 'done';

/**
 * One listen, independent of the speech engine: keeps the latest transcript, runs the
 * timeouts and resolves `result` exactly once, whatever the engine does or fails to do.
 *
 * Phases: open (capturing) -> ending (engine stopped, waiting briefly for the final
 * transcript) -> done (result resolved).
 */
export class ListenSession {
  private readonly options: ListenSessionOptions;
  private readonly outcome = new Deferred<string>();
  private phase: Phase = 'open';
  private text = '';
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private maxTimer: ReturnType<typeof setTimeout> | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ListenSessionOptions) {
    this.options = options;
    this.maxTimer = setTimeout(() => this.stop(), options.timing.maxMs);
    this.armSilenceTimer();
  }

  /** Resolves with the final transcript ('' if nothing was heard). Never rejects. */
  get result(): Promise<string> {
    return this.outcome.promise;
  }

  get transcript(): string {
    return this.text;
  }

  /** True once the session stopped capturing (ending or done). */
  get closing(): boolean {
    return this.phase !== 'open';
  }

  /** The engine's current hypothesis of everything said so far. */
  heard(hypothesis: string): void {
    if (this.phase === 'done') return;
    const text = hypothesis.trim();
    const changed = text !== '' && text !== this.text;
    if (changed) {
      this.text = text;
      this.options.onPartial(text);
    }
    // Anything arriving after the engine stopped capturing is its final answer.
    if (this.phase === 'ending') this.finish();
    else if (changed) this.armSilenceTimer();
  }

  /** The engine detected the start of speech. */
  speechStarted(): void {
    if (this.phase === 'open') this.armSilenceTimer();
  }

  /** The engine stopped capturing on its own; wait briefly for its final transcript. */
  end(): void {
    if (this.phase !== 'open') return;
    this.phase = 'ending';
    this.clearCaptureTimers();
    this.graceTimer = setTimeout(() => this.finish(), this.options.timing.finalResultGraceMs);
  }

  /** Ask the engine to stop, then wait briefly for its final transcript. */
  stop(): void {
    if (this.phase !== 'open') return;
    this.end();
    try {
      this.options.stopEngine();
    } catch {
      // The engine may already be gone; the grace timer still resolves the session.
    }
  }

  /** Resolve now with what was heard so far. */
  finish(): void {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.clearCaptureTimers();
    clearTimeout(this.graceTimer);
    this.outcome.resolve(this.text);
  }

  private armSilenceTimer(): void {
    clearTimeout(this.silenceTimer);
    const { noSpeechMs, trailingSilenceMs } = this.options.timing;
    this.silenceTimer = setTimeout(() => this.stop(), this.text ? trailingSilenceMs : noSpeechMs);
  }

  private clearCaptureTimers(): void {
    clearTimeout(this.silenceTimer);
    clearTimeout(this.maxTimer);
  }
}
