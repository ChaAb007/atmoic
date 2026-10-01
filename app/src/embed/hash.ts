import type { AtomicV2Config, Embedder } from '@atomic-v2';

/** Words that carry no topic in English, Hindi or Hinglish; left out so spelling matches land on content words. */
const STOPWORDS = new Set(
  (
    'a an the and or but if so to of in on at for from by with about into over as is are was were be been being am ' +
    'do does did done have has had i me my mine we us our you your he him his she her it its they them their this ' +
    'that these those what which who whom whose when where why how there here then than too very can could will ' +
    'would shall should may might must just not no yes ok okay also all any some one up down out off again more ' +
    'hai hain ha tha thi the ka ki ke ko se me mein par pe aur ya bhi to toh kya kyu kyun kaise kab kahan kaun ' +
    'kitna kitni kitne kiya kiye kar karo karna raha rahi rahe hua hui hue ho hota hoti mera meri mere hum ham ' +
    'humne maine tum aap apna apni yeh ye woh wo vo ek na nahi nahin haan ji yaar bhai'
  ).split(' '),
);

/** Share of the vector given to topic words; the rest carries the full phrasing. */
const TOPIC_SHARE = 0.6;
const HALF = 512;

/**
 * Offline fallback embedder from hashed words and character trigrams. It knows spelling, not meaning, so the phone
 * uses it only until the on-device model is available (memory is re-embedded when the model loads), and the
 * in-chat preview uses it throughout.
 *
 * Each vector has two halves. The topic half leaves out stopwords, so "who is Arjun?" lands on the memory about
 * Arjun instead of on every sentence with "who" and "is". The phrasing half keeps every word, because Atomic's
 * layers recognise feelings, decisions and plans largely by phrasing ("I feel", "we decided", "should we").
 */
export class HashEmbedder implements Embedder {
  /**
   * Spelling overlap scores lower than meaning does: related messages land around 0.2-0.6 and unrelated ones
   * mostly below 0.2 (a single name in a long sentence can score 0.17), where the model's scale puts the cut at 0.35. Recall uses this cut while this embedder runs.
   */
  static readonly config: Partial<AtomicV2Config> = { recallMinSimilarity: 0.15 };

  readonly id = 'hash-split-1024-v2';

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const words = text.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      const topic = half(words.filter((word) => !STOPWORDS.has(word)));
      const phrasing = half(words);
      const phrasingShare = Math.sqrt(1 - TOPIC_SHARE * TOPIC_SHARE);
      const vector = [...topic.map((value) => value * TOPIC_SHARE), ...phrasing.map((value) => value * phrasingShare)];
      const length = Math.hypot(...vector);
      return length === 0 ? vector : vector.map((value) => value / length);
    });
  }
}

/** Unit vector of hashed words (weight 1) and their character trigrams (weight 0.5). */
function half(words: string[]): number[] {
  const vector = new Array<number>(HALF).fill(0);
  for (const word of words) {
    add(vector, `w:${word}`, 1);
    const padded = `#${word}#`;
    for (let index = 0; index + 3 <= padded.length; index++) add(vector, padded.slice(index, index + 3), 0.5);
  }
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((value) => value / length);
}

function add(vector: number[], feature: string, weight: number) {
  let hash = 2166136261;
  for (let index = 0; index < feature.length; index++) {
    hash ^= feature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const slot = (hash >>> 0) % vector.length;
  vector[slot] += (hash & 0x80000000 ? -1 : 1) * weight;
}
