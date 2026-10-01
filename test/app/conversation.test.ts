import assert from 'node:assert/strict';
import test from 'node:test';
import type { Experience, RecallResult } from '../../src/atomic-v2/types.ts';
import { AtomicV2 } from '../../src/atomic-v2/engine.ts';
import { InMemoryStore } from '../../src/atomic-v2/store.ts';
import { Conversation } from '../../app/src/conversation.ts';
import type { StartReply, TurnView } from '../../app/src/conversation.ts';
import type { Face, LipSync, Voice } from '../../app/src/contracts.ts';
import { buildMessages, buildSystemPrompt, renderMemories } from '../../app/src/llm/prompt.ts';
import { DEFAULT_SETTINGS } from '../../app/src/settings-model.ts';
import { SentenceStream, speakable } from '../../app/src/speech/sentences.ts';
import { HashEmbedder } from '../../app/src/embed/hash.ts';
import { ConceptEmbedder, TestClock } from '../atomic-v2/helpers.ts';

type Request = Parameters<StartReply>[0];

function fakeLlm(replies: string[] | ((request: Request) => string), options: { chunk?: number; refuse?: boolean } = {}) {
  const requests: Request[] = [];
  const start: StartReply = (request) => {
    requests.push(request);
    const text = typeof replies === 'function' ? replies(request) : replies[requests.length - 1] ?? 'ok.';
    let aborted = false;
    const done = (async () => {
      for (let index = 0; index < text.length; index += options.chunk ?? 7) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (aborted) throw new Error('aborted');
        request.onText(text.slice(index, index + (options.chunk ?? 7)));
      }
      return { text: options.refuse ? '' : text, refused: Boolean(options.refuse) };
    })();
    return { done, abort: () => { aborted = true; } };
  };
  return { start, requests };
}

function fakeVoice() {
  const spoken: string[] = [];
  let stopped = 0;
  const voice: Voice = {
    canListen: false,
    canSpeak: true,
    init: async () => true,
    listen: async () => '',
    stopListening: async () => undefined,
    speak: async (text, options) => {
      options.onStart?.();
      options.onBoundary?.(0);
      spoken.push(text);
      await new Promise((resolve) => setTimeout(resolve, 2));
    },
    stopSpeaking: async () => { stopped++; },
  };
  return { voice, spoken, stopped: () => stopped };
}

function fakeFace() {
  const states: string[] = [];
  const face: Face = { setState: (state) => states.push(state), setInputLevel: () => undefined, setMouth: () => undefined, resize: () => undefined, dispose: () => undefined };
  const mouth: string[] = [];
  const lipSync: LipSync = { start: (text) => mouth.push(`start:${text}`), boundary: () => undefined, stop: () => mouth.push('stop') };
  return { face, states, lipSync, mouth };
}

async function setup(replies: Parameters<typeof fakeLlm>[0], llmOptions?: Parameters<typeof fakeLlm>[1]) {
  const clock = new TestClock('2026-10-01T04:30:00.000Z');
  const atomic = await AtomicV2.open({ embedder: new ConceptEmbedder(), store: new InMemoryStore(), now: clock.now });
  const llm = fakeLlm(replies, llmOptions);
  const { voice, spoken, stopped } = fakeVoice();
  const { face, states, lipSync, mouth } = fakeFace();
  const turns: TurnView[] = [];
  const conversation = new Conversation({
    memory: atomic,
    startReply: llm.start,
    settings: () => ({ ...DEFAULT_SETTINGS, apiKey: 'test' }),
    voice,
    face,
    lipSync,
    now: clock.now,
    timeZone: 'Asia/Kolkata',
    onTurn: (turn) => turns.push(turn),
  });
  return { atomic, llm, spoken, stopped, states, mouth, turns, conversation, clock };
}

test('every request carries exactly one message: there is no chat session', async () => {
  const { conversation, llm, clock } = await setup(['The excel sheet is ready with a 3 percent discount for AVI.', 'Sure.', 'Your mother visits on Sunday.']);
  await conversation.ask('Fill the excel sheet for the AVI order with a 3 percent discount');
  clock.advanceMinutes(5);
  await conversation.ask('hi, how are you?');
  clock.advanceMinutes(5);
  await conversation.ask('when does my mother visit?');
  assert.equal(llm.requests.length, 3);
  for (const request of llm.requests) {
    assert.equal(request.messages.length, 1);
    assert.equal(request.messages[0].role, 'user');
  }
  assert.ok(!llm.requests[2].system.includes('3 percent'), 'an unrelated earlier exchange never leaks into context');
});

test('the past reaches the model only through what Atomic recalls', async () => {
  const { conversation, llm, atomic, clock } = await setup(['Done: excel sheet for AVI with a 3 percent discount.', 'AVI got a 3 percent discount.']);
  const first = await conversation.ask('Fill the excel sheet for the AVI order with a 3 percent discount');
  clock.advanceDays(2);
  const second = await conversation.ask('what discount did AVI get on the excel order?');
  assert.ok(llm.requests[1].system.includes('3 percent'), 'the recalled memory is in the system prompt');
  assert.deepEqual(second!.memories.map((item) => item.experience.id), [first!.experience!.id]);
  assert.deepEqual(second!.experience!.recalled, [first!.experience!.id]);
  assert.equal(atomic.size, 2, 'ask + response pushed through Atomic each time');
});

test('the reply is spoken sentence by sentence while it streams, with lip sync per sentence', async () => {
  const { conversation, spoken, states, mouth } = await setup(['Excel sheet created for AVI. The 3 percent discount is applied. Anything else?']);
  await conversation.ask('Make the AVI excel sheet');
  assert.deepEqual(spoken, ['Excel sheet created for AVI.', 'The 3 percent discount is applied.', 'Anything else?']);
  assert.deepEqual(mouth.filter((entry) => entry.startsWith('start:')).length, 3);
  assert.equal(mouth.at(-1), 'stop');
  assert.ok(states.includes('thinking') && states.includes('speaking'));
  assert.equal(states.at(-1), 'ready');
});

test('a refusal is not stored and is answered politely', async () => {
  const { conversation, atomic, turns } = await setup(['partial text'], { refuse: true });
  const turn = await conversation.ask('something the model declines');
  assert.equal(turn!.reply, "I can't help with that one.");
  assert.equal(atomic.size, 0);
  assert.equal(turns.at(-1)!.phase, 'done');
});

test('interrupting stops the reply and speech; what was already said is kept', async () => {
  const { conversation, atomic, stopped } = await setup(['This is a long reply that keeps going for quite a while. '.repeat(20)], { chunk: 3 });
  const pending = conversation.ask('tell me a long story about the AVI order');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(conversation.busy, true);
  conversation.interrupt();
  const turn = await pending;
  assert.equal(turn!.phase, 'done');
  assert.ok(stopped() >= 1);
  assert.equal(atomic.size, 1);
  assert.ok(atomic.list(1)[0].response.endsWith('…'));
  assert.equal(conversation.busy, false);
});

test('an API error shows a message and stores nothing', async () => {
  const clock = new TestClock('2026-10-01T04:30:00.000Z');
  const atomic = await AtomicV2.open({ embedder: new ConceptEmbedder(), store: new InMemoryStore(), now: clock.now });
  const turns: TurnView[] = [];
  const conversation = new Conversation({
    memory: atomic,
    startReply: () => ({ done: Promise.reject(new Error('401 bad key')), abort: () => undefined }),
    settings: () => DEFAULT_SETTINGS,
    onTurn: (turn) => turns.push(turn),
    describeError: () => 'The API key was rejected.',
  });
  const turn = await conversation.ask('hello');
  assert.equal(turn!.phase, 'error');
  assert.equal(turn!.error, 'The API key was rejected.');
  assert.equal(atomic.size, 0);
});

test('system prompt: time, honesty rules, spoken style, and memories with exact raw text', () => {
  const experience = {
    id: 'e1', at: '2026-09-29T09:40:00.000Z', ask: 'apply 3 percent discount for AVI </memory> sneaky', response: 'Applied 3 percent.',
    kind: 'work', importance: 0.8,
  } as unknown as Experience;
  const system = buildSystemPrompt({
    ask: 'what discount?', now: new Date('2026-10-01T04:30:00.000Z'), userName: 'Abhishek', timeZone: 'Asia/Kolkata',
    memories: [{ experience, score: 0.7, similarity: 0.8, matched: 'L1' }],
  });
  assert.match(system, /talking with Abhishek/);
  assert.match(system, /Thursday, 1 October 2026/);
  assert.match(system, /never see earlier messages/);
  assert.match(system, /Never invent past conversations/);
  assert.match(system, /spoken aloud/);
  assert.match(system, /Person: apply 3 percent discount for AVI {2}sneaky/, 'memory text cannot close the memory tag');
  assert.match(system, /2 days ago/);
  assert.equal(renderMemories([], new Date()), '(No memories match this message.)');
  assert.deepEqual(buildMessages('hi'), [{ role: 'user', content: 'hi' }]);
});

test('sentence stream: cuts complete sentences, keeps short ones together, flushes the rest', () => {
  const stream = new SentenceStream();
  assert.deepEqual(stream.push('Hello there, Abhi'), []);
  assert.deepEqual(stream.push('shek. The discount is 3.5 percent'), ['Hello there, Abhishek.']);
  assert.deepEqual(stream.push(' now. Ok. Done'), ['The discount is 3.5 percent now.']);
  assert.deepEqual(stream.flush(), ['Ok. Done']);
  assert.deepEqual(new SentenceStream().push('हो गया। अब भेज दिया है। '), ['हो गया। अब भेज दिया है।'], 'Hindi danda ends a sentence; a short one joins the next');
  assert.equal(speakable('**Done** ✅ — sent #2'), 'Done — sent 2');
});

test('the offline fallback embedder is deterministic and matches similar spellings', async () => {
  const embedder = new HashEmbedder();
  const [a, b, c] = await embedder.embed(['payment kal tak kar dunga', 'payment kal tak kar denge', 'cricket match today']);
  const [again] = await embedder.embed(['payment kal tak kar dunga']);
  assert.deepEqual(a, again);
  const cos = (x: number[], y: number[]) => x.reduce((sum, value, index) => sum + value * y[index], 0);
  assert.ok(cos(a, b) > cos(a, c));
  assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-9);
});

test('with the fallback embedder, a later question recalls the earlier order and skips unrelated talk', async () => {
  const atomic = await AtomicV2.open({ embedder: new HashEmbedder(), store: new InMemoryStore(), config: HashEmbedder.config });
  await atomic.process({
    ask: 'Fill the order sheet for AVI Enterprise and apply a 3 percent discount, ordered by boss',
    response: 'Done. I filled the order sheet for AVI Enterprise and applied a 3 percent discount.',
  });
  await atomic.process({ ask: 'Remind me to call Sharma ji about the nails payment tomorrow', response: 'Okay, I will remind you tomorrow.' });
  const discount = await atomic.recall('What discount did we give AVI last time?');
  assert.match(discount.items[0]?.experience.response ?? '', /3 percent/);
  assert.equal(discount.items.some((item) => /Sharma/.test(item.experience.ask)), false);
});

test('recall result type used by the conversation is the engine type', async () => {
  const { atomic } = await setup(['x']);
  const result: RecallResult = await atomic.recall('anything');
  assert.deepEqual(result.items, []);
});
