import type { Embedder } from '@atomic-v2';

/**
 * Offline fallback embedder: hashed character trigrams and words. It knows spelling, not meaning, so it is only
 * used until the on-device model is available; memory is re-embedded with the model as soon as it loads.
 */
export class HashEmbedder implements Embedder {
  readonly id = 'hash-ngram-512-v1';
  private readonly dimensions = 512;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.vector(text));
  }

  private vector(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const words = text.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    for (const word of words) {
      this.add(vector, `w:${word}`, 1);
      const padded = `#${word}#`;
      for (let index = 0; index + 3 <= padded.length; index++) this.add(vector, padded.slice(index, index + 3), 0.5);
    }
    const length = Math.hypot(...vector);
    return length === 0 ? vector : vector.map((value) => value / length);
  }

  private add(vector: number[], feature: string, weight: number) {
    let hash = 2166136261;
    for (let index = 0; index < feature.length; index++) {
      hash ^= feature.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const slot = (hash >>> 0) % this.dimensions;
    vector[slot] += (hash & 0x80000000 ? -1 : 1) * weight;
  }
}
