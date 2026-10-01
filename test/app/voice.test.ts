import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeVoice, classifySpeakError, type NativeVoiceTiming } from '../../app/src/voice/native-voice.ts';
import {
  bestMatch,
  joinResults,
  languageCandidates,
  pickVoice,
  splitForSpeech,
} from '../../app/src/voice/speech-text.ts';
import { WebVoice, type WebSpeechEnv } from '../../app/src/voice/web-voice.ts';

type Listener = (data: never) => void;

/** Records listeners like a Capacitor plugin and counts the ones still attached. */
class FakeEvents {
  private readonly listeners = new Map<string, Set<Listener>>();

  async addListener(eventName: string, listener: Listener): Promise<{ remove(): Promise<void> }> {
    const set = this.listeners.get(eventName) ?? new Set<Listener>();
    this.listeners.set(eventName, set);
    set.add(listener);
    return { remove: async () => void set.delete(listener) };
  }

  emit(eventName: string, data: unknown): void {
    for (const listener of [...(this.listeners.get(eventName) ?? [])]) (listener as (value: unknown) => void)(data);
  }

  get attached(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
}

/** Behaves like @capacitor-community/speech-recognition on Android with partialResults: true. */
class FakeSpeech extends FakeEvents {
  starts: unknown[] = [];
  stops = 0;
  listening = false;
  startError: Error | undefined;
  startGate: Promise<void> | undefined;
  onStop: (() => void) | undefined;

  async available() {
    return { available: true };
  }
  async checkPermissions() {
    return { speechRecognition: 'prompt' };
  }
  async requestPermissions() {
    return { speechRecognition: 'granted' };
  }
  async start(options: unknown) {
    this.starts.push(options);
    await this.startGate;
    if (this.startError) throw this.startError;
    this.listening = true;
    return {};
  }
  stop(): Promise<void> {
    this.stops += 1;
    this.listening = false;
    this.onStop?.();
    return new Promise(() => undefined); // The Android plugin never resolves stop().
  }
  async isListening() {
    return { listening: this.listening };
  }
  partial(...matches: string[]) {
    this.emit('partialResults', { matches });
  }
  state(status: 'started' | 'stopped') {
    this.emit('listeningState', { status });
  }
}

/** Behaves like @capacitor-community/text-to-speech: speak() settles only when the test says so. */
class FakeTts extends FakeEvents {
  calls: { text: string; lang: string }[] = [];
  stops = 0;
  finish: (() => void) | undefined;
  rejectLang: string | undefined;

  speak(options: { text: string; lang: string }): Promise<void> {
    this.calls.push(options);
    if (options.lang === this.rejectLang) return Promise.reject(new Error('This language is not supported.'));
    return new Promise((resolve) => {
      this.finish = resolve;
    });
  }
  async stop() {
    this.stops += 1;
  }
  range(text: string, start: number, end: number) {
    this.emit('onRangeStart', { start, end, spokenWord: text.slice(start, end) });
  }
}

const FAST: Partial<NativeVoiceTiming> = {
  maxMs: 5_000,
  noSpeechMs: 5_000,
  trailingSilenceMs: 5_000,
  finalResultGraceMs: 30,
  pollMs: 0,
  ttsRetryMs: 5,
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Fails the test instead of hanging (or passing late on a watchdog) when a promise does not settle. */
async function within<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !condition(); turn += 1) await flush();
  assert.ok(condition(), 'condition never became true');
  await flush(); // let the adapter see start() resolve
}

function nativeVoice(timing: Partial<NativeVoiceTiming> = {}) {
  const speech = new FakeSpeech();
  const tts = new FakeTts();
  const voice = new NativeVoice({ speech, tts, timing: { ...FAST, ...timing } });
  return { speech, tts, voice };
}

test('native listen: resolves on "stopped" with the last partial transcript', async () => {
  const { speech, voice } = nativeVoice();
  const partials: string[] = [];
  const heard = voice.listen({ lang: 'en-IN', onPartial: (text) => partials.push(text) });
  await until(() => speech.starts.length === 1);
  assert.deepEqual(speech.starts[0], { language: 'en-IN', partialResults: true, popup: false, maxResults: 1 });
  speech.state('started');
  speech.partial('hello');
  speech.partial('hello', 'yellow');
  speech.partial(' hello there ');
  speech.state('stopped');
  assert.equal(await heard, 'hello there');
  assert.deepEqual(partials, ['hello', 'hello there']);
});

test('native listen: a result arriving after "stopped" is final and resolves at once', async () => {
  const { speech, voice } = nativeVoice({ finalResultGraceMs: 10_000 });
  const heard = voice.listen({ lang: 'en-US', onPartial: () => undefined });
  await until(() => speech.starts.length === 1);
  speech.partial('book a table');
  speech.state('stopped');
  speech.partial('Book a table for two.');
  const started = Date.now();
  assert.equal(await heard, 'Book a table for two.');
  assert.ok(Date.now() - started < 1_000);
});

test('native stopListening: resolves the pending listen early with what was heard', async () => {
  const { speech, voice } = nativeVoice({ maxMs: 60_000 });
  const heard = voice.listen({ lang: 'en-US', onPartial: () => undefined });
  await until(() => speech.starts.length === 1);
  speech.partial('turn on');
  speech.onStop = () => speech.partial('turn on the lights'); // the recognizer's final result
  await within(voice.stopListening());
  assert.equal(await heard, 'turn on the lights');
  assert.equal(speech.stops, 1);
});

test('native stopListening while the recognizer is still starting stops it once it runs', async () => {
  const { speech, voice } = nativeVoice();
  let open = (): void => undefined;
  speech.startGate = new Promise((resolve) => (open = resolve));
  const heard = voice.listen({ lang: 'en-US', onPartial: () => undefined });
  await until(() => speech.starts.length === 1);
  const stopped = voice.stopListening();
  open();
  await stopped;
  assert.equal(await heard, '');
  await flush();
  assert.equal(speech.listening, false, 'the recognizer that started late was stopped');
});

test('native listen: a start() error resolves with an empty transcript', async () => {
  const { speech, voice } = nativeVoice({ maxMs: 60_000, finalResultGraceMs: 60_000 });
  speech.startError = new Error('Missing permission');
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(await within(voice.listen({ lang: 'en-US', onPartial: () => undefined })), '');
  } finally {
    console.warn = warn;
  }
});

test('native listen: the hard timeout stops the recognizer and resolves', async () => {
  const { speech, voice } = nativeVoice({ maxMs: 60, finalResultGraceMs: 20 });
  const heard = voice.listen({ lang: 'en-US', onPartial: () => undefined });
  await until(() => speech.starts.length === 1);
  speech.partial('still talking');
  assert.equal(await heard, 'still talking');
  assert.equal(speech.stops, 1);
});

test('native listen: silence ends a listen that heard nothing', async () => {
  const { speech, voice } = nativeVoice({ noSpeechMs: 40, finalResultGraceMs: 10 });
  assert.equal(await voice.listen({ lang: 'en-US', onPartial: () => undefined }), '');
  assert.equal(speech.stops, 1);
});

test('native listen: notices a recognizer that ended without any event', async () => {
  const { speech, voice } = nativeVoice({ pollMs: 10, finalResultGraceMs: 10 });
  const heard = voice.listen({ lang: 'en-US', onPartial: () => undefined });
  await until(() => speech.starts.length === 1);
  speech.partial('maybe');
  speech.listening = false; // e.g. "No match": the plugin rejects an already resolved call
  assert.equal(await heard, 'maybe');
});

test('native listen: removes its listeners and ignores later events', async () => {
  const { speech, voice } = nativeVoice();
  const partials: string[] = [];
  const heard = voice.listen({ lang: 'en-US', onPartial: (text) => partials.push(text) });
  await until(() => speech.starts.length === 1);
  assert.equal(speech.attached, 2);
  speech.partial('done');
  await voice.stopListening();
  await heard;
  await flush();
  assert.equal(speech.attached, 0);
  speech.partial('too late');
  assert.deepEqual(partials, ['done']);
});

test('native init: asks for the microphone when not yet granted', async () => {
  const { voice } = nativeVoice();
  assert.equal(await voice.init(), true);
  assert.equal(voice.canListen, true);
});

test('native speak: maps onRangeStart to onBoundary and resolves when speech ends', async () => {
  const { tts, voice } = nativeVoice();
  const text = 'Hello brave world';
  const events: string[] = [];
  const spoken = voice.speak(text, {
    lang: 'en-US',
    rate: 1,
    onStart: () => events.push(`start (calls: ${tts.calls.length})`),
    onBoundary: (index) => events.push(`boundary ${index}`),
  });
  await until(() => tts.calls.length === 1);
  tts.range(text, 0, 5);
  tts.emit('onRangeStart', { start: 0, end: 3, spokenWord: 'old' }); // late range from an earlier utterance
  tts.range(text, 6, 11);
  tts.finish?.();
  await spoken;
  assert.deepEqual(events, ['start (calls: 0)', 'boundary 0', 'boundary 6']);
  assert.deepEqual(tts.calls[0], { text, lang: 'en-US', rate: 1, pitch: 1, volume: 1, queueStrategy: 0 });
  await flush();
  assert.equal(tts.attached, 0, 'the range listener was removed');
});

test('native stopSpeaking: resolves a pending speak that the plugin never settles', async () => {
  const { tts, voice } = nativeVoice();
  const spoken = voice.speak('A long answer', { lang: 'en-US', rate: 1 });
  await until(() => tts.calls.length === 1);
  await within(voice.stopSpeaking());
  await within(spoken);
  assert.equal(tts.stops, 1);
  await flush();
  assert.equal(tts.attached, 0);
});

test('native speak: a new utterance releases the previous one', async () => {
  const { tts, voice } = nativeVoice();
  const first = voice.speak('First', { lang: 'en-US', rate: 1 });
  await until(() => tts.calls.length === 1);
  const second = voice.speak('Second', { lang: 'en-US', rate: 1 });
  await within(first);
  await until(() => tts.calls.length === 2);
  tts.finish?.();
  await second;
});

test('native speak: falls back to the bare language when the regional one is missing', async () => {
  const { tts, voice } = nativeVoice();
  tts.rejectLang = 'hi-IN';
  const spoken = voice.speak('Namaste', { lang: 'hi-IN', rate: 1 });
  await until(() => tts.calls.length === 2);
  tts.finish?.();
  await spoken;
  assert.deepEqual(
    tts.calls.map((call) => call.lang),
    ['hi-IN', 'hi'],
  );
});

test('web voice without recognition: canListen is false and nothing throws', async () => {
  const voice = new WebVoice({});
  assert.equal(voice.canListen, false);
  assert.equal(voice.canSpeak, false);
  assert.equal(await voice.init(), false);
  assert.equal(await voice.listen({ lang: 'en-US', onPartial: () => undefined }), '');
  await voice.stopListening();
  await voice.speak('Hello', { lang: 'en-US', rate: 1 });
  await voice.stopSpeaking();
});

test('web listen: a recognizer constructor that throws resolves empty instead of throwing', async () => {
  class DisabledRecognizer {
    constructor() {
      throw new Error('speech recognition disabled by policy');
    }
  }
  const voice = new WebVoice({ Recognition: DisabledRecognizer } as unknown as WebSpeechEnv);
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(await within(voice.listen({ lang: 'en-US', onPartial: () => undefined })), '');
  } finally {
    console.warn = warn;
  }
});

/** A SpeechRecognition stand-in whose results the test drives. */
class FakeRecognizer {
  static last: FakeRecognizer | undefined;
  lang = '';
  interimResults = false;
  continuous = true;
  maxAlternatives = 0;
  onresult: ((event: { results: { transcript: string }[][] }) => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognizer.last = this;
  }
  start() {}
  stop() {
    setImmediate(() => this.onend?.());
  }
  abort() {}
  results(...texts: string[]) {
    this.onresult?.({ results: texts.map((transcript) => [{ transcript }]) });
  }
}

test('web listen: streams interim results and resolves on end', async () => {
  const voice = new WebVoice({ Recognition: FakeRecognizer } as unknown as WebSpeechEnv);
  const partials: string[] = [];
  const heard = voice.listen({ lang: 'en-GB', onPartial: (text) => partials.push(text) });
  const recognizer = FakeRecognizer.last!;
  assert.equal(recognizer.lang, 'en-GB');
  assert.equal(recognizer.interimResults, true);
  recognizer.results('what is');
  recognizer.results('what is', ' the time');
  await voice.stopListening();
  assert.equal(await heard, 'what is the time');
  assert.deepEqual(partials, ['what is', 'what is the time']);
});

test('web init: a missing microphone turns listening off, a refusal does not', async () => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const failing = (name: string) => async () => {
      throw Object.assign(new Error(name), { name });
    };
    const noMicrophone = new WebVoice({ Recognition: FakeRecognizer, getUserMedia: failing('NotFoundError') } as unknown as WebSpeechEnv);
    assert.equal(noMicrophone.canListen, true);
    assert.equal(await noMicrophone.init(), false);
    assert.equal(noMicrophone.canListen, false);
    assert.equal(await within(noMicrophone.listen({ lang: 'en-US', onPartial: () => undefined })), '');
    const refused = new WebVoice({ Recognition: FakeRecognizer, getUserMedia: failing('NotAllowedError') } as unknown as WebSpeechEnv);
    assert.equal(await refused.init(), false);
    assert.equal(refused.canListen, true);
  } finally {
    console.warn = warn;
  }
});

test('web speak: picks a matching voice, maps boundaries, and stopSpeaking releases it', async () => {
  const spoken: Record<string, unknown>[] = [];
  let cancels = 0;
  const synthesis = {
    speaking: false,
    pending: false,
    getVoices: () => [
      { lang: 'en-US', default: true, name: 'US' },
      { lang: 'en-GB', default: false, name: 'GB' },
    ],
    speak: (utterance: Record<string, (event?: unknown) => void>) => {
      spoken.push(utterance);
      setImmediate(() => {
        utterance.onstart?.();
        utterance.onboundary?.({ name: 'word', charIndex: 0 });
        utterance.onboundary?.({ name: 'sentence', charIndex: 0 });
        utterance.onboundary?.({ name: 'word', charIndex: 6 });
      });
    },
    cancel: () => {
      cancels += 1;
    },
  };
  const voice = new WebVoice({
    synthesis,
    createUtterance: (text: string) => ({ text }),
  } as unknown as WebSpeechEnv);
  assert.equal(voice.canSpeak, true);
  const boundaries: number[] = [];
  const speech = voice.speak('Hello there', { lang: 'en-GB', rate: 1.1, onBoundary: (index) => boundaries.push(index) });
  await until(() => boundaries.length === 2);
  await voice.stopSpeaking();
  await within(speech);
  assert.equal((spoken[0].voice as { name: string }).name, 'GB');
  assert.equal(spoken[0].rate, 1.1);
  assert.deepEqual(boundaries, [0, 6]);
  assert.equal(cancels, 1);
});

test('splitForSpeech: keeps short text whole and splits long text at sentence ends', () => {
  assert.deepEqual(splitForSpeech('  Hi there.  ', 100), [{ text: 'Hi there.', offset: 2 }]);
  assert.deepEqual(splitForSpeech('   ', 100), []);
  const text = 'One two three four. Five six seven eight. Nine ten eleven twelve.';
  const pieces = splitForSpeech(text, 45);
  assert.deepEqual(
    pieces.map((piece) => piece.text),
    ['One two three four. Five six seven eight.', 'Nine ten eleven twelve.'],
  );
  for (const piece of pieces) assert.equal(text.slice(piece.offset, piece.offset + piece.text.length), piece.text);
  assert.ok(splitForSpeech('x'.repeat(250), 100).every((piece) => piece.text.length <= 100));
});

test('text helpers: transcripts, languages, voices and speak errors', () => {
  assert.equal(bestMatch(['  ', ' hi ']), 'hi');
  assert.equal(bestMatch(undefined), '');
  assert.equal(joinResults([[{ transcript: 'good' }], [{ transcript: ' morning ' }]]), 'good morning');
  assert.deepEqual(languageCandidates('en_IN'), ['en-IN', 'en']);
  assert.deepEqual(languageCandidates('en'), ['en']);
  assert.deepEqual(languageCandidates(''), ['en-US', 'en']);
  const voices = [
    { lang: 'hi-IN', default: false },
    { lang: 'en_GB', default: false },
    { lang: 'en-US', default: true },
  ];
  assert.equal(pickVoice(voices, 'en-GB'), voices[1]);
  assert.equal(pickVoice(voices, 'en-AU'), voices[2]);
  assert.equal(pickVoice(voices, 'fr-FR'), undefined);
  assert.equal(classifySpeakError(new Error('This language is not supported.')), 'language');
  assert.equal(classifySpeakError(Object.assign(new Error('Not yet initialized'), { code: 'UNAVAILABLE' })), 'starting');
  assert.equal(classifySpeakError(new Error('Failed to read text.')), 'other');
});
