import type { AnchorSet } from './anchors.ts';
import type { Experience, Level } from './types.ts';
import { packVector, unpackVector } from './vectors.ts';
import type { PackedVector } from './vectors.ts';

/**
 * Where the memory file lives. The app stores it on the device; tests keep it in memory.
 * Atomic only ever reads and writes the whole file as text.
 */
export interface MemoryStore {
  load(): Promise<string | undefined>;
  save(text: string): Promise<void>;
}

export class InMemoryStore implements MemoryStore {
  text: string | undefined;
  saves = 0;
  constructor(text?: string) {
    this.text = text;
  }
  async load() {
    return this.text;
  }
  async save(text: string) {
    this.text = text;
    this.saves++;
  }
}

type VectorFields = 'unitVector' | 'askVector' | 'responseVector' | 'levelVectors' | 'combined';

export interface StoredExperience extends Omit<Experience, VectorFields> {
  vectors: {
    unit: PackedVector;
    ask: PackedVector;
    response: PackedVector;
    combined: PackedVector;
    levels: Partial<Record<Level, PackedVector>>;
  };
}

export interface MemoryFile {
  format: 'atomic-v2';
  version: 1;
  /** Embedder the vectors came from; a different embedder means re-embedding from the raw text. */
  embedder: string;
  savedAt: string;
  anchors?: { embedder: string; fingerprint: string; vectors: Record<AnchorSet, PackedVector[]> };
  experiences: StoredExperience[];
}

export function storeExperience(experience: Experience): StoredExperience {
  const { unitVector, askVector, responseVector, levelVectors, combined, ...rest } = experience;
  const levels: Partial<Record<Level, PackedVector>> = {};
  for (const [level, vector] of Object.entries(levelVectors) as [Level, number[]][]) levels[level] = packVector(vector);
  return {
    ...rest,
    vectors: {
      unit: packVector(unitVector),
      ask: packVector(askVector),
      response: packVector(responseVector),
      combined: packVector(combined),
      levels,
    },
  };
}

export function loadExperience(stored: StoredExperience): Experience {
  const { vectors, ...rest } = stored;
  const levelVectors: Partial<Record<Level, number[]>> = {};
  for (const [level, packed] of Object.entries(vectors.levels) as [Level, PackedVector][]) levelVectors[level] = unpackVector(packed);
  return {
    ...rest,
    unitVector: unpackVector(vectors.unit),
    askVector: unpackVector(vectors.ask),
    responseVector: unpackVector(vectors.response),
    combined: unpackVector(vectors.combined),
    levelVectors,
  };
}

export function parseMemoryFile(text: string | undefined): MemoryFile | undefined {
  if (!text) return undefined;
  const parsed = JSON.parse(text) as Partial<MemoryFile>;
  if (parsed.format !== 'atomic-v2' || parsed.version !== 1 || !Array.isArray(parsed.experiences)) {
    throw new Error('not an Atomic v2 memory file');
  }
  return parsed as MemoryFile;
}
