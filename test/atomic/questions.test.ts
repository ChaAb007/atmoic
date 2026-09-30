import assert from 'node:assert/strict';
import test from 'node:test';
import type { Directory, Input, Viewer } from '../../src/atomic/types.ts';
import { makeEngine, TestClock } from './helpers.ts';

/** ABC owner assigns a sales order to Amit; in the evening the owner asks from the phone app. Times are UTC (IST - 5:30). */
const TOPIC = 'payment order rate nails dispatch';
const OWNER: Viewer = { id: 'Rakesh', role: 'owner' };
const DIRECTORY: Directory = {
  parties: [
    { id: 'avi', names: ['AVI', 'AVI Pvt Ltd'] },
    { id: 'gupta', names: ['Gupta'] },
  ],
  people: [{ id: 'Amit', names: ['Amit'] }, { id: 'Rakesh', names: ['Rakesh'] }],
  actions: [{ id: 'order_created', words: ['created the order', 'created the SO', 'order bana', 'SO bana'] }],
};
const QUESTION = 'Has Amit created the order for AVI today? share details';

function soTask(at: string, so: string, tons: number, delivery: string, sent = true): Input {
  const lines = [
    `Amit: AVI ke liye ${tons} ton wire nails ka SO bana do rate ₹78`,
    `order-agent: ${so} created for AVI Pvt Ltd, ${tons} ton wire nails, ₹78/kg, delivery ${delivery}`,
  ];
  if (sent) lines.push(`order-agent: ${so} sent to AVI Pvt Ltd on email`);
  return {
    context: { kind: 'agent_task', topic: TOPIC, partyId: 'avi', dealId: so },
    participants: ['Amit', 'order-agent'], raw: lines.join('\n'), occurredAt: at,
  };
}

function setup() {
  const clock = new TestClock('2026-10-01T04:30:00.000Z');
  return { clock, ...makeEngine({ clock, directory: DIRECTORY }) };
}

test('AVI in the system: "OK sir" becomes Amit\'s commitment due today, and the SO closes it', async () => {
  const { engine, clock, storage } = setup();
  const chat = await engine.process({
    context: { kind: 'user_user', topic: TOPIC, partyId: 'avi' },
    participants: ['Rakesh', 'Amit'],
    raw: 'Rakesh: Amit, please make a SO for today for AVI Pvt Ltd 3 ton nails\nAmit: OK sir',
    occurredAt: '2026-10-01T04:30:00.000Z',
  });
  const [instruction, ok] = chat.statements;
  assert.equal(instruction.level !== 'L3', true);
  assert.equal(instruction.facts!.date, '2026-10-01', '"today" is stored as a real date');
  assert.equal(ok.level, 'L1', '"OK sir" is judged with the line it answers');
  assert.equal(ok.replyTo, instruction.text);
  assert.equal(ok.facts!.qty, 3);
  const commitment = (await storage.getMemory(ok.memoryId))!;
  assert.equal(commitment.intent, 'commit');
  assert.equal(commitment.dueAt, '2026-10-01');

  clock.set('2026-10-01T07:00:00.000Z');
  const task = await engine.process(soTask('2026-10-01T07:00:00.000Z', 'SO-1041', 3, '03 oct'));
  const [, created, sent] = task.statements;
  assert.equal(created.level, 'L1');
  assert.equal(created.action, 'order_created');
  assert.equal(sent.level, 'L1', 'the proof it was sent is not thrown away');
  assert.equal(sent.action, 'order_sent');

  clock.set('2026-10-01T13:30:00.000Z');
  const answer = await engine.recall({ kind: 'user_agent', topic: TOPIC }, QUESTION, { viewer: OWNER });
  assert.equal(answer.found, true);
  assert.deepEqual(answer.scope, { partyIds: ['avi'], actor: 'Amit', action: 'order_created', from: '2026-10-01', to: '2026-10-01' });
  const contents = answer.memories.map((memory) => memory.content);
  assert.ok(contents.some((text) => text.includes('SO-1041 created')));
  assert.ok(contents.some((text) => text.includes('SO-1041 sent')));

  clock.set('2026-10-01T19:00:00.000Z');
  const due = await engine.dueCheck();
  assert.deepEqual(due.fulfilled, [ok.memoryId]);
  assert.ok(storage.allLinks().some((link) => link.kind === 'promise_outcome' && link.from === ok.memoryId && link.to === task.experienceId));
});

test('AVI outside the system, Amit did it: only today\'s SO, never last week\'s', async () => {
  const { engine, clock } = setup();
  clock.set('2026-09-24T07:00:00.000Z');
  await engine.process(soTask('2026-09-24T07:00:00.000Z', 'SO-0987', 2, '26 sep', false));
  clock.set('2026-10-01T07:00:00.000Z');
  await engine.process(soTask('2026-10-01T07:00:00.000Z', 'SO-1041', 3, '03 oct'));
  clock.set('2026-10-01T13:30:00.000Z');
  const answer = await engine.recall({ kind: 'user_agent', topic: TOPIC }, QUESTION, { viewer: OWNER });
  assert.equal(answer.found, true);
  assert.ok(answer.memories.length > 0);
  assert.ok(answer.memories.every((memory) => memory.content.includes('SO-1041') || memory.content.includes('3 ton')));
  assert.ok(answer.memories.every((memory) => !memory.content.includes('SO-0987')));
});

test('AVI outside the system, Amit did not do it: an explicit "no", with last week\'s SO shown as the nearest', async () => {
  const { engine, clock } = setup();
  clock.set('2026-09-24T07:00:00.000Z');
  await engine.process(soTask('2026-09-24T07:00:00.000Z', 'SO-0987', 2, '26 sep', false));
  clock.set('2026-10-01T13:30:00.000Z');
  const answer = await engine.recall({ kind: 'user_agent', topic: TOPIC }, QUESTION, { viewer: OWNER });
  assert.equal(answer.found, false);
  assert.deepEqual(answer.memories, []);
  assert.ok(answer.nearest!.some((memory) => memory.content.includes('SO-0987')));
  assert.equal(answer.nearest![0].occurredAt, '2026-09-24T07:00:00.000Z');
});

test('the same question in Hinglish is scoped the same way', async () => {
  const { engine, clock } = setup();
  clock.set('2026-10-01T07:00:00.000Z');
  await engine.process(soTask('2026-10-01T07:00:00.000Z', 'SO-1041', 3, '03 oct'));
  clock.set('2026-10-01T13:30:00.000Z');
  const answer = await engine.recall({ kind: 'user_agent', topic: TOPIC }, 'Amit ne aaj AVI ka order bana diya?', { viewer: OWNER });
  assert.deepEqual(answer.scope, { partyIds: ['avi'], actor: 'Amit', action: 'order_created', from: '2026-10-01', to: '2026-10-01' });
  assert.equal(answer.found, true);
});

test('"kal kya hua tha" and "last week" scope recall by date', async () => {
  const { engine, clock } = setup();
  clock.set('2026-09-24T07:00:00.000Z');
  await engine.process(soTask('2026-09-24T07:00:00.000Z', 'SO-0987', 2, '26 sep'));
  clock.set('2026-09-30T07:00:00.000Z');
  await engine.process(soTask('2026-09-30T07:00:00.000Z', 'SO-1030', 1, '02 oct'));
  clock.set('2026-10-01T13:30:00.000Z');
  const yesterday = await engine.recall({ kind: 'user_agent', topic: TOPIC, partyId: 'avi' }, 'kal kya hua tha?', { viewer: OWNER });
  assert.deepEqual([yesterday.scope.from, yesterday.scope.to], ['2026-09-30', '2026-09-30']);
  assert.ok(yesterday.memories.length > 0 && yesterday.memories.every((memory) => memory.occurredAt.startsWith('2026-09-30')));
  const lastWeek = await engine.recall({ kind: 'user_agent', topic: TOPIC, partyId: 'avi' }, 'last week AVI ke orders', { viewer: OWNER });
  assert.deepEqual([lastWeek.scope.from, lastWeek.scope.to], ['2026-09-21', '2026-09-27']);
  assert.ok(lastWeek.memories.length > 0 && lastWeek.memories.every((memory) => memory.occurredAt.startsWith('2026-09-24')));
});

test('a name that matches two parties asks which one; with one match it is exact', async () => {
  const twoSharmas: Directory = {
    parties: [{ id: 'sharma-jaipur', names: ['Sharma', 'Sharma Hardware'] }, { id: 'sharma-delhi', names: ['Sharma', 'Sharma Traders'] }],
  };
  const { engine } = makeEngine({ directory: twoSharmas });
  const ask = await engine.recall({ kind: 'user_agent', topic: TOPIC }, 'Sharma ji ka order kya hua?');
  assert.equal(ask.found, false);
  assert.deepEqual(ask.ambiguous, [{ kind: 'party', ids: ['sharma-jaipur', 'sharma-delhi'] }]);
  const exact = await engine.recall({ kind: 'user_agent', topic: TOPIC }, 'Sharma Traders ka order kya hua?');
  assert.equal(exact.ambiguous, undefined);
  assert.deepEqual(exact.scope.partyIds, ['sharma-delhi'], 'the more specific name wins');
});

test('access by role: owner sees all, staff their own work and parties, externals only their own chats', async () => {
  const { engine, clock } = setup();
  clock.set('2026-10-01T07:00:00.000Z');
  await engine.process(soTask('2026-10-01T07:00:00.000Z', 'SO-1041', 3, '03 oct'));
  await engine.process({
    context: { kind: 'user_user', topic: TOPIC, partyId: 'gupta', dealId: 'g-1' },
    participants: ['Nikhil', 'Gupta'], raw: 'Gupta: 600 kg panel pins chahiye friday se pehle', occurredAt: '2026-10-01T07:30:00.000Z',
  });
  clock.set('2026-10-01T13:30:00.000Z');
  const ask = (viewer: Viewer) => engine.recall({ kind: 'user_agent', topic: TOPIC }, 'aaj kya hua?', { viewer });
  const parties = async (viewer: Viewer) => new Set((await ask(viewer)).memories.map((memory) => memory.partyId));

  assert.deepEqual(await parties(OWNER), new Set(['avi', 'gupta']));
  assert.deepEqual(await parties({ id: 'Amit', role: 'staff' }), new Set(['avi']));
  assert.deepEqual(await parties({ id: 'Amit', role: 'staff', parties: ['gupta'] }), new Set(['avi', 'gupta']));
  assert.deepEqual(await parties({ id: 'Gupta', role: 'external', parties: ['avi'] }), new Set(['gupta']));
  const outsider = await ask({ id: 'Stranger', role: 'external' });
  assert.equal(outsider.found, false);

  const similarity = await engine.recall({ kind: 'user_agent', topic: TOPIC }, 'panel pins', { viewer: { id: 'Amit', role: 'staff' } });
  assert.ok(similarity.memories.every((memory) => memory.partyId !== 'gupta'), 'the unscoped path is filtered too');
});

test('incoming messages are not questions: "kal bhej do" does not narrow recall to tomorrow', async () => {
  const { engine, clock } = setup();
  clock.set('2026-09-24T07:00:00.000Z');
  await engine.process(soTask('2026-09-24T07:00:00.000Z', 'SO-0987', 2, '26 sep'));
  clock.set('2026-10-01T07:00:00.000Z');
  const { recall } = await engine.onInput({
    context: { kind: 'user_user', topic: TOPIC, partyId: 'avi' }, participants: ['Nikhil', 'Buyer'], raw: 'Buyer: wahi order kal bhej do',
  });
  assert.equal(recall.scope.from, undefined);
  assert.ok(recall.memories.length > 0);
  await engine.drain();
});

test('business events always reach L1 and carry their type as the action', async () => {
  const { engine } = setup();
  const result = await engine.process({
    context: { kind: 'event', topic: TOPIC, partyId: 'avi', dealId: 'dues' },
    participants: ['bank'], raw: 'UTR 88123 credited', event: { type: 'payment_received', facts: { amount: 234000 } },
  });
  assert.equal(result.statements[0].level, 'L1');
  assert.equal(result.statements[0].action, 'payment_received');
});

test('dates resolve against when the words were said, not when they are processed', async () => {
  const { engine, clock } = setup();
  clock.set('2026-10-01T07:00:00.000Z');
  const late = await engine.process({
    context: { kind: 'user_user', topic: TOPIC, partyId: 'avi', dealId: 'd' }, participants: ['Nikhil', 'Buyer'],
    raw: 'Buyer: payment 1 lakh kal kar denge', occurredAt: '2026-09-24T07:00:00.000Z',
  });
  assert.equal(late.statements[0].facts!.date, '2026-09-25');
  assert.equal(late.statements[0].facts!.datePhrase, 'kal');
});

test('vague time words stay unresolved: no made-up due date, but the promise is still kept in L1', async () => {
  const { engine, storage } = setup();
  const result = await engine.process({
    context: { kind: 'user_user', topic: TOPIC, partyId: 'avi', dealId: 'd' }, participants: ['Nikhil', 'Buyer'],
    raw: 'Buyer: payment 1 lakh jaldi kar denge',
  });
  const memory = (await storage.getMemory(result.statements[0].memoryId))!;
  assert.equal(memory.facts.dateUnresolved, true);
  assert.equal(memory.dueAt, undefined);
  assert.equal(memory.level, 'L1');
});

test('a short reply that is not an answer to anyone stays a normal statement', async () => {
  const { engine } = setup();
  const result = await engine.process({
    context: { kind: 'user_user', topic: TOPIC, partyId: 'avi' }, participants: ['Nikhil', 'Buyer'], raw: 'Buyer: OK sir',
  });
  assert.equal(result.statements[0].replyTo, undefined);
  assert.equal(result.statements[0].level, 'L3');
});
