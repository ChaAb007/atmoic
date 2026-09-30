import assert from 'node:assert/strict';
import test from 'node:test';
import type { Input } from '../../src/atomic/types.ts';
import { ABC_FUNDAMENTAL, makeEngine, TestClock } from './helpers.ts';

const TOPIC = 'payment order rate nails packing';

function input(raw: string, extra: Partial<Input['context']> = {}, participants = ['Nikhil', 'Vinod']): Input {
  return { context: { kind: 'user_user', topic: TOPIC, partyId: 'sharma-jaipur', dealId: 'oct-order', ...extra }, participants, raw };
}

test('record: the raw experience is stored word for word and cannot be changed', async () => {
  const { engine, storage } = makeEngine();
  const raw = 'Vinod: 3 ton wire nails chahiye\nVinod: chai pe kab aa rahe ho?';
  const result = await engine.process({ ...input(raw), id: 'exp-1' });
  const stored = (await storage.getExperience('exp-1'))!;
  assert.equal(stored.raw, raw);
  assert.equal(result.statements.length, 2);
  assert.throws(() => { (stored as { raw: string }).raw = 'changed'; }, TypeError);
  assert.throws(() => { stored.participants.push('someone'); }, TypeError);
  await assert.rejects(storage.appendExperience({ ...stored }), /already recorded/);
  assert.equal((await storage.getExperience('exp-1'))!.raw, raw);
});

test('pipeline: relevance, importance and level for a mixed chat', async () => {
  const { engine, storage } = makeEngine();
  const result = await engine.process(input([
    'Vinod: 3 ton wire nails chahiye 10 oct tak',
    'Vinod: pichhla payment 3.2 lakh 15 oct tak kar dunga',
    'Vinod: pichhli baar maal accha tha',
    'Vinod: chai pe kab aa rahe ho?',
  ].join('\n')));
  const levels = result.statements.map((statement) => statement.level);
  assert.deepEqual(levels, ['L1', 'L1', 'L2', 'L3']);
  const [order, payment, opinion, tea] = result.statements;
  assert.equal(order.kind, 'order');
  assert.equal(payment.kind, 'payment', 'kind is chosen per statement');
  assert.equal(payment.override, true);
  assert.ok(opinion.importance! < 0.5);
  assert.ok(tea.relevance < engine.config.relevanceThreshold);
  assert.equal(tea.kind, undefined, 'irrelevant lines never reach the classifier');
  assert.equal(storage.statementCount(), 4);
  assert.ok(!result.summary.includes('chai'), 'L4 summary is built from what matters');
  const promise = (await storage.getMemory(payment.memoryId))!;
  assert.equal(promise.dueAt, '2026-10-15');
  assert.equal(promise.facts.amount, 320000);
  assert.equal(promise.speaker, 'Vinod');
});

test('speaker prefix is only taken when the name is a participant', async () => {
  const { engine, storage } = makeEngine();
  const result = await engine.process(input('Rate: ₹78 pakka for wire nails'));
  assert.equal(result.statements[0].speaker, undefined);
  assert.equal((await storage.getMemory(result.statements[0].memoryId))!.content, 'Rate: ₹78 pakka for wire nails');
});

test('tentative suggestions stay in L2', async () => {
  const { engine } = makeEngine();
  const result = await engine.process(input('Vinod: maybe end of oct 2 ton bhej do'));
  assert.equal(result.statements[0].level, 'L2');
  assert.ok(result.statements[0].certainty! <= 0.5);
});

test('same party + deal with a changed fact: new replaces old, old is kept and linked', async () => {
  const { engine, storage } = makeEngine();
  const first = await engine.process(input('Nikhil: Sharma rate ₹74 pakka for wire nails', { dealId: 'rate-card' }, ['Nikhil']));
  const second = await engine.process(input('Nikhil: Sharma rate ₹78 pakka for wire nails', { dealId: 'rate-card' }, ['Nikhil']));
  const oldId = first.statements[0].memoryId;
  const newId = second.statements[0].memoryId;
  assert.equal(second.statements[0].change, 'update');
  assert.deepEqual(second.statements[0].replaced, [oldId]);
  const old = (await storage.getMemory(oldId))!;
  assert.equal(old.status, 'replaced');
  assert.equal(old.replacedBy, newId);
  assert.equal(old.facts.rate, 74, 'the old fact is kept, not overwritten');
  assert.ok(storage.allLinks().some((link) => link.kind === 'replaces' && link.from === newId && link.to === oldId));
  const recall = await engine.recall({ kind: 'user_user', topic: TOPIC, partyId: 'sharma-jaipur' }, 'rate wahi wire nails');
  assert.deepEqual(recall.memories.filter((memory) => memory.facts.rate !== undefined).map((memory) => memory.facts.rate), [78]);
});

test('a new deal with the same party links as similar and replaces nothing', async () => {
  const { engine, storage } = makeEngine();
  const first = await engine.process(input('Vinod: 3 ton wire nails chahiye 10 oct tak', { dealId: 'oct-order' }));
  const second = await engine.process(input('Vinod: 4 ton wire nails chahiye 10 nov tak', { dealId: 'nov-order' }));
  assert.deepEqual(second.statements[0].replaced, []);
  assert.equal((await storage.getMemory(first.statements[0].memoryId))!.status, 'active');
  assert.ok(second.links.some((link) => link.to === first.experienceId && link.kind === 'similar'));
});

test('same deal links as same_deal; unrelated experiences are not linked', async () => {
  const { engine } = makeEngine();
  const first = await engine.process(input('Vinod: 3 ton wire nails chahiye 10 oct tak'));
  const second = await engine.process(input('Vinod: 3 ton wire nails dispatch kab?'));
  assert.ok(second.links.some((link) => link.to === first.experienceId && link.kind === 'same_deal'));
  const unrelated = await engine.process(input('Deepak: machine header ka die toot gaya', { partyId: 'plant', dealId: undefined }, ['Deepak']));
  assert.equal(unrelated.links.length, 0);
});

test('a different item under the same deal is not a replacement', async () => {
  const { engine, storage } = makeEngine();
  const nails = await engine.process(input('Nikhil: rate ₹78 pakka for wire nails', { dealId: 'rate-card' }, ['Nikhil']));
  await engine.process(input('Nikhil: rate ₹92 pakka for panel pins', { dealId: 'rate-card' }, ['Nikhil']));
  assert.equal((await storage.getMemory(nails.statements[0].memoryId))!.status, 'active');
});

test('repeating a fact strengthens the existing memory, but only after sync', async () => {
  const { engine, storage } = makeEngine();
  const first = await engine.process(input('Nikhil: rate ₹78 pakka for wire nails', { dealId: 'rate-card' }, ['Nikhil']));
  const second = await engine.process(input('Nikhil: rate ₹78 pakka for wire nails', { dealId: 'rate-card' }, ['Nikhil']));
  assert.equal(second.statements[0].change, 'repeat');
  const id = first.statements[0].memoryId;
  assert.equal((await storage.getMemory(id))!.strength, 0.5);
  assert.equal(await engine.pendingLearning(), 1);
  await engine.sync();
  assert.ok((await storage.getMemory(id))!.strength > 0.5);
  assert.equal(await engine.pendingLearning(), 0);
});

test('recall climbs L1 -> L2 only when L1 has nothing close enough', async () => {
  const { engine } = makeEngine();
  await engine.process(input('Vinod: order 800 kg wire nails pakka\nVinod: packing 25 kg bags aur 5 kg boxes', { partyId: 'balaji', dealId: 'jun-order' }));
  const packing = await engine.recall({ kind: 'user_user', topic: TOPIC, partyId: 'balaji' }, 'pichhli baar packing kaunsi thi?');
  assert.equal(packing.climbedTo, 'L2');
  assert.ok(packing.memories.some((memory) => memory.content.includes('packing')));
  const order = await engine.recall({ kind: 'user_user', topic: 'order nails', partyId: 'balaji' }, 'order wire nails');
  assert.equal(order.climbedTo, 'L1');
});

test('recall reaches L3 when nothing above answers the question', async () => {
  const { engine } = makeEngine();
  await engine.process(input('Vinod: order 800 kg wire nails pakka\nVinod: kal cricket match hai, India jeetega', { partyId: 'balaji' }));
  const result = await engine.recall({ kind: 'user_user', topic: 'cricket', partyId: 'balaji' }, 'cricket match');
  assert.equal(result.climbedTo, 'L3');
  assert.ok(result.memories.some((memory) => memory.level === 'L3'));
});

test('recall stays inside the requested parties', async () => {
  const { engine } = makeEngine();
  await engine.process(input('Vinod: 3 ton wire nails chahiye', { partyId: 'sharma-jaipur' }));
  await engine.process(input('Amit: 300 kg panel pins chahiye', { partyId: 'sharma-delhi' }, ['Nikhil', 'Amit']));
  const delhi = await engine.recall({ kind: 'user_user', topic: TOPIC, partyId: 'sharma-delhi' }, 'order');
  assert.ok(delhi.memories.length > 0);
  assert.ok(delhi.memories.every((memory) => memory.partyId === 'sharma-delhi'));
  const both = await engine.recall({ kind: 'user_user', topic: TOPIC, partyIds: ['sharma-delhi', 'sharma-jaipur'] }, 'order');
  assert.deepEqual(new Set(both.memories.map((memory) => memory.partyId)), new Set(['sharma-delhi', 'sharma-jaipur']));
});

test('recall is read-only: no strength, link or learning changes', async () => {
  const { engine, storage } = makeEngine();
  const first = await engine.process(input('Vinod: 3 ton wire nails chahiye'));
  await engine.process(input('Vinod: 3 ton wire nails dispatch kab?'));
  const pendingBefore = await engine.pendingLearning();
  const linksBefore = JSON.stringify(storage.allLinks());
  const memoryBefore = JSON.stringify(await storage.getMemory(first.statements[0].memoryId));
  for (let index = 0; index < 5; index++) await engine.recall({ kind: 'user_user', topic: TOPIC, partyId: 'sharma-jaipur' }, 'wire nails');
  assert.equal(JSON.stringify(storage.allLinks()), linksBefore);
  assert.equal(JSON.stringify(await storage.getMemory(first.statements[0].memoryId)), memoryBefore);
  assert.equal(await engine.pendingLearning(), pendingBefore);
});

test('recall ranks recent, strongly linked experiences first', async () => {
  const clock = new TestClock('2026-06-01T09:00:00.000Z');
  const { engine } = makeEngine({ clock });
  const old = await engine.process(input('Vinod: 3 ton wire nails chahiye', { dealId: 'jun' }));
  clock.set('2026-10-01T09:00:00.000Z');
  const recent = await engine.process(input('Vinod: 3 ton wire nails chahiye', { dealId: 'oct' }));
  const result = await engine.recall({ kind: 'user_user', topic: TOPIC, partyId: 'sharma-jaipur' }, '3 ton wire nails');
  assert.equal(result.experiences[0].experienceId, recent.experienceId);
  assert.ok(result.experiences.some((item) => item.experienceId === old.experienceId));
});

test('track record lowers certainty of the next promise; the override still keeps it in L1', async () => {
  const clock = new TestClock('2026-09-01T09:00:00.000Z');
  const { engine } = makeEngine({ clock });
  for (const day of ['05 sep', '12 sep', '19 sep']) {
    await engine.process(input(`Vinod: payment 1 lakh ${day} tak kar dunga`, { dealId: `dues-${day}` }));
  }
  clock.set('2026-09-25T09:00:00.000Z');
  const due = await engine.dueCheck();
  assert.equal(due.broken.length, 3);
  await engine.sync();
  const next = await engine.process(input('Vinod: payment 1 lakh 05 oct tak kar dunga', { dealId: 'dues-oct' }));
  const promise = next.statements[0];
  assert.ok(Math.abs(promise.certainty! - 2 / 5) < 1e-9, `certainty ${promise.certainty}`);
  assert.ok(promise.importance! < 0.5);
  assert.equal(promise.level, 'L1');
  assert.equal(promise.override, true);
});

test('due check: paid in full before the date is fulfilled; late, partial or missing is broken', async () => {
  const clock = new TestClock('2026-10-01T09:00:00.000Z');
  const { engine, storage } = makeEngine({ clock });
  const promise = (party: string) => engine.process(input('Vinod: payment 2 lakh 05 oct tak kar dunga', { partyId: party, dealId: 'dues' }));
  const paid = await promise('on-time');
  const late = await promise('late');
  const partial = await promise('partial');
  const none = await promise('none');
  const pay = (party: string, day: string, lakh: number) => engine.process({
    context: { kind: 'event', topic: TOPIC, partyId: party, dealId: 'dues' },
    participants: ['bank'], raw: `NEFT ${lakh} lakh received`, occurredAt: `2026-10-${day}T10:00:00.000Z`,
    event: { type: 'payment_received', facts: { amount: lakh * 100_000 } },
  });
  await pay('on-time', '04', 2);
  await pay('late', '09', 2);
  await pay('partial', '04', 1);

  clock.set('2026-10-05T17:00:00.000Z');
  assert.deepEqual(await engine.dueCheck(), { fulfilled: [], broken: [] }, 'not due until the day is over (22:30 in India)');

  clock.set('2026-10-06T09:00:00.000Z');
  const result = await engine.dueCheck();
  assert.deepEqual(result.fulfilled, [paid.statements[0].memoryId]);
  assert.deepEqual(new Set(result.broken), new Set([late, partial, none].map((item) => item.statements[0].memoryId)));
  assert.equal((await storage.getMemory(paid.statements[0].memoryId))!.status, 'fulfilled');
  assert.ok(storage.allLinks().some((link) => link.kind === 'promise_outcome' && link.from === paid.statements[0].memoryId));
  assert.deepEqual(await engine.dueCheck(), { fulfilled: [], broken: [] }, 'each promise is checked once');

  assert.equal(await storage.getTrackRecord('on-time', 'commit'), undefined, 'track records wait for sync');
  await engine.sync();
  assert.deepEqual(await storage.getTrackRecord('on-time', 'commit'), { subject: 'on-time', intent: 'commit', kept: 1, total: 1 });
  assert.deepEqual(await storage.getTrackRecord('late', 'commit'), { subject: 'late', intent: 'commit', kept: 0, total: 1 });
});

test('ask or act: Fundamental first, then last outcome, then strength', async () => {
  const clock = new TestClock('2026-10-01T09:00:00.000Z');
  const { engine, storage } = makeEngine({ clock });
  const result = await engine.process(input('Nikhil: Gupta dispatch friday se pehle pakka 600 kg panel pins', { partyId: 'gupta', dealId: 'dispatch-rule' }, ['Nikhil']));
  const id = result.statements[0].memoryId;

  assert.equal((await engine.askOrAct({ action: 'credit_terms', partyId: 'verma' })).mode, 'WARN');
  assert.equal((await engine.askOrAct({ action: 'credit_terms', partyId: 'gupta' })).mode, 'ASK');
  assert.equal((await engine.askOrAct({ action: 'discount', memoryId: id })).mode, 'ASK');
  assert.equal((await engine.askOrAct({ action: 'dispatch', memoryId: 'missing' })).mode, 'ASK');
  assert.equal((await engine.askOrAct({ action: 'dispatch' })).mode, 'ASK');
  assert.equal((await engine.askOrAct({ action: 'dispatch', memoryId: id })).mode, 'ASK', 'new memory is weak');

  for (let index = 0; index < 4; index++) await engine.feedback('memory', id, 'confirmed');
  assert.equal((await engine.askOrAct({ action: 'dispatch', memoryId: id })).mode, 'ASK', 'learning waits for sync');
  await engine.sync();
  assert.equal((await engine.askOrAct({ action: 'dispatch', memoryId: id })).mode, 'ACT_AND_TELL');

  clock.advanceDays(120);
  assert.equal((await engine.askOrAct({ action: 'dispatch', memoryId: id })).mode, 'ASK', 'unused memory fades');

  await engine.recordOutcome(id, false);
  assert.equal((await storage.getMemory(id))!.lastOutcome, 'bad', 'the outcome itself lands immediately');
  assert.equal((await engine.askOrAct({ action: 'dispatch', memoryId: id })).mode, 'WARN');
});

test('ask or act works on links too', async () => {
  const { engine, storage } = makeEngine();
  await engine.process(input('Vinod: 3 ton wire nails chahiye'));
  const second = await engine.process(input('Vinod: 3 ton wire nails dispatch kab?'));
  const link = second.links[0];
  assert.equal((await engine.askOrAct({ action: 'reorder', linkId: link.id })).mode, 'ASK');
  for (let index = 0; index < 6; index++) await engine.feedback('link', link.id, 'confirmed');
  await engine.sync();
  assert.ok((await storage.getLinkById(link.id))!.strength > 0.75);
  assert.equal((await engine.askOrAct({ action: 'reorder', linkId: link.id })).mode, 'ACT_AND_TELL');
  assert.equal((await engine.askOrAct({ action: 'reorder', linkId: 'missing' })).mode, 'ASK');
});

test('Fundamental: only the owner changes it, it is frozen, and learning never touches it', async () => {
  const { engine } = makeEngine();
  assert.throws(() => engine.setFundamental({ ...ABC_FUNDAMENTAL, advanceOnly: [] }, 'Nikhil'), /only Rakesh/);
  assert.throws(() => { (engine.fundamental.advanceOnly as string[]).push('x'); }, TypeError);
  const before = JSON.stringify(engine.fundamental);
  await engine.process(input('Vinod: payment 1 lakh 05 oct tak kar dunga'));
  await engine.sync();
  assert.equal(JSON.stringify(engine.fundamental), before);
  const next = engine.setFundamental({ ...ABC_FUNDAMENTAL, advanceOnly: [] }, 'Rakesh');
  assert.equal(next.version, 2);
  assert.equal((await engine.askOrAct({ action: 'credit_terms', partyId: 'verma' })).mode, 'ASK');
});

test('missed and dismissed move levels now and weights at sync', async () => {
  const { engine, storage } = makeEngine();
  const result = await engine.process(input('Vinod: pichhli baar maal accha tha'));
  const id = result.statements[0].memoryId;
  assert.equal(result.statements[0].level, 'L2');
  await engine.reportMissed(id);
  assert.equal((await storage.getMemory(id))!.level, 'L1');
  assert.equal(await storage.getWeights(), undefined, 'weights wait for sync');
  await engine.sync();
  const raised = (await storage.getWeights())!;
  assert.ok(raised.order.emotion > 1 && raised.order.trust > 1);
  await engine.dismiss(id);
  assert.equal((await storage.getMemory(id))!.level, 'L2');
  await engine.sync();
  assert.equal((await storage.getWeights())!.order.trust, 1);
  await assert.rejects(engine.reportMissed('missing'), /not found/);
  await assert.rejects(engine.dismiss('missing'), /not found/);
});

test('per-business weights change later scoring', async () => {
  const { engine, storage } = makeEngine();
  const before = await engine.process(input('Vinod: pichhli baar maal accha tha'));
  const id = before.statements[0].memoryId;
  for (let index = 0; index < 8; index++) await engine.reportMissed(id);
  await engine.sync();
  const after = await engine.process(input('Vinod: pichhli baar maal accha tha'));
  assert.ok(after.statements[0].importance! > before.statements[0].importance!);
  assert.ok((await storage.getWeights())!.order.trust <= 5);
});

test('fast path: onInput returns recall before the layers run; drain runs them', async () => {
  const { engine, storage } = makeEngine();
  await engine.process(input('Vinod: 3 ton wire nails chahiye'));
  const { experienceId, recall } = await engine.onInput(input('Vinod: rate wahi, 3 ton wire nails bhej do'));
  assert.ok(recall.memories.length > 0);
  assert.ok(recall.memories.every((memory) => memory.experienceId !== experienceId), 'recall only sees the past');
  const processed = await engine.drain();
  assert.equal(processed.length, 1);
  assert.equal(processed[0].experienceId, experienceId);
  assert.ok(await storage.getExperience(experienceId));
  assert.deepEqual(await engine.drain(), []);
});

test('a failing model does not stop the queue', async () => {
  const { engine, classifier, storage } = makeEngine();
  const original = classifier.classify.bind(classifier);
  classifier.classify = async (request) => {
    if (request.text.includes('explode')) throw new Error('model down');
    return original(request);
  };
  await engine.onInput(input('Vinod: 3 ton wire nails chahiye explode'));
  const { experienceId } = await engine.onInput(input('Vinod: 2 ton panel pins chahiye'));
  await engine.drain();
  assert.equal(engine.errors.length, 1);
  assert.match(engine.errors[0].message, /model down/);
  assert.ok(await storage.getExperience(experienceId));
});

test('business events are recorded as experience like any conversation', async () => {
  const { engine, storage } = makeEngine();
  const result = await engine.process({
    context: { kind: 'event', topic: TOPIC, partyId: 'sharma-jaipur', dealId: 'dues' },
    participants: ['bank'], raw: 'NEFT 2 lakh received', event: { type: 'payment_received', facts: { amount: 200000 } },
  });
  const stored = (await storage.getExperience(result.experienceId))!;
  assert.equal(stored.event?.type, 'payment_received');
  assert.equal(stored.context.kind, 'event');
});
