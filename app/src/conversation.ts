import type { Experience, RecallItem, RecallResult } from '@atomic-v2';
import type { Face, LipSync, Voice } from './contracts.ts';
import { buildMessages, buildSystemPrompt } from './llm/prompt.ts';
import { SentenceStream, speakable } from './speech/sentences.ts';
import type { Settings } from './settings-model.ts';

/** The parts of Atomic the conversation needs (the real AtomicV2 satisfies it). */
export interface Memory {
  recall(ask: string): Promise<RecallResult>;
  process(input: { ask: string; response: string; at?: string; recalled?: string[] }): Promise<Experience>;
}

export interface LlmReply {
  text: string;
  refused: boolean;
}

/** Starts one streamed reply; `onText` receives text as it arrives. */
export type StartReply = (request: {
  settings: Settings;
  system: string;
  messages: { role: 'user'; content: string }[];
  onText(delta: string): void;
}) => { done: Promise<LlmReply>; abort(): void };

export interface TurnView {
  ask: string;
  reply: string;
  memories: RecallItem[];
  phase: 'thinking' | 'speaking' | 'done' | 'error';
  error?: string;
  experience?: Experience;
}

export interface ConversationDeps {
  memory: Memory;
  startReply: StartReply;
  settings(): Settings;
  voice?: Voice;
  face?: Face;
  lipSync?: LipSync;
  now?(): Date;
  timeZone?: string;
  /** Called whenever the current turn changes (the only turn there is). */
  onTurn(turn: TurnView): void;
  describeError?(error: unknown): string;
}

/** Characters per second of speech at rate 1, for lip sync before the engine reports word boundaries. */
const CHARS_PER_SECOND = 14;

/**
 * One ask in, one reply out, and both pushed through Atomic. There is deliberately no chat history:
 * the model only knows the past through what Atomic recalls for this ask.
 */
export class Conversation {
  private active: { abort(): void; interrupted: boolean } | undefined;
  private speaking = Promise.resolve();
  private readonly deps: ConversationDeps;

  constructor(deps: ConversationDeps) {
    this.deps = deps;
  }

  get busy(): boolean {
    return this.active !== undefined;
  }

  async ask(raw: string): Promise<TurnView | undefined> {
    const ask = raw.trim();
    if (!ask) return undefined;
    this.interrupt();
    const deps = this.deps;
    const settings = deps.settings();
    const at = (deps.now?.() ?? new Date()).toISOString();
    const turn: TurnView = { ask, reply: '', memories: [], phase: 'thinking' };
    const update = () => deps.onTurn({ ...turn, memories: [...turn.memories] });
    deps.face?.setState('thinking');
    update();

    const control = { abort: () => undefined as void, interrupted: false };
    this.active = control;
    try {
      const recall = await deps.memory.recall(ask);
      turn.memories = recall.items;
      update();
      if (control.interrupted) return turn;

      const sentences = new SentenceStream();
      const speakAll = (parts: string[]) => {
        if (!settings.speakReplies || !deps.voice?.canSpeak) return;
        for (const part of parts) this.queueSpeech(part, settings, control);
      };
      const handle = deps.startReply({
        settings,
        system: buildSystemPrompt({ ask, now: new Date(at), userName: settings.userName, memories: recall.items, timeZone: deps.timeZone }),
        messages: buildMessages(ask),
        onText: (delta) => {
          if (control.interrupted) return;
          turn.reply += delta;
          if (turn.phase === 'thinking') turn.phase = 'speaking';
          update();
          speakAll(sentences.push(delta));
        },
      });
      control.abort = handle.abort;
      const reply = await handle.done;
      if (reply.refused) {
        await this.stopSpeech();
        turn.reply = "I can't help with that one.";
        speakAll([turn.reply]);
      } else {
        turn.reply = reply.text || turn.reply;
        speakAll(sentences.flush());
      }
      await this.speaking;
      turn.phase = 'done';
      update();
      if (reply.refused) return turn;
      turn.experience = await deps.memory.process({ ask, response: turn.reply, at, recalled: recall.items.map((item) => item.experience.id) });
      update();
      return turn;
    } catch (error) {
      if (control.interrupted) {
        // What was actually said before the interruption is still part of the experience.
        if (turn.reply.trim()) turn.experience = await deps.memory.process({ ask, response: `${turn.reply.trim()} …`, at, recalled: turn.memories.map((item) => item.experience.id) });
        turn.phase = 'done';
      } else {
        turn.phase = 'error';
        turn.error = deps.describeError?.(error) ?? (error instanceof Error ? error.message : String(error));
      }
      update();
      return turn;
    } finally {
      if (this.active === control) this.active = undefined;
      if (!this.active) deps.face?.setState('ready');
    }
  }

  /** Stop the current reply and speech (tap while speaking). */
  interrupt(): void {
    const control = this.active;
    if (!control) return;
    control.interrupted = true;
    control.abort();
    void this.stopSpeech();
  }

  private queueSpeech(text: string, settings: Settings, control: { interrupted: boolean }) {
    const spoken = speakable(text);
    if (!spoken) return;
    const { voice, face, lipSync } = this.deps;
    this.speaking = this.speaking.then(async () => {
      if (control.interrupted || !voice) return;
      face?.setState('speaking');
      try {
        await voice.speak(spoken, {
          lang: settings.language,
          rate: settings.speechRate,
          onStart: () => lipSync?.start(spoken, { charsPerSecond: CHARS_PER_SECOND * settings.speechRate }),
          onBoundary: (charIndex) => lipSync?.boundary(charIndex),
        });
      } finally {
        lipSync?.stop();
      }
    }).catch(() => undefined);
  }

  private async stopSpeech() {
    this.deps.lipSync?.stop();
    await this.deps.voice?.stopSpeaking().catch(() => undefined);
  }
}
