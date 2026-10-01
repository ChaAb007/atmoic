import type { Voice } from '../contracts.ts';
import { Deferred, ListenerBag, delay, ignore, settleWithin, type ListenerHandle } from './async.ts';
import { DEFAULT_LISTEN_TIMING, ListenSession, type ListenTiming } from './listen-session.ts';
import { bestMatch, languageCandidates, speechWatchdogMs, splitForSpeech } from './speech-text.ts';

type ListenOptions = Parameters<Voice['listen']>[0];
type SpeakOptions = Parameters<Voice['speak']>[1];

/** The parts of @capacitor-community/speech-recognition (v7) this adapter uses. */
export interface SpeechRecognitionPluginLike {
  available(): Promise<{ available: boolean }>;
  checkPermissions(): Promise<{ speechRecognition: string }>;
  requestPermissions(): Promise<{ speechRecognition: string }>;
  start(options: { language: string; partialResults: boolean; popup: boolean; maxResults: number }): Promise<{
    matches?: string[];
  }>;
  stop(): Promise<void>;
  isListening(): Promise<{ listening: boolean }>;
  addListener(eventName: 'partialResults', listener: (data: { matches: string[] }) => void): Promise<ListenerHandle>;
  addListener(
    eventName: 'listeningState',
    listener: (data: { status: 'started' | 'stopped' }) => void,
  ): Promise<ListenerHandle>;
}

/** The parts of @capacitor-community/text-to-speech (v8) this adapter uses. */
export interface TextToSpeechPluginLike {
  speak(options: {
    text: string;
    lang: string;
    rate: number;
    pitch: number;
    volume: number;
    queueStrategy: number;
  }): Promise<void>;
  stop(): Promise<void>;
  addListener(
    eventName: 'onRangeStart',
    listener: (info: { start: number; end: number; spokenWord: string }) => void,
  ): Promise<ListenerHandle>;
}

export interface NativeVoiceTiming extends ListenTiming {
  /** How often to ask the recognizer whether it is still listening; 0 turns polling off. */
  pollMs: number;
  /** Wait before retrying while the text-to-speech engine is still starting up. */
  ttsRetryMs: number;
}

export const DEFAULT_NATIVE_TIMING: NativeVoiceTiming = { ...DEFAULT_LISTEN_TIMING, pollMs: 500, ttsRetryMs: 700 };

export interface NativeVoiceOptions {
  speech: SpeechRecognitionPluginLike;
  tts: TextToSpeechPluginLike;
  timing?: Partial<NativeVoiceTiming>;
}

// QueueStrategy.Flush. The plugin's enum is not imported so this file also runs under Node tests.
const QUEUE_FLUSH = 0;
// Android's TextToSpeech rejects input longer than getMaxSpeechInputLength() (4000 chars).
const MAX_UTTERANCE_CHARS = 3_900;
const TTS_STARTUP_RETRIES = 3;
const TTS_STOP_TIMEOUT_MS = 1_000;

/** Voice on Android through the Capacitor speech-recognition and text-to-speech plugins. */
export class NativeVoice implements Voice {
  readonly canSpeak = true;
  private readonly speech: SpeechRecognitionPluginLike;
  private readonly tts: TextToSpeechPluginLike;
  private readonly timing: NativeVoiceTiming;
  private recognitionAvailable = true;
  private activeListen: ListenSession | undefined;
  private pendingSpeech: Deferred<void> | undefined;

  constructor(options: NativeVoiceOptions) {
    this.speech = options.speech;
    this.tts = options.tts;
    this.timing = { ...DEFAULT_NATIVE_TIMING, ...options.timing };
  }

  /** True until init() finds no speech recognition service on the device. */
  get canListen(): boolean {
    return this.recognitionAvailable;
  }

  async init(): Promise<boolean> {
    try {
      const { available } = await this.speech.available();
      this.recognitionAvailable = available;
      if (!available) return false;
      const current = await this.speech.checkPermissions();
      if (current.speechRecognition === 'granted') return true;
      const requested = await this.speech.requestPermissions();
      return requested.speechRecognition === 'granted';
    } catch (error) {
      console.warn('[voice] microphone permission check failed', error);
      return false;
    }
  }

  listen(options: ListenOptions): Promise<string> {
    // One listen at a time; the next start() also cancels the old recognizer natively.
    this.activeListen?.finish();
    const session = new ListenSession({
      timing: this.timing,
      onPartial: options.onPartial,
      stopEngine: () => this.stopRecognizer(),
    });
    this.activeListen = session;
    const listeners = new ListenerBag();
    void this.runRecognizer(session, options.lang, listeners);
    return session.result.finally(() => {
      void listeners.removeAll();
      if (this.activeListen === session) this.activeListen = undefined;
    });
  }

  async stopListening(): Promise<void> {
    const session = this.activeListen;
    if (!session) return;
    session.stop();
    await session.result;
  }

  async speak(text: string, options: SpeakOptions): Promise<void> {
    const pieces = splitForSpeech(text, MAX_UTTERANCE_CHARS);
    if (pieces.length === 0) return;
    // QueueStrategy.Flush cuts the previous utterance off natively; release its caller too.
    this.pendingSpeech?.resolve();
    const speech = new Deferred<void>();
    this.pendingSpeech = speech;
    const listeners = new ListenerBag();
    let current = pieces[0];
    try {
      const boundaries = this.tts.addListener('onRangeStart', ({ start, end, spokenWord }) => {
        // A range that does not match the current text is a late event from an earlier utterance.
        if (speech.settled || current.text.slice(start, end) !== spokenWord) return;
        options.onBoundary?.(current.offset + start);
      });
      await Promise.race([listeners.add(boundaries), speech.promise]);
      if (speech.settled) return;
      options.onStart?.();
      for (const piece of pieces) {
        if (speech.settled) break;
        current = piece;
        const spoken = Promise.race([this.utter(piece.text, options, speech), speech.promise]);
        await settleWithin(spoken, speechWatchdogMs(piece.text, options.rate));
      }
    } finally {
      speech.resolve();
      void listeners.removeAll();
      if (this.pendingSpeech === speech) this.pendingSpeech = undefined;
    }
  }

  async stopSpeaking(): Promise<void> {
    const pending = this.pendingSpeech;
    this.pendingSpeech = undefined;
    const stopping = this.tts.stop();
    // stop() drops the pending native request without ever settling it, so release the caller here.
    pending?.resolve();
    await settleWithin(stopping, TTS_STOP_TIMEOUT_MS);
  }

  private async runRecognizer(session: ListenSession, lang: string, listeners: ListenerBag): Promise<void> {
    // Events that arrive before start() resolves belong to an earlier recognizer.
    let started = false;
    try {
      await listeners.add(
        this.speech.addListener('partialResults', ({ matches }) => {
          if (started) session.heard(bestMatch(matches));
        }),
      );
      await listeners.add(
        this.speech.addListener('listeningState', ({ status }) => {
          if (!started) return;
          if (status === 'started') session.speechStarted();
          else session.end();
        }),
      );
      if (session.closing) return;
      // With partialResults the plugin resolves once the recognizer runs; transcripts follow as events.
      const { matches } = await this.speech.start({ language: lang, partialResults: true, popup: false, maxResults: 1 });
      started = true;
      if (session.closing) {
        // Stopped while the recognizer was starting. Leave a newer listen's recognizer alone.
        if (this.activeListen === session || this.activeListen === undefined) this.stopRecognizer();
        return;
      }
      const immediate = bestMatch(matches);
      if (immediate) {
        session.heard(immediate);
        session.finish();
        return;
      }
      await this.watchRecognizer(session);
    } catch (error) {
      // No permission, no recognition service or a busy recognizer: answer with what was heard.
      console.warn('[voice] speech recognition failed', error);
      session.finish();
    }
  }

  /**
   * Polls the recognizer while the session is open. Errors such as "no match", "busy" or a
   * speech timeout end it natively without any event reaching JavaScript.
   */
  private async watchRecognizer(session: ListenSession): Promise<void> {
    const { pollMs } = this.timing;
    if (pollMs <= 0) return;
    while (!session.closing) {
      await delay(pollMs);
      if (!session.closing && !(await this.recognizerListening())) session.end();
    }
  }

  private async recognizerListening(): Promise<boolean> {
    try {
      return (await this.speech.isListening()).listening;
    } catch {
      return true; // Unknown: leave it to the events and timers.
    }
  }

  private stopRecognizer(): void {
    // The Android plugin never resolves stop(), so it is never awaited.
    this.speech.stop().catch(ignore);
  }

  /** Speaks one piece, falling back to the bare language and retrying while the engine starts up. */
  private async utter(text: string, options: SpeakOptions, speech: Deferred<void>): Promise<void> {
    const languages = languageCandidates(options.lang);
    let language = 0;
    let retriesLeft = TTS_STARTUP_RETRIES;
    while (!speech.settled) {
      try {
        await this.tts.speak({
          text,
          lang: languages[language],
          rate: options.rate,
          pitch: 1,
          volume: 1,
          queueStrategy: QUEUE_FLUSH,
        });
        return;
      } catch (error) {
        const failure = classifySpeakError(error);
        if (failure === 'language' && language + 1 < languages.length) {
          language += 1;
        } else if (failure === 'starting' && retriesLeft > 0) {
          retriesLeft -= 1;
          await delay(this.timing.ttsRetryMs);
        } else {
          console.warn('[voice] text-to-speech failed', error);
          return;
        }
      }
    }
  }
}

/** Sorts a rejected speak() into what can be retried: an unsupported language or an engine still starting. */
export function classifySpeakError(error: unknown): 'language' | 'starting' | 'other' {
  const message = error instanceof Error ? error.message : String(error);
  if (/language/i.test(message)) return 'language';
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === 'UNAVAILABLE' || /not yet initiali[sz]ed/i.test(message)) return 'starting';
  return 'other';
}
