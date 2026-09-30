import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG, DEFAULT_WEIGHTS } from '../../src/atomic/config.ts';
import {
  angleScore,
  certaintyFactor,
  chooseKind,
  contentScore,
  isOverride,
  levelFor,
  reliability,
  specificsCount,
  wordingCertainty,
} from '../../src/atomic/scoring.ts';
import { ABC_FUNDAMENTAL, angles } from './helpers.ts';

const close = (actual: number, expected: number, digits = 3) =>
  assert.ok(Math.abs(actual - expected) < 10 ** -digits, `${actual} ≉ ${expected}`);

const paymentPromise = angles({
  type: 'payment', intent: 'commit', specifics: { date: '2026-10-15', item: 'dues' }, change: 'new', risk: 'high',
});

test('angle scores follow the spec tables', () => {
  assert.equal(angleScore(angles({ type: 'payment' }), 'type'), 1);
  assert.equal(angleScore(angles({ type: 'question' }), 'type'), 0.6);
  assert.equal(angleScore(angles({ type: 'joke' }), 'type'), 0);
  assert.equal(angleScore(angles({ intent: 'request' }), 'intent'), 0.8);
  assert.equal(angleScore(angles({ intent: 'negotiate' }), 'intent'), 0.6);
  assert.equal(angleScore(angles({ stance: 'disagree' }), 'stance'), 1);
  assert.equal(angleScore(angles({ stance: 'agree' }), 'stance'), 0.4);
  assert.equal(angleScore(angles({ emotion: 'worried' }), 'emotion'), 0.7);
  assert.equal(angleScore(angles({ change: 'update' }), 'change'), 0.9);
  assert.equal(angleScore(angles({ change: 'repeat' }), 'change'), 0.2);
  assert.equal(angleScore(angles({ risk: 'medium' }), 'risk'), 0.5);
  assert.equal(angleScore(angles({ trust: true }), 'trust'), 1);
  assert.equal(angleScore(angles({ trust: false }), 'trust'), 0);
});

test('specifics count concrete fields and cap at 1', () => {
  assert.equal(specificsCount({}), 0);
  assert.equal(specificsCount({ qty: 3, unit: 'ton' }), 1);
  close(angleScore(angles({ specifics: { qty: 3, date: '2026-10-01' } }), 'specifics'), 2 / 3);
  assert.equal(angleScore(angles({ specifics: { qty: 1, rate: 2, amount: 3, date: 'x', item: 'y' } }), 'specifics'), 1);
});

test('worked example: reliable customer payment promise scores 0.64 and reaches L1 on its own', () => {
  const content = contentScore(paymentPromise, DEFAULT_WEIGHTS.payment);
  close(content, 0.6356);
  const importance = content * certaintyFactor(1 * reliability(undefined), DEFAULT_CONFIG);
  close(importance, 0.6356);
  assert.equal(levelFor(0.9, importance, false, DEFAULT_CONFIG), 'L1');
});

test('worked example: late payer (certainty 0.6) drops to 0.48 but the override keeps it in L1', () => {
  const content = contentScore(paymentPromise, DEFAULT_WEIGHTS.payment);
  const factor = certaintyFactor(0.6, DEFAULT_CONFIG);
  close(factor, 0.76);
  const importance = content * factor;
  close(importance, 0.4831);
  assert.equal(levelFor(0.9, importance, false, DEFAULT_CONFIG), 'L2');
  assert.equal(isOverride(paymentPromise, 'payment', ABC_FUNDAMENTAL), true);
  assert.equal(levelFor(0.9, importance, true, DEFAULT_CONFIG), 'L1');
});

test('worked example: tentative suggestion lands in L2', () => {
  const suggestion = angles({ type: 'order', intent: 'request', certainty: 'tentative', specifics: { date: '2026-10-31' }, risk: 'medium' });
  const content = contentScore(suggestion, DEFAULT_WEIGHTS.order);
  close(content, 0.5387);
  const importance = content * certaintyFactor(wordingCertainty(suggestion), DEFAULT_CONFIG);
  close(importance, 0.3771);
  assert.equal(levelFor(0.8, importance, isOverride(suggestion, 'order', ABC_FUNDAMENTAL), DEFAULT_CONFIG), 'L2');
});

test('worked example: an opinion about past goods lands in L2', () => {
  const opinion = angles({ type: 'opinion', emotion: 'happy', specifics: { item: 'wire nail' }, change: 'repeat', trust: true });
  const importance = contentScore(opinion, DEFAULT_WEIGHTS.order);
  assert.ok(importance < 0.5);
  assert.equal(levelFor(0.7, importance, false, DEFAULT_CONFIG), 'L2');
});

test('irrelevant statements go to L3 even with an override', () => {
  assert.equal(levelFor(0.1, 0.99, true, DEFAULT_CONFIG), 'L3');
  assert.equal(levelFor(DEFAULT_CONFIG.relevanceThreshold, 0.1, false, DEFAULT_CONFIG), 'L2');
  assert.equal(levelFor(0.5, DEFAULT_CONFIG.importanceThreshold, false, DEFAULT_CONFIG), 'L1');
});

test('certainty is a multiplier with a 0.4 floor, so empty firm statements gain nothing', () => {
  close(certaintyFactor(0, DEFAULT_CONFIG), 0.4);
  close(certaintyFactor(1, DEFAULT_CONFIG), 1);
  const empty = angles({ type: 'small_talk', certainty: 'firm' });
  assert.equal(contentScore(empty, DEFAULT_WEIGHTS.general_chat) * certaintyFactor(1, DEFAULT_CONFIG) < 0.2, true);
});

test('track record: no history counts as reliable, broken promises lower it', () => {
  assert.equal(reliability(undefined), 1);
  assert.equal(reliability({ subject: 's', intent: 'commit', kept: 0, total: 0 }), 1);
  close(reliability({ subject: 's', intent: 'commit', kept: 1, total: 6 }), 3 / 8);
  close(reliability({ subject: 's', intent: 'commit', kept: 6, total: 6 }), 1);
});

test('kind is chosen per statement: the confident kind that scores highest wins', () => {
  const promise = paymentPromise;
  const choice = chooseKind(promise, [{ kind: 'general_chat', confidence: 0.9 }, { kind: 'payment', confidence: 0.4 }], DEFAULT_WEIGHTS, DEFAULT_CONFIG);
  assert.equal(choice.kind, 'payment');
  const ignored = chooseKind(promise, [{ kind: 'general_chat', confidence: 0.9 }, { kind: 'payment', confidence: 0.1 }], DEFAULT_WEIGHTS, DEFAULT_CONFIG);
  assert.equal(ignored.kind, 'general_chat');
  const fallback = chooseKind(promise, [{ kind: 'order', confidence: 0.1 }, { kind: 'payment', confidence: 0.2 }], DEFAULT_WEIGHTS, DEFAULT_CONFIG);
  assert.equal(fallback.kind, 'payment');
  assert.equal(chooseKind(promise, [], DEFAULT_WEIGHTS, DEFAULT_CONFIG).kind, 'general_chat');
});

test('overrides: commitments with a date, amount or quantity, or in a critical kind', () => {
  assert.equal(isOverride(angles({ intent: 'commit', specifics: { date: '2026-10-05' } }), 'order', ABC_FUNDAMENTAL), true);
  assert.equal(isOverride(angles({ intent: 'commit', specifics: { amount: 320000 } }), 'order', ABC_FUNDAMENTAL), true);
  assert.equal(isOverride(angles({ intent: 'commit', specifics: { qty: 3 } }), 'order', ABC_FUNDAMENTAL), true);
  assert.equal(isOverride(angles({ intent: 'commit' }), 'payment', ABC_FUNDAMENTAL), true);
  assert.equal(isOverride(angles({ intent: 'commit' }), 'order', ABC_FUNDAMENTAL), false);
  assert.equal(isOverride(angles({ intent: 'request', specifics: { date: '2026-10-05' } }), 'payment', ABC_FUNDAMENTAL), false);
});

test('every kind in the weights table has all eight angles', () => {
  for (const [kind, row] of Object.entries(DEFAULT_WEIGHTS)) {
    assert.deepEqual(Object.keys(row).sort(), ['change', 'emotion', 'intent', 'risk', 'specifics', 'stance', 'trust', 'type'], kind);
    for (const value of Object.values(row)) assert.ok(value >= 0 && value <= 5, kind);
  }
});
