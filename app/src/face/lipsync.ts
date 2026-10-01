/**
 * Text-driven lip sync. The text is turned into a viseme timeline up front (pure, no browser
 * needed), then played against the clock; word boundaries from the speech engine pull the playhead
 * back into step and tune the playback speed. Works for English, romanised Hinglish and Devanagari.
 */

import type { Face, LipSync, MouthShape } from '../contracts.ts';

export interface VisemeKey {
  /** Seconds from the start of the text. */
  readonly time: number;
  readonly shape: MouthShape;
}

export interface VisemeTimeline {
  /** Mouth targets in time order; each holds until the next. */
  readonly keys: readonly VisemeKey[];
  /** Start time (seconds) of every UTF-16 code unit of the text, matching speech boundary indices. */
  readonly charTimes: readonly number[];
  readonly duration: number;
}

export const NEUTRAL_MOUTH: MouthShape = Object.freeze({ open: 0, wide: 0, round: 0 });

const SHAPE = {
  closed: NEUTRAL_MOUTH,
  rest: { open: 0.06, wide: 0, round: 0 },
  open: { open: 0.85, wide: 0.12, round: 0 },
  schwa: { open: 0.55, wide: 0.05, round: 0 },
  e: { open: 0.45, wide: 0.6, round: 0 },
  i: { open: 0.28, wide: 0.8, round: 0 },
  o: { open: 0.58, wide: -0.5, round: 0.85 },
  u: { open: 0.3, wide: -0.8, round: 1 },
  labiodental: { open: 0.12, wide: -0.3, round: 0 },
  consonant: { open: 0.28, wide: 0.12, round: 0 },
  nasal: { open: 0.1, wide: 0, round: 0 },
} as const satisfies Record<string, MouthShape>;

/** One step of the timeline; a null shape holds whatever the mouth was doing. */
export interface VisemePart {
  readonly shape: MouthShape | null;
  /** Length in character units (one unit = 1 / charsPerSecond). */
  readonly units: number;
}

const COMMA_PAUSE = 3;
const SENTENCE_PAUSE = 5;
const DEFAULT_CHARS_PER_SECOND = 14;

const LATIN: Record<string, MouthShape> = {
  a: SHAPE.open,
  e: SHAPE.e,
  i: SHAPE.i,
  y: SHAPE.i,
  o: SHAPE.o,
  u: SHAPE.u,
  w: SHAPE.u,
  m: SHAPE.closed,
  b: SHAPE.closed,
  p: SHAPE.closed,
  f: SHAPE.labiodental,
  v: SHAPE.labiodental,
};

/** Devanagari vowels, both independent letters and the vowel signs (matras) that follow consonants. */
const DEVANAGARI_VOWELS: Record<number, MouthShape> = {
  0x0905: SHAPE.schwa, 0x0906: SHAPE.open, 0x093e: SHAPE.open,
  0x0907: SHAPE.i, 0x0908: SHAPE.i, 0x093f: SHAPE.i, 0x0940: SHAPE.i,
  0x0909: SHAPE.u, 0x090a: SHAPE.u, 0x0941: SHAPE.u, 0x0942: SHAPE.u,
  0x090f: SHAPE.e, 0x0910: SHAPE.e, 0x0945: SHAPE.e, 0x0947: SHAPE.e, 0x0948: SHAPE.e,
  0x0911: SHAPE.o, 0x0913: SHAPE.o, 0x0914: SHAPE.o, 0x0949: SHAPE.o, 0x094b: SHAPE.o, 0x094c: SHAPE.o,
  0x090b: SHAPE.consonant, 0x0943: SHAPE.consonant,
};

const VIRAMA = 0x094d;
const NUKTA = 0x093c;
const PHA = 0x092b;
/** फ़ as one precomposed letter. */
const FA = 0x095e;

function isDevanagariConsonant(code: number): boolean {
  return (code >= 0x0915 && code <= 0x0939) || (code >= 0x0958 && code <= 0x095f);
}

function isDevanagariSign(code: number): boolean {
  return code === VIRAMA || code === NUKTA || (code >= 0x093e && code <= 0x094c);
}

/** Letters, vowel signs and marks that continue a word (not danda, digits, spaces or punctuation). */
function isDevanagariWordPart(code: number): boolean {
  return code >= 0x0900 && code <= 0x0963;
}

function devanagariConsonant(code: number, nextCode: number): MouthShape {
  // फ़ is "f" (teeth on lip); plain फ is an aspirated "p" that closes the lips.
  if (code === FA || (code === PHA && nextCode === NUKTA)) return SHAPE.labiodental;
  if (code >= 0x092a && code <= 0x092e) return SHAPE.closed; // प फ ब भ म
  if (code === 0x0935) return SHAPE.labiodental; // व
  if (code === 0x092f) return SHAPE.i; // य
  return SHAPE.consonant;
}

/** The short "a" a bare consonant carries. Hindi drops it at the end of a word: आप is "aap", not "aapa". */
function inherentVowel(nextCode: number): VisemePart {
  return isDevanagariWordPart(nextCode) ? { shape: SHAPE.schwa, units: 0.75 } : { shape: null, units: 0.3 };
}

function devanagariParts(code: number, nextCode: number): VisemePart[] {
  const vowel = DEVANAGARI_VOWELS[code];
  if (vowel) return [{ shape: vowel, units: isDevanagariSign(code) ? 0.8 : 1 }];
  if (isDevanagariConsonant(code)) {
    const consonant = devanagariConsonant(code, nextCode);
    // A nukta only changes the letter; its own step decides whether the inherent vowel follows.
    if (nextCode === NUKTA) return [{ shape: consonant, units: 0.45 }];
    if (isDevanagariSign(nextCode)) return [{ shape: consonant, units: 0.7 }];
    return [{ shape: consonant, units: 0.45 }, inherentVowel(nextCode)];
  }
  if (code === NUKTA) return [isDevanagariSign(nextCode) ? { shape: null, units: 0.25 } : inherentVowel(nextCode)];
  if (code === 0x0901 || code === 0x0902) return [{ shape: SHAPE.nasal, units: 0.5 }]; // ँ ं
  if (code === 0x0903) return [{ shape: SHAPE.consonant, units: 0.5 }]; // ः
  if (code === 0x0964 || code === 0x0965) return [{ shape: SHAPE.closed, units: SENTENCE_PAUSE }]; // । ॥
  if (code >= 0x0966 && code <= 0x096f) return [{ shape: SHAPE.schwa, units: 1 }]; // digits
  return [{ shape: null, units: 0 }]; // virama and other marks
}

function punctuationParts(char: string): VisemePart[] | null {
  if (char === ' ' || char === '\t') return [{ shape: SHAPE.rest, units: 1 }];
  if (char === '\n' || char === '\r') return [{ shape: SHAPE.closed, units: 4 }];
  if (',;:—–'.includes(char)) return [{ shape: SHAPE.closed, units: COMMA_PAUSE }];
  if ('.?!…'.includes(char)) return [{ shape: SHAPE.closed, units: SENTENCE_PAUSE }];
  return null;
}

/** Mouth steps for one UTF-16 code unit of text, given the code unit after it. */
export function visemePartsFor(char: string, next: string): VisemePart[] {
  const code = char.charCodeAt(0);
  if (code >= 0x0900 && code <= 0x097f) return devanagariParts(code, next.charCodeAt(0));
  const punctuation = punctuationParts(char);
  if (punctuation) return punctuation;
  const lower = char.toLowerCase();
  if (lower >= 'a' && lower <= 'z') return [{ shape: LATIN[lower] ?? SHAPE.consonant, units: 1 }];
  if (char >= '0' && char <= '9') return [{ shape: SHAPE.schwa, units: 1 }];
  // Letters of other scripts still get a plausible open/close rhythm; symbols just hold.
  if (/\p{L}/u.test(char)) return [{ shape: SHAPE.schwa, units: 1 }];
  return [{ shape: null, units: 0.25 }];
}

function sameShape(a: MouthShape, b: MouthShape): boolean {
  return a.open === b.open && a.wide === b.wide && a.round === b.round;
}

function pushKey(keys: VisemeKey[], time: number, shape: MouthShape): void {
  const last = keys[keys.length - 1];
  if (last && sameShape(last.shape, shape)) return;
  if (last && last.time === time) keys.pop();
  keys.push({ time, shape });
}

function sanitizeRate(charsPerSecond: number): number {
  return Number.isFinite(charsPerSecond) && charsPerSecond > 0 ? charsPerSecond : DEFAULT_CHARS_PER_SECOND;
}

/** Builds the viseme timeline for `text` spoken at about `charsPerSecond`. */
export function buildVisemeTimeline(text: string, charsPerSecond: number): VisemeTimeline {
  const unit = 1 / sanitizeRate(charsPerSecond);
  const keys: VisemeKey[] = [];
  const charTimes: number[] = [];
  let time = 0;
  for (let i = 0; i < text.length; i++) {
    charTimes.push(time);
    for (const part of visemePartsFor(text[i], text[i + 1] ?? '')) {
      if (part.shape) pushKey(keys, time, part.shape);
      time += part.units * unit;
    }
  }
  pushKey(keys, time, NEUTRAL_MOUTH);
  return { keys, charTimes, duration: time };
}

/** Timeline time (seconds) at which character `charIndex` starts; past the end gives the duration. */
export function timeAtChar(timeline: VisemeTimeline, charIndex: number): number {
  if (!Number.isFinite(charIndex) || charIndex < 0) return 0;
  const index = Math.floor(charIndex);
  return index < timeline.charTimes.length ? timeline.charTimes[index] : timeline.duration;
}

/** Index of the key active at time t (seconds), or -1 before the first key. */
export function keyIndexAt(timeline: VisemeTimeline, t: number): number {
  const { keys } = timeline;
  let low = 0;
  let high = keys.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (keys[mid].time <= t) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** Mouth target at time t (seconds); closed before the start and after the end. */
export function sampleTimeline(timeline: VisemeTimeline, t: number): MouthShape {
  if (t >= timeline.duration) return NEUTRAL_MOUTH;
  const index = keyIndexAt(timeline, t);
  return index < 0 ? NEUTRAL_MOUTH : timeline.keys[index].shape;
}

/** How far boundary-measured speed may pull the playback rate from the estimate. */
const RATE_LIMITS = { min: 0.5, max: 2 } as const;

export class TextLipSync implements LipSync {
  private readonly face: Face;
  private readonly now: () => number;
  private timeline: VisemeTimeline | null = null;
  /** Playhead = anchorTime + (now - anchorAt) * rate, in seconds. */
  private anchorTime = 0;
  private anchorAt = 0;
  private rate = 1;
  private lastBoundary: { time: number; at: number } | null = null;
  private lastShape: MouthShape | null = null;
  private frameId: number | null = null;

  constructor(face: Face, now: () => number = () => performance.now()) {
    this.face = face;
    this.now = now;
  }

  start(text: string, options: { charsPerSecond: number }): void {
    this.cancelFrame();
    this.timeline = buildVisemeTimeline(text, options.charsPerSecond);
    this.anchorTime = 0;
    this.anchorAt = this.now();
    this.rate = 1;
    this.lastBoundary = null;
    this.lastShape = null;
    this.tick();
  }

  boundary(charIndex: number): void {
    if (!this.timeline) return;
    const at = this.now();
    const time = timeAtChar(this.timeline, charIndex);
    this.adaptRate(time, at);
    this.anchorTime = time;
    this.anchorAt = at;
    // The estimate may have run out before the real speech; pick up again.
    if (this.frameId === null) this.tick();
  }

  stop(): void {
    this.cancelFrame();
    this.timeline = null;
    this.lastShape = null;
    this.face.setMouth(NEUTRAL_MOUTH);
  }

  /** Current playhead in timeline seconds (for tests and diagnostics). */
  playhead(): number {
    return this.anchorTime + ((this.now() - this.anchorAt) / 1000) * this.rate;
  }

  /** Tunes the playback speed to match how fast the engine is really getting through the text. */
  private adaptRate(time: number, at: number): void {
    const previous = this.lastBoundary;
    this.lastBoundary = { time, at };
    if (!previous || at - previous.at < 120 || time <= previous.time) return;
    const measured = (time - previous.time) / ((at - previous.at) / 1000);
    const blended = this.rate + (measured - this.rate) * 0.5;
    this.rate = Math.min(Math.max(blended, RATE_LIMITS.min), RATE_LIMITS.max);
  }

  private readonly tick = (): void => {
    this.frameId = null;
    const timeline = this.timeline;
    if (!timeline) return;
    const t = this.playhead();
    this.show(sampleTimeline(timeline, t));
    if (t < timeline.duration) this.frameId = requestAnimationFrame(this.tick);
  };

  private show(shape: MouthShape): void {
    if (this.lastShape === shape) return;
    this.lastShape = shape;
    this.face.setMouth(shape);
  }

  private cancelFrame(): void {
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }
}
