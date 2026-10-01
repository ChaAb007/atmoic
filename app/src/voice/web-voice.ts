import type { Voice } from '../contracts.ts';
import { Deferred } from './async.ts';
import { DEFAULT_LISTEN_TIMING, ListenSession, type ListenTiming } from './listen-session.ts';
import {
  joinResults,
  pickVoice,
  speechWatchdogMs,
  splitForSpeech,
  type RecognitionResultsLike,
  type SpeechPiece,
} from './speech-text.ts';

type ListenOptions = Parameters<Voice['listen']>[0];
type SpeakOptions = Parameters<Voice['speak']>[1];

/** The parts of the Web Speech API's SpeechRecognition used here (TypeScript's DOM lib does not declare it). */
export interface RecognizerLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: { readonly results: RecognitionResultsLike }) => void) | null;
  onspeechstart: (() => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type RecognizerConstructor = new () => RecognizerLike;

/** The browser speech APIs, injected so the adapter can be tested with fakes. */
export interface WebSpeechEnv {
  Recognition?: RecognizerConstructor;
  synthesis?: SpeechSynthesis;
  createUtterance?(text: string): SpeechSynthesisUtterance;
  getUserMedia?(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

/** Reads the speech APIs this browser offers; missing ones stay undefined. */
export function browserSpeechEnv(): WebSpeechEnv {
  if (typeof window === 'undefined') return {};
  const speechWindow = window as Window & {
    SpeechRecognition?: RecognizerConstructor;
    webkitSpeechRecognition?: RecognizerConstructor;
  };
  // Undefined outside secure contexts, despite the DOM typing.
  const mediaDevices = navigator.mediaDevices as MediaDevices | undefined;
  return {
    Recognition: speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition,
    synthesis: 'speechSynthesis' in window ? window.speechSynthesis : undefined,
    createUtterance:
      typeof SpeechSynthesisUtterance === 'function' ? (text) => new SpeechSynthesisUtterance(text) : undefined,
    getUserMedia: mediaDevices?.getUserMedia ? (constraints) => mediaDevices.getUserMedia(constraints) : undefined,
  };
}

// Chrome's network voices go silent after about 15 s of continuous speech, so long text is spoken in pieces.
const MAX_UTTERANCE_CHARS = 200;
// If an utterance has not started by then, the engine dropped it (no voices, autoplay policy...).
const SPEECH_START_TIMEOUT_MS = 3_000;

/** Voice in the browser through the Web Speech API. */
export class WebVoice implements Voice {
  readonly canSpeak: boolean;
  private readonly env: WebSpeechEnv;
  private readonly timing: ListenTiming;
  private listenSupported: boolean;
  private activeListen: { session: ListenSession; recognizer: RecognizerLike } | undefined;
  private pendingSpeech: Deferred<void> | undefined;
  // Chrome may garbage-collect an utterance that is still playing and then never fire its onend.
  private currentUtterance: SpeechSynthesisUtterance | undefined;

  constructor(env: WebSpeechEnv, timing: Partial<ListenTiming> = {}) {
    this.env = env;
    this.timing = { ...DEFAULT_LISTEN_TIMING, ...timing };
    this.listenSupported = env.Recognition !== undefined;
    this.canSpeak = env.synthesis !== undefined && env.createUtterance !== undefined;
  }

  /** True while the browser has speech recognition and init() has not found the microphone missing. */
  get canListen(): boolean {
    return this.listenSupported;
  }

  async init(): Promise<boolean> {
    if (!this.canListen) return false;
    // Without getUserMedia the recognizer asks for the microphone itself on start().
    if (!this.env.getUserMedia) return true;
    try {
      const stream = await this.env.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      return true;
    } catch (error) {
      // No microphone at all means this device cannot listen; a refusal may change later.
      if (errorName(error) === 'NotFoundError') this.listenSupported = false;
      console.warn('[voice] microphone unavailable', error);
      return false;
    }
  }

  listen(options: ListenOptions): Promise<string> {
    this.abortActiveListen();
    const Recognition = this.env.Recognition;
    if (!Recognition || !this.listenSupported) return Promise.resolve('');
    const recognizer = new Recognition();
    const session = new ListenSession({
      timing: this.timing,
      onPartial: options.onPartial,
      stopEngine: () => recognizer.stop(),
    });
    this.activeListen = { session, recognizer };
    recognizer.lang = options.lang;
    recognizer.interimResults = true;
    recognizer.continuous = false;
    recognizer.maxAlternatives = 1;
    recognizer.onspeechstart = () => session.speechStarted();
    recognizer.onresult = (event) => session.heard(joinResults(event.results));
    // 'no-speech', 'not-allowed', 'network'...: onend follows; the grace timer covers it if not.
    recognizer.onerror = () => session.end();
    // The final result always arrives before onend.
    recognizer.onend = () => session.finish();
    try {
      recognizer.start();
    } catch (error) {
      console.warn('[voice] speech recognition failed to start', error);
      session.finish();
    }
    return session.result.finally(() => {
      release(recognizer);
      if (this.activeListen?.session === session) this.activeListen = undefined;
    });
  }

  async stopListening(): Promise<void> {
    const active = this.activeListen;
    if (!active) return;
    active.session.stop();
    await active.session.result;
  }

  async speak(text: string, options: SpeakOptions): Promise<void> {
    const { synthesis, createUtterance } = this.env;
    const pieces = splitForSpeech(text, MAX_UTTERANCE_CHARS);
    if (!synthesis || !createUtterance || pieces.length === 0) return;
    // Like the native adapter, a new utterance replaces whatever is still being spoken.
    if (this.releasePendingSpeech() || synthesis.speaking || synthesis.pending) synthesis.cancel();
    const speech = new Deferred<void>();
    this.pendingSpeech = speech;
    const voice = pickVoice(synthesis.getVoices(), options.lang);
    try {
      options.onStart?.();
      for (const piece of pieces) {
        if (speech.settled) break;
        const utterance = createUtterance(piece.text);
        utterance.lang = voice?.lang ?? options.lang;
        if (voice) utterance.voice = voice;
        utterance.rate = Math.min(Math.max(options.rate, 0.1), 10);
        await this.speakPiece(synthesis, utterance, piece, options, speech);
      }
    } finally {
      speech.resolve();
      if (this.pendingSpeech === speech) {
        this.pendingSpeech = undefined;
        this.currentUtterance = undefined;
      }
    }
  }

  async stopSpeaking(): Promise<void> {
    this.releasePendingSpeech();
    this.env.synthesis?.cancel();
  }

  /** Resolves when the piece ends, fails, is stopped, or its watchdog fires. */
  private speakPiece(
    synthesis: SpeechSynthesis,
    utterance: SpeechSynthesisUtterance,
    piece: SpeechPiece,
    options: SpeakOptions,
    speech: Deferred<void>,
  ): Promise<void> {
    return new Promise((resolve) => {
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        clearTimeout(watchdog);
        resolve();
      };
      watchdog = setTimeout(finish, SPEECH_START_TIMEOUT_MS);
      utterance.onstart = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(finish, speechWatchdogMs(piece.text, options.rate));
      };
      utterance.onboundary = (event) => {
        // Sentence boundaries repeat a position that word boundaries already gave.
        if (!speech.settled && event.name !== 'sentence') options.onBoundary?.(piece.offset + event.charIndex);
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      void speech.promise.then(finish);
      this.currentUtterance = utterance;
      synthesis.speak(utterance);
    });
  }

  /** Releases the caller of a pending speak(); returns whether there was one. */
  private releasePendingSpeech(): boolean {
    const pending = this.pendingSpeech;
    this.pendingSpeech = undefined;
    pending?.resolve();
    return pending !== undefined;
  }

  private abortActiveListen(): void {
    const active = this.activeListen;
    if (!active) return;
    this.activeListen = undefined;
    active.session.finish();
    release(active.recognizer);
  }
}

function errorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string'
    ? error.name
    : undefined;
}

/** Detaches a recognizer's handlers and makes sure it has let go of the microphone. */
function release(recognizer: RecognizerLike): void {
  recognizer.onresult = null;
  recognizer.onspeechstart = null;
  recognizer.onerror = null;
  recognizer.onend = null;
  try {
    recognizer.abort();
  } catch {
    // Already stopped.
  }
}
