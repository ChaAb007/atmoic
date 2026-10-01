import type { AtomicV2Config, Embedder, MemoryStore } from '@atomic-v2';
import type { Voice } from './contracts.ts';
import type { StartReply } from './conversation.ts';

/** Progress UI the platform may update while it prepares the embedder. */
export interface BootUi {
  setText(text: string): void;
  setProgress(fraction: number): void;
  /** Shows a "use basic memory for now" button; resolves when it is pressed. */
  offerSkip(afterMs: number): Promise<void>;
}

export interface EmbedderChoice {
  embedder: Embedder;
  /** Shown in the memory sheet, e.g. "on-device multilingual model". */
  note: string;
  /** Shown as a banner when memory runs in a reduced mode. */
  warning?: string;
  /** Tuning that belongs to this embedder, e.g. its recall cut-off. */
  config?: Partial<AtomicV2Config>;
}

/** Everything that differs between the Android app and the in-chat preview. */
export interface Platform {
  /** True when replies need the person's own Claude API key (the phone app). */
  needsApiKey: boolean;
  voice: Voice;
  store: MemoryStore;
  startReply: StartReply;
  chooseEmbedder(ui: BootUi): Promise<EmbedderChoice>;
  /** Hand the memory file to the person; undefined hides the export button. */
  exportMemory?(json: string): Promise<void>;
  /** Shown when the mic is tapped on a platform that cannot listen. */
  noMicrophoneText: string;
  /** Where memory lives, as the UI says it: "on this phone", "in this browser". */
  where: string;
}
