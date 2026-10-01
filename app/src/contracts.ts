/**
 * Interfaces shared by the app's parts. The face, voice and memory modules depend only on these,
 * so each can be built and tested on its own.
 */

export type FaceState = 'ready' | 'listening' | 'thinking' | 'speaking';

/** Mouth pose for one frame. open: jaw 0..1, wide: lip corners -1 (narrow/pursed)..1 (wide smile), round: lip rounding 0..1. */
export interface MouthShape {
  open: number;
  wide: number;
  round: number;
}

export interface Face {
  setState(state: FaceState): void;
  /** Microphone level 0..1 while listening (drives the listening rings). */
  setInputLevel(level: number): void;
  /** Lip pose; the face eases toward it every frame. */
  setMouth(shape: MouthShape): void;
  resize(): void;
  dispose(): void;
}

/** Drives the face's mouth from text being spoken. */
export interface LipSync {
  /** Start mouthing `text` at an estimated speed; boundaries re-sync it to the real speech. */
  start(text: string, options: { charsPerSecond: number }): void;
  /** The speech engine reached this character index of the current text. */
  boundary(charIndex: number): void;
  /** Close the mouth and stop. */
  stop(): void;
}

export interface Voice {
  /** What this device supports. */
  readonly canListen: boolean;
  readonly canSpeak: boolean;
  /** Ask for microphone permission; resolves false if refused. */
  init(): Promise<boolean>;
  /**
   * Listen once. Resolves with the final transcript ('' if nothing was heard).
   * Partials stream through onPartial; onLevel (0..1) is optional and may never fire.
   */
  listen(options: { lang: string; onPartial(text: string): void; onLevel?(level: number): void }): Promise<string>;
  /** Stop listening early; the pending listen() resolves with what was heard so far. */
  stopListening(): Promise<void>;
  /** Speak one piece of text. Resolves when it has finished (or was stopped). */
  speak(
    text: string,
    options: { lang: string; rate: number; onStart?(): void; onBoundary?(charIndex: number): void },
  ): Promise<void>;
  stopSpeaking(): Promise<void>;
}
