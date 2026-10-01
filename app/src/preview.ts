import './styles.css';
import { startApp } from './app.ts';
import type { Voice } from './contracts.ts';
import type { StartReply } from './conversation.ts';
import { HashEmbedder } from './embed/hash.ts';
import { BrowserStore } from './memory/stores.ts';
import type { Platform } from './platform.ts';
import { WebVoice, browserSpeechEnv } from './voice/web-voice.ts';

/**
 * The in-chat preview: the same app inside a Claude artifact. Replies come from the viewer's own Claude account
 * through the artifact's `sample` capability, memory lives in this browser, and the frame has no microphone,
 * so the person types and Surface speaks. Each call carries one prompt (instructions, memories, the ask) and
 * nothing else: like the phone app, there is no conversation history to lean on.
 */

/** What the artifact capabilities reject with. */
interface CapabilityError {
  code: string;
  message?: string;
  text?: string;
}

type Sample = (
  input: string,
  options: { onText(update: { text: string; delta: string }): void; signal: AbortSignal; modelTier: 'quick'; cache: false },
) => Promise<{ text: string; truncated: boolean }>;

interface Downloads {
  save(request: { filename: string; data: string }): Promise<{ status: string }>;
}

interface ArtifactRuntime {
  use(name: 'sample'): Promise<Sample | null>;
  use(name: 'downloads'): Promise<Downloads | null>;
}

const runtime = (window as Window & { claude?: ArtifactRuntime }).claude;
const sample: Promise<Sample | null> = runtime ? runtime.use('sample').catch(() => null) : Promise.resolve(null);
const downloads: Promise<Downloads | null> = runtime ? runtime.use('downloads').catch(() => null) : Promise.resolve(null);

class SampleUnavailable extends Error {}

function hasCode(error: unknown): error is CapabilityError {
  return typeof error === 'object' && error !== null && typeof (error as CapabilityError).code === 'string';
}

/** One prompt: the system instructions, then the single message. The sample capability has no system role. */
export function samplePrompt(system: string, ask: string): string {
  return `${system}\n\n<message>\n${ask}\n</message>\n\nReply to that message as Surface, following everything above. Write only the reply itself.`;
}

const startReply: StartReply = ({ system, messages, onText }) => {
  const control = new AbortController();
  const done = (async () => {
    const ask = await sample;
    if (!ask) throw new SampleUnavailable('Replies work only when this page is opened in Claude.');
    try {
      const result = await ask(samplePrompt(system, messages[0]?.content ?? ''), {
        signal: control.signal,
        modelTier: 'quick',
        cache: false,
        onText: ({ delta }) => onText(delta),
      });
      return { text: result.text, refused: false };
    } catch (error) {
      if (hasCode(error) && error.code === 'refused') return { text: '', refused: true };
      throw error;
    }
  })();
  return { done, abort: () => control.abort() };
};

function describeError(error: unknown): string {
  if (error instanceof SampleUnavailable) return error.message;
  if (!hasCode(error)) return error instanceof Error ? error.message : String(error);
  switch (error.code) {
    case 'not_granted':
    case 'sampling_disabled':
    case 'not_declared':
    case 'capability_disabled':
    case 'capability_removed':
      return 'Surface needs permission to use your Claude account for replies. Reload the page and allow it.';
    case 'rate_limited':
      return 'Too many messages right now, or your usage limit was reached. Try again in a little while.';
    case 'session_expired':
      return 'Sign in to Claude again, then send your message.';
    case 'prompt_too_large':
      return 'That message is too long. Try a shorter one.';
    case 'empty_completion':
      return 'No reply came back. Try asking in a different way.';
    default:
      return 'Claude could not answer just now. Send your message again.';
  }
}

/** Speech out through the browser; the artifact frame refuses the microphone, so recognition is left out. */
function speakOnlyVoice(): Voice {
  return new WebVoice({ ...browserSpeechEnv(), Recognition: undefined, getUserMedia: undefined });
}

const platform: Platform = {
  needsApiKey: false,
  voice: speakOnlyVoice(),
  store: new BrowserStore(),
  startReply,
  noMicrophoneText: 'The microphone is not available in this preview. Type instead; the Android app listens.',
  where: 'in this browser',
  async chooseEmbedder() {
    return {
      embedder: new HashEmbedder(),
      config: HashEmbedder.config,
      note: 'basic memory (spelling-based): the Android app uses the on-device multilingual model',
      warning: 'Preview: memory matches by spelling here. The Android app understands meaning across English, Hindi and Hinglish.',
    };
  },
  async exportMemory(json) {
    const saver = await downloads;
    if (!saver) throw new Error('saving files is not available here');
    try {
      await saver.save({ filename: `surface-memory-${new Date().toISOString().slice(0, 10)}.json`, data: json });
    } catch (error) {
      if (hasCode(error) && error.code === 'declined') return;
      throw new Error(hasCode(error) ? error.code : String(error));
    }
  },
};

startApp(platform, { describeError });
