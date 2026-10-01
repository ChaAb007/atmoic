import assert from 'node:assert/strict';
import test from 'node:test';
import { AtomicV2 } from '../../src/atomic-v2/engine.ts';
import { InMemoryStore, parseMemoryFile } from '../../src/atomic-v2/store.ts';
import { cosine } from '../../src/atomic-v2/vectors.ts';
import { ConceptEmbedder, DISCOUNT_ASK, DISCOUNT_RESPONSE, openAtomic, TestClock } from './helpers.ts';

test('one ask + response becomes one experience that went through all four layers', async () => {
  const { atomic, store } = await openAtomic();
  const experience = await atomic.process({ ask: DISCOUNT_ASK, response: DISCOUNT_RESPONSE });
  assert.equal(atomic.size, 1);
  assert.equal(experience.ask, DISCOUNT_ASK, 'raw text is kept for exact figures');
  assert.equal(experience.kind, 'work');
  const orders = experience.pieces.map((piece) => piece.order);
  assert.deepEqual(orders, [...orders].sort((left, right) => left - right), 'pieces are in Layer 1 order');
  const relevances = experience.pieces.map((piece) => piece.relevance);
  assert.deepEqual(relevances, [...relevances].sort((left, right) => right - left), 'most relevant first');
  assert.ok(experience.pieces.some((piece) => piece.levels.includes('L1')));
  assert.ok(experience.levelVectors.L4 && experience.summary.includes('→'));
  assert.ok(cosine(experience.combined, experience.unitVector) > 0.7, 'the combined vector keeps the meaning');
  assert.ok(experience.importance > 0.3);
  assert.equal(store.saves, 2, 'saved on open and after the experience');
});

test('casual chat is kept but carries no levels', async () => {
  const { atomic } = await openAtomic();
  const experience = await atomic.process({ ask: 'hi, how are you?', response: 'Hello! I am good, how are you?' });
  assert.equal(experience.kind, 'casual');
  assert.ok(experience.pieces.every((piece) => piece.levels.length === 0));
  assert.ok(experience.importance < 0.3);
});

test('emotion is read only from the person: the AI response never carries emotion', async () => {
  const { atomic } = await openAtomic();
  const experience = await atomic.process({
    ask: 'I am so upset and worried, the payment from AVI is late again',
    response: 'Haha thanks, great, I love it, so happy and proud!',
  });
  assert.ok(experience.valence < -0.3, 'the person is upset');
  for (const piece of experience.pieces.filter((item) => item.side === 'response')) {
    assert.equal(piece.profile.emotion, 0);
    assert.equal(piece.profile.pressure, 0);
    assert.ok(!piece.levels.includes('L3'));
  }
  assert.ok(experience.pieces.some((piece) => piece.side === 'ask' && piece.levels.includes('L3')));
});

test('correctness: an on-target answer scores higher than a failure', async () => {
  const { atomic } = await openAtomic();
  const answered = await atomic.process({ ask: 'Please make the invoice for AVI', response: 'The invoice for AVI is made, bill number 1041.' });
  const failed = await atomic.process({ ask: 'Please make the invoice for AVI', response: "Sorry, I couldn't, there was an error." });
  assert.ok(answered.profile.correctness > failed.profile.correctness);
  assert.ok(answered.satisfaction > failed.satisfaction);
});

test('decisions and risks make a growth experience', async () => {
  const { atomic } = await openAtomic();
  const experience = await atomic.process({
    ask: 'We decided to cancel the order because the risk of losing margin is too high',
    response: 'That reduces the risk on margin.',
  });
  assert.equal(experience.kind, 'growth');
  assert.ok(experience.levelWeights.L2 > experience.levelWeights.L1);
});

test('the same thing going badly before makes it more important now (history pull)', async () => {
  const clock = new TestClock('2026-10-01T04:30:00.000Z');
  const { atomic } = await openAtomic({ clock });
  await atomic.process({ ask: 'I am so upset and worried, the payment from AVI is late again', response: 'Let us send a payment reminder to AVI.' });
  clock.advanceDays(3);
  const later = await atomic.process({ ask: 'Is the payment from AVI late?', response: 'Yes, the AVI payment is pending.' });
  const fresh = await (await openAtomic({ clock })).atomic.process({ ask: 'Is the payment from AVI late?', response: 'Yes, the AVI payment is pending.' });
  assert.ok(later.historyPull > 0.2, `history pull ${later.historyPull}`);
  assert.equal(fresh.historyPull, 0);
  assert.ok(later.importance > fresh.importance);
});

test('novelty drops when the same thing comes up again', async () => {
  const { atomic } = await openAtomic();
  const first = await atomic.process({ ask: DISCOUNT_ASK, response: DISCOUNT_RESPONSE });
  const again = await atomic.process({ ask: DISCOUNT_ASK, response: DISCOUNT_RESPONSE });
  assert.equal(first.profile.novelty, 1);
  assert.ok(again.profile.novelty < 0.1);
});

test("the person's next reaction changes how the earlier exchange is judged", async () => {
  const clock = new TestClock('2026-10-01T04:30:00.000Z');
  const { atomic } = await openAtomic({ clock });
  const answer = await atomic.process({ ask: 'Please make the invoice for AVI', response: 'The invoice for AVI is made.' });
  const before = answer.satisfaction;
  clock.advanceMinutes(2);
  await atomic.process({ ask: "No, that's wrong, galat hai, you misunderstood", response: 'Sorry, let me fix the invoice.' });
  assert.ok(atomic.get(answer.id)!.satisfaction < before - 0.2);

  const praised = await atomic.process({ ask: 'Please make the invoice for AVI', response: 'The invoice for AVI is made.' });
  const praisedBefore = praised.satisfaction;
  clock.advanceMinutes(1);
  await atomic.process({ ask: 'Thank you so much, great job, perfect', response: 'Happy to help!' });
  assert.ok(atomic.get(praised.id)!.satisfaction >= praisedBefore);

  const old = await atomic.process({ ask: 'Please make the invoice for AVI', response: 'The invoice for AVI is made.' });
  const oldSatisfaction = old.satisfaction;
  clock.advanceMinutes(120);
  await atomic.process({ ask: "No, that's wrong", response: 'Sorry.' });
  assert.equal(atomic.get(old.id)!.satisfaction, oldSatisfaction, 'outside the follow-up window nothing changes');
});

test('recall brings back only what matches the ask: there is no chat session', async () => {
  const clock = new TestClock('2026-10-01T04:30:00.000Z');
  const { atomic } = await openAtomic({ clock });
  const discount = await atomic.process({ ask: DISCOUNT_ASK, response: DISCOUNT_RESPONSE });
  clock.advanceMinutes(1);
  await atomic.process({ ask: 'my mother and sister came to visit the family', response: 'That is lovely, family time.' });
  clock.advanceMinutes(1);
  const unrelated = await atomic.recall('who won the cricket match against india?');
  assert.deepEqual(unrelated.items, [], 'the latest exchange is not pulled in just because it is recent');
  const related = await atomic.recall('what discount did AVI get on the excel order?');
  assert.equal(related.items[0].experience.id, discount.id);
  assert.ok(related.items[0].experience.response.includes('3 percent'), 'exact figures come back as raw text');
  assert.ok(related.items.length <= atomic.config.recallLimit);
});

test('recall is read-only: it never strengthens or changes memory', async () => {
  const { atomic, store } = await openAtomic();
  const experience = await atomic.process({ ask: DISCOUNT_ASK, response: DISCOUNT_RESPONSE });
  const before = JSON.stringify(atomic.get(experience.id));
  const saves = store.saves;
  for (let index = 0; index < 5; index++) await atomic.recall('discount for AVI');
  assert.equal(JSON.stringify(atomic.get(experience.id)), before);
  assert.equal(store.saves, saves);
});

test('feedback credits the exchange and the memories it used; strength decays when read, never written', async () => {
  const clock = new TestClock('2026-10-01T04:30:00.000Z');
  const { atomic } = await openAtomic({ clock });
  const used = await atomic.process({ ask: DISCOUNT_ASK, response: DISCOUNT_RESPONSE });
  clock.advanceMinutes(60);
  const recall = await atomic.recall('discount for AVI on the excel order');
  const answer = await atomic.process({
    ask: 'what discount did AVI get?', response: 'AVI got a 3 percent discount.', recalled: recall.items.map((item) => item.experience.id),
  });
  assert.deepEqual(answer.recalled, [used.id]);
  await atomic.feedback(answer.id, true);
  assert.equal(atomic.get(answer.id)!.feedback, 'good');
  assert.ok(atomic.get(answer.id)!.satisfaction >= 0.9);
  assert.ok(atomic.get(used.id)!.strength > 0.5, 'the memory that helped got stronger');
  await atomic.feedback(answer.id, false);
  assert.ok(atomic.get(answer.id)!.satisfaction <= 0.1);
  await assert.rejects(atomic.feedback('missing', true), /not found/);

  const stored = atomic.get(used.id)!.strength;
  clock.advanceDays(100);
  assert.ok(atomic.effectiveStrength(atomic.get(used.id)!) < stored * 0.5);
  assert.equal(atomic.get(used.id)!.strength, stored, 'decay is not written back');
});

test('memory survives a restart from the file, without re-embedding the anchors', async () => {
  const store = new InMemoryStore();
  const embedder = new ConceptEmbedder();
  const { atomic } = await openAtomic({ store, embedder });
  const experience = await atomic.process({ ask: DISCOUNT_ASK, response: DISCOUNT_RESPONSE });
  const file = parseMemoryFile(store.text)!;
  assert.equal(file.embedder, embedder.id);
  assert.equal(file.experiences.length, 1);
  assert.ok(file.anchors, 'anchor vectors are cached in the file');

  const textsBefore = embedder.texts;
  const reopened = await AtomicV2.open({ embedder, store });
  assert.equal(embedder.texts, textsBefore, 'nothing re-embedded on reopen');
  const restored = reopened.get(experience.id)!;
  assert.equal(restored.ask, experience.ask);
  assert.equal(restored.kind, experience.kind);
  assert.ok(cosine(restored.combined, experience.combined) > 0.99);
  assert.ok(cosine(restored.levelVectors.L1, experience.levelVectors.L1) > 0.99);
  assert.equal((await reopened.recall('discount for AVI excel order')).items[0].experience.id, experience.id);
});

test('a new embedder rebuilds memory from the raw text and keeps what was learned', async () => {
  const store = new InMemoryStore();
  const { atomic } = await openAtomic({ store });
  const experience = await atomic.process({ ask: DISCOUNT_ASK, response: DISCOUNT_RESPONSE });
  await atomic.feedback(experience.id, true);
  const progress: string[] = [];
  const migrated = await AtomicV2.open({
    embedder: new ConceptEmbedder('concept-test-v2'),
    store,
    onProgress: (stage, done, total) => progress.push(`${stage}:${done}/${total}`),
  });
  assert.equal(parseMemoryFile(store.text)!.embedder, 'concept-test-v2');
  const rebuilt = migrated.get(experience.id)!;
  assert.equal(rebuilt.feedback, 'good');
  assert.ok(rebuilt.satisfaction >= 0.9);
  assert.equal(rebuilt.ask, DISCOUNT_ASK);
  assert.ok(progress.includes('migrate:1/1'));
});

test('changes are applied one at a time, so the file always holds every experience', async () => {
  const { atomic, store } = await openAtomic();
  await Promise.all(Array.from({ length: 8 }, (_, index) => atomic.process({ ask: `order ${index} for AVI`, response: `order ${index} created` })));
  assert.equal(atomic.size, 8);
  assert.equal(parseMemoryFile(store.text)!.experiences.length, 8);
});

test('forget, clear, stats, list and export', async () => {
  const { atomic } = await openAtomic();
  const first = await atomic.process({ ask: DISCOUNT_ASK, response: DISCOUNT_RESPONSE });
  await atomic.process({ ask: 'hi, how are you?', response: 'Hello!' });
  assert.deepEqual(atomic.stats().byKind, { work: 1, growth: 0, emotional: 0, casual: 1 });
  assert.equal(atomic.list(1)[0].ask, 'hi, how are you?');
  assert.equal(parseMemoryFile(atomic.exportJson())!.experiences.length, 2);
  assert.equal(await atomic.forget(first.id), true);
  assert.equal(await atomic.forget(first.id), false);
  await atomic.clear();
  assert.equal(atomic.size, 0);
});

test('a file that is not Atomic v2 memory is refused, not overwritten', async () => {
  const store = new InMemoryStore('{"format":"something-else"}');
  await assert.rejects(AtomicV2.open({ embedder: new ConceptEmbedder(), store }), /not an Atomic v2 memory file/);
  assert.equal(store.text, '{"format":"something-else"}');
});
