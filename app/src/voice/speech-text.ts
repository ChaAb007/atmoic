/** Pure text helpers for the voice adapters (no platform APIs, so they run under Node tests). */

/** A slice of a longer text, with its position in that text so boundaries can be mapped back. */
export interface SpeechPiece {
  text: string;
  offset: number;
}

// Preferred places to split long text, best first.
const SENTENCE_BREAK = /[.!?…]+["'”’)\]]*\s+|[。！？]+/g;
const CLAUSE_BREAK = /[,;:–—]\s+|[，、；：]/g;
const WORD_BREAK = /\s+/g;
const BREAKS = [SENTENCE_BREAK, CLAUSE_BREAK, WORD_BREAK];

/**
 * Splits text into pieces of at most `maxChars`, preferring sentence, then clause, then word
 * boundaries. Whitespace-only text gives no pieces.
 */
export function splitForSpeech(text: string, maxChars: number): SpeechPiece[] {
  const pieces: SpeechPiece[] = [];
  let start = skipWhitespace(text, 0);
  while (start < text.length) {
    const end = text.length - start <= maxChars ? text.length : cutPoint(text, start, maxChars);
    const piece = text.slice(start, end).trimEnd();
    if (piece) pieces.push({ text: piece, offset: start });
    start = skipWhitespace(text, end);
  }
  return pieces;
}

function cutPoint(text: string, start: number, maxChars: number): number {
  const window = text.slice(start, start + maxChars);
  for (const pattern of BREAKS) {
    const at = lastBreakEnd(window, pattern);
    // A break too early would leave a tiny piece; try a finer kind of break instead.
    if (at > maxChars / 3) return start + at;
  }
  return start + maxChars;
}

function lastBreakEnd(window: string, pattern: RegExp): number {
  let end = -1;
  for (const match of window.matchAll(pattern)) end = match.index + match[0].length;
  return end;
}

function skipWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/.test(text.charAt(index))) index += 1;
  return index;
}

/** A generous upper bound for how long speaking `text` should take, used as a watchdog. */
export function speechWatchdogMs(text: string, rate: number): number {
  const msPerChar = 150; // about twice the time of ordinary speech
  return 4_000 + (text.length * msPerChar) / Math.max(rate, 0.1);
}

/** The first non-empty recognition alternative, trimmed. */
export function bestMatch(matches: readonly string[] | undefined): string {
  return matches?.map((match) => match.trim()).find((match) => match !== '') ?? '';
}

/** Shape of the Web Speech API's SpeechRecognitionResultList. */
export interface RecognitionResultsLike {
  readonly length: number;
  readonly [index: number]: { readonly length: number; readonly [index: number]: { readonly transcript: string } };
}

/** Joins the best alternative of every result (final and interim) into one transcript. */
export function joinResults(results: RecognitionResultsLike): string {
  let text = '';
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    // Space-separated languages already carry the leading space on later results.
    if (result && result.length > 0) text += result[0].transcript;
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** The BCP 47 tag to try first, then its bare language as a fallback ('en-US' -> ['en-US', 'en']). */
export function languageCandidates(lang: string): string[] {
  const tag = lang.trim().replace(/_/g, '-') || 'en-US';
  const base = tag.split('-')[0];
  return base && base !== tag ? [tag, base] : [tag];
}

/** Picks the voice for `lang`: exact tag first, then the same language; the default voice wins ties. */
export function pickVoice<V extends { lang: string; default: boolean }>(voices: readonly V[], lang: string): V | undefined {
  const wanted = normalizeLang(lang);
  const base = wanted.split('-')[0];
  const exact = voices.filter((voice) => normalizeLang(voice.lang) === wanted);
  const pool = exact.length > 0 ? exact : voices.filter((voice) => normalizeLang(voice.lang).split('-')[0] === base);
  return pool.find((voice) => voice.default) ?? pool[0];
}

function normalizeLang(lang: string): string {
  return lang.trim().replace(/_/g, '-').toLowerCase();
}
