import assert from 'node:assert/strict';
import test from 'node:test';
import type { Input } from '../../src/atomic/types.ts';
import { makeEngine, TestClock } from './helpers.ts';

/**
 * ABC Enterprises (nails and pins, Ghaziabad): a compressed run of the October stress test.
 * Parties: sharma-jaipur, sharma-delhi, gupta, verma, mehta, balaji. The agent listens and gives input from memory.
 */
const TOPIC = 'payment order rate nails packing dispatch';

function chat(partyId: string, dealId: string | undefined, raw: string, participants: string[]): Input {
  return { context: { kind: 'user_user', topic: TOPIC, partyId, dealId }, participants, raw };
}

test('ABC: the October stress test runs end to end', async () => {
  const clock = new TestClock('2026-07-01T09:00:00.000Z');
  const { engine, storage } = makeEngine({ clock });

  // July: Sharma Jaipur rate goes from 74 to 78 (same party + deal -> replaced).
  await engine.process(chat('sharma-jaipur', 'rate-card', 'Nikhil: rate ₹74 pakka for wire nails', ['Nikhil']));
  clock.set('2026-07-20T09:00:00.000Z');
  const hike = await engine.process(chat('sharma-jaipur', 'rate-card', 'Nikhil: rate ₹78 pakka for wire nails', ['Nikhil']));
  assert.equal(hike.statements[0].replaced!.length, 1);

  // Sharma Delhi buys panel pins at 92: a different party, nothing replaced.
  await engine.process(chat('sharma-delhi', 'rate-card', 'Nikhil: rate ₹92 pakka for panel pins', ['Nikhil']));

  // June-style detail kept only in L2 for Balaji.
  await engine.process(chat('balaji', 'jun-order', 'Ravi: order 800 kg wire nails pakka\nRavi: packing 25 kg bags aur 5 kg boxes', ['Nikhil', 'Ravi']));

  // Sharma Jaipur breaks three payment promises in August / September.
  for (const [day, deal] of [['05 aug', 'dues-aug'], ['05 sep', 'dues-sep'], ['20 sep', 'dues-sep2']]) {
    clock.set('2026-08-01T09:00:00.000Z');
    await engine.process(chat('sharma-jaipur', deal, `Vinod: payment 1 lakh ${day} tak kar denge`, ['Suresh', 'Vinod']));
  }
  clock.set('2026-09-30T09:00:00.000Z');
  assert.equal((await engine.dueCheck()).broken.length, 3);
  await engine.sync();

  // 1 Oct: "rate wahi" -> recall returns 78, never the replaced 74, and never Delhi's 92.
  clock.set('2026-10-01T09:00:00.000Z');
  const oct1 = await engine.onInput(chat('sharma-jaipur', 'oct-order', 'Vinod: 3 ton wire nails bhej do, rate wahi', ['Nikhil', 'Vinod']));
  const rates = oct1.recall.memories.map((memory) => memory.facts.rate).filter((rate) => rate !== undefined);
  assert.deepEqual(rates, [78]);
  await engine.drain();

  // Two Sharmas: recall for Delhi never shows Jaipur.
  const delhi = await engine.recall({ kind: 'user_user', topic: TOPIC, partyId: 'sharma-delhi' }, 'rate');
  assert.ok(delhi.memories.length > 0 && delhi.memories.every((memory) => memory.partyId === 'sharma-delhi'));

  // 5 Oct: Sharma promises again; certainty reflects 0 of 3 kept, override keeps it in L1.
  clock.set('2026-10-05T09:00:00.000Z');
  const promise = await engine.process(chat('sharma-jaipur', 'dues-oct', 'Vinod: payment 3.2 lakh 12 oct tak kar denge', ['Suresh', 'Vinod']));
  assert.equal(promise.statements[0].level, 'L1');
  assert.ok(promise.statements[0].certainty! < 0.5);

  // Festival group: greetings stay in L3, the one order hint is kept.
  const greetings = Array.from({ length: 20 }, (_, index) => `Customer${index}: Happy Dhanteras 😄`);
  const group = await engine.process(chat('broadcast', undefined, [...greetings, 'Khan: diwali ke baad maybe 2 ton roofing nails chahiye'].join('\n'), ['Rakesh', 'Khan', ...greetings.map((line) => line.split(':')[0])]));
  const l3 = group.statements.filter((statement) => statement.level === 'L3').length;
  assert.equal(l3, 20);
  assert.equal(group.statements.at(-1)!.level !== 'L3', true);

  // Verma asks for credit: Fundamental wins.
  assert.equal((await engine.askOrAct({ action: 'credit_terms', partyId: 'verma' })).mode, 'WARN');

  // Gupta "before Friday" becomes act-and-tell only after confirmations and a sync.
  const gupta = await engine.process(chat('gupta', 'dispatch-rule', 'Nikhil: Gupta dispatch friday se pehle pakka 600 kg panel pins', ['Nikhil']));
  const rule = gupta.statements[0].memoryId;
  assert.equal((await engine.askOrAct({ action: 'dispatch', memoryId: rule })).mode, 'ASK');
  for (let week = 0; week < 4; week++) await engine.feedback('memory', rule, 'confirmed');
  await engine.sync();
  assert.equal((await engine.askOrAct({ action: 'dispatch', memoryId: rule })).mode, 'ACT_AND_TELL');

  // Mehta changes 4 ton to 5 ton on the same deal: replaced, old kept.
  const mehta4 = await engine.process(chat('mehta', 'diwali-order', 'Mehta: 4 ton panel pins final 20 oct tak', ['Nikhil', 'Mehta']));
  const mehta5 = await engine.process(chat('mehta', 'diwali-order', 'Mehta: 5 ton panel pins final 20 oct tak', ['Nikhil', 'Mehta']));
  assert.deepEqual(mehta5.statements[0].replaced, [mehta4.statements[0].memoryId]);
  assert.equal((await storage.getMemory(mehta4.statements[0].memoryId))!.facts.qty, 4);

  // Balaji: "which packing last time?" is found by climbing to L2.
  const packing = await engine.recall({ kind: 'user_user', topic: TOPIC, partyId: 'balaji' }, 'pichhli baar packing kaunsi thi?');
  assert.equal(packing.climbedTo, 'L2');
  assert.ok(packing.memories.some((memory) => memory.content.includes('25 kg bags')));

  // 13 Oct: Sharma pays 2 of 3.2 lakh -> partial payment does not fulfil the promise.
  await engine.process({
    context: { kind: 'event', topic: TOPIC, partyId: 'sharma-jaipur', dealId: 'dues-oct' },
    participants: ['bank'], raw: 'NEFT 2 lakh received', occurredAt: '2026-10-12T10:00:00.000Z',
    event: { type: 'payment_received', facts: { amount: 200000 } },
  });
  clock.set('2026-10-13T09:00:00.000Z');
  const due = await engine.dueCheck();
  assert.ok(due.broken.includes(promise.statements[0].memoryId));

  assert.deepEqual(engine.errors, []);
});

test('ABC: volume — 500 conversations across 50 parties process without errors and stay consistent', async () => {
  const clock = new TestClock('2026-04-01T09:00:00.000Z');
  const { engine, storage } = makeEngine({ clock });
  const lines = [
    'order 2 ton wire nails chahiye',
    'payment 1 lakh 30 sep tak kar denge',
    'rate ₹78 theek hai',
    'chai pe kab aa rahe ho?',
    'packing 25 kg bags',
    'cricket match dekha?',
  ];
  for (let index = 0; index < 500; index++) {
    clock.advanceMs(8 * 3_600_000);
    const party = `customer-${index % 50}`;
    const raw = [0, 1, 2].map((offset) => `Buyer: ${lines[(index + offset) % lines.length]}`).join('\n');
    await engine.onInput({ context: { kind: 'user_user', topic: TOPIC, partyId: party, dealId: `deal-${index}` }, participants: ['Nikhil', 'Buyer'], raw });
  }
  const processed = await engine.drain();
  assert.equal(processed.length, 500);
  assert.deepEqual(engine.errors, []);
  assert.equal(storage.statementCount(), 1500);
  const statements = processed.flatMap((item) => item.statements);
  const chatter = statements.filter((statement) => /chai|cricket/.test(statement.text));
  assert.ok(chatter.length > 0);
  assert.ok(chatter.every((statement) => statement.level === 'L3'), 'every chai and cricket line lands in L3');
  assert.ok(statements.filter((statement) => !/chai|cricket/.test(statement.text)).every((statement) => statement.level !== 'L3'));
  const replacedLinks = storage.allLinks().filter((link) => link.kind === 'replaces').length;
  assert.equal(replacedLinks, 0, 'different deals never replace each other');
  const recall = await engine.recall({ kind: 'user_user', topic: TOPIC, partyId: 'customer-7' }, 'wire nails order');
  assert.ok(recall.memories.length > 0 && recall.memories.length <= engine.config.recallBudget);
  assert.ok(recall.memories.every((memory) => memory.partyId === 'customer-7'));
});
