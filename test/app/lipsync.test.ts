import assert from 'node:assert/strict';
import test from 'node:test';
import type { Face, FaceState, MouthShape } from '../../app/src/contracts.ts';
import {
  NEUTRAL_MOUTH,
  TextLipSync,
  buildVisemeTimeline,
  sampleTimeline,
  timeAtChar,
  type VisemeTimeline,
} from '../../app/src/face/lipsync.ts';

/** Mouth target while character `index` is being spoken. */
function shapeAtChar(timeline: VisemeTimeline, index: number): MouthShape {
  return sampleTimeline(timeline, timeAtChar(timeline, index) + 1e-6);
}

test('m, b and p close the lips', () => {
  const timeline = buildVisemeTimeline('mbp', 10);
  for (let i = 0; i < 3; i++) assert.equal(shapeAtChar(timeline, i).open, 0, `char ${i}`);
});

test('"aa" opens the jaw wide and stays open across both letters', () => {
  const text = 'baat';
  const timeline = buildVisemeTimeline(text, 12);
  assert.equal(shapeAtChar(timeline, 0).open, 0); // b
  assert.ok(shapeAtChar(timeline, 1).open >= 0.8);
  assert.ok(shapeAtChar(timeline, 2).open >= 0.8);
});

test('vowels shape the lips: e/i widen, o/u round', () => {
  const timeline = buildVisemeTimeline('ieou', 10);
  assert.ok(shapeAtChar(timeline, 0).wide > 0.5);
  assert.ok(shapeAtChar(timeline, 1).wide > 0.5);
  assert.ok(shapeAtChar(timeline, 2).round > 0.5);
  assert.ok(shapeAtChar(timeline, 3).round > 0.5);
});

test('punctuation pauses with a closed mouth, longer at sentence ends', () => {
  const unit = 1 / 10;
  const plain = buildVisemeTimeline('a a', 10).duration;
  const comma = buildVisemeTimeline('a, a', 10).duration;
  const stop = buildVisemeTimeline('a. a', 10).duration;
  assert.ok(Math.abs(comma - plain - 3 * unit) < 1e-9, 'a comma adds a 3-character pause');
  assert.ok(stop > comma, 'a full stop pauses longer than a comma');

  const timeline = buildVisemeTimeline('haan, theek hai.', 10);
  assert.deepEqual(shapeAtChar(timeline, 4), NEUTRAL_MOUTH);
  const space = shapeAtChar(timeline, 5);
  assert.ok(space.open < 0.1, 'a space briefly closes the mouth');
});

test('total duration scales with charsPerSecond', () => {
  const text = 'Main aapki madad kar sakti hoon.';
  const slow = buildVisemeTimeline(text, 10).duration;
  const fast = buildVisemeTimeline(text, 20).duration;
  assert.ok(slow > 0);
  assert.ok(Math.abs(slow - 2 * fast) < 1e-9);
  assert.equal(buildVisemeTimeline(text, 0).duration, buildVisemeTimeline(text, 14).duration, 'bad rates fall back');
});

test('timeline ends closed and every character has a start time', () => {
  const text = 'kya haal hai?';
  const timeline = buildVisemeTimeline(text, 14);
  assert.equal(timeline.charTimes.length, text.length);
  for (let i = 1; i < text.length; i++) assert.ok(timeline.charTimes[i] >= timeline.charTimes[i - 1]);
  assert.deepEqual(sampleTimeline(timeline, timeline.duration), NEUTRAL_MOUTH);
  assert.deepEqual(sampleTimeline(timeline, -1), NEUTRAL_MOUTH);
});

test('Devanagari still opens and closes the mouth', () => {
  const text = 'नमस्ते, आप कैसे हैं?';
  const timeline = buildVisemeTimeline(text, 12);
  const opens = timeline.keys.map((key) => key.shape.open);
  assert.ok(Math.max(...opens) >= 0.5, 'some syllables open');
  assert.ok(opens.includes(0), 'म closes the lips');
  assert.ok(timeline.duration > 0);
});

test('Devanagari: फ़ is lip-on-teeth, a nukta keeps the inherent vowel, word-final "a" is silent', () => {
  const phone = buildVisemeTimeline('फ़ोन', 10);
  const fa = shapeAtChar(phone, 0);
  assert.ok(fa.open > 0 && fa.wide < 0, 'फ़ ("f") does not shut the lips like फ');
  assert.equal(shapeAtChar(buildVisemeTimeline('फल', 10), 0).open, 0, 'plain फ still closes them');

  const shapes = (text: string) => buildVisemeTimeline(text, 10).keys.map((key) => key.shape);
  assert.deepEqual(shapes('ज़रा'), shapes('जरा'), 'ज़रा opens for "za" just like जरा');

  // आप is "aap": the lips close on प and stay closed until the next word.
  const text = 'आप कैसे';
  const timeline = buildVisemeTimeline(text, 10);
  const during = timeline.keys.filter((key) => key.time >= timeAtChar(timeline, 1) && key.time < timeAtChar(timeline, 2));
  assert.ok(during.length > 0 && during.every((key) => key.shape.open === 0), 'no extra "a" after प');
});

test('timeAtChar maps a boundary index to that character\'s start time', () => {
  const text = 'aaa mmm ooo';
  const timeline = buildVisemeTimeline(text, 10);
  assert.ok(Math.abs(timeAtChar(timeline, 4) - 0.4) < 1e-9);
  assert.ok(Math.abs(timeAtChar(timeline, 8) - 0.8) < 1e-9);
  assert.equal(timeAtChar(timeline, 999), timeline.duration);
  assert.equal(timeAtChar(timeline, -3), 0);
});

/** Frame scheduler and clock under the test's control. */
function fakeFrames() {
  const queue = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  const clock = { now: 0 };
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      queue.set(nextId, callback);
      return nextId++;
    },
    cancelAnimationFrame: (id: number) => queue.delete(id),
  });
  const runFrame = () => {
    const callbacks = [...queue.values()];
    queue.clear();
    for (const callback of callbacks) callback(clock.now);
  };
  return { clock, runFrame, pending: () => queue.size };
}

class RecordingFace implements Face {
  readonly mouths: MouthShape[] = [];
  setState(_state: FaceState): void {}
  setInputLevel(_level: number): void {}
  setMouth(shape: MouthShape): void {
    this.mouths.push(shape);
  }
  resize(): void {}
  dispose(): void {}
  get last(): MouthShape | undefined {
    return this.mouths[this.mouths.length - 1];
  }
}

test('TextLipSync re-syncs the playhead to speech boundaries and closes on stop', () => {
  const frames = fakeFrames();
  const face = new RecordingFace();
  const lipSync = new TextLipSync(face, () => frames.clock.now);
  const text = 'aaa mmm ooo';

  lipSync.start(text, { charsPerSecond: 10 });
  assert.ok(face.last!.open >= 0.8, 'starts on the open "a"');

  // Speech is slower than the estimate: at 150 ms the engine reports the word "mmm" starting.
  frames.clock.now = 150;
  lipSync.boundary(4);
  assert.ok(Math.abs(lipSync.playhead() - 0.4) < 1e-9);
  frames.runFrame();
  assert.equal(face.last!.open, 0, 'lips closed for "m"');

  frames.clock.now = 550;
  frames.runFrame();
  assert.ok(face.last!.round > 0.5, 'rounded for "o"');

  lipSync.stop();
  assert.deepEqual(face.last, NEUTRAL_MOUTH);
  assert.equal(frames.pending(), 0, 'no frames scheduled after stop');
});

test('TextLipSync keeps going without boundaries and resumes if speech outlasts the estimate', () => {
  const frames = fakeFrames();
  const face = new RecordingFace();
  const lipSync = new TextLipSync(face, () => frames.clock.now);
  lipSync.start('mama', { charsPerSecond: 10 });
  frames.clock.now = 250;
  frames.runFrame();
  assert.equal(face.last!.open, 0, 'third char "m" without any boundary');

  frames.clock.now = 1000;
  frames.runFrame();
  assert.deepEqual(face.last, NEUTRAL_MOUTH, 'closes when the estimate runs out');
  assert.equal(frames.pending(), 0);

  lipSync.boundary(1);
  assert.ok(face.last!.open >= 0.8, 'a late boundary picks the mouth back up');
  assert.equal(frames.pending(), 1);
  lipSync.stop();
});
