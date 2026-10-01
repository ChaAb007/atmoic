export function dot(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index++) sum += left[index] * right[index];
  return sum;
}

export function norm(vector: number[]): number {
  return Math.sqrt(dot(vector, vector));
}

export function cosine(left: number[] | undefined, right: number[] | undefined): number {
  if (!left || !right) return 0;
  const denominator = norm(left) * norm(right);
  return denominator === 0 ? 0 : dot(left, right) / denominator;
}

export function normalize(vector: number[]): number[] {
  const length = norm(vector);
  return length === 0 ? vector.slice() : vector.map((value) => value / length);
}

/** Weighted sum of vectors (all the same dimension), normalised. */
export function blend(parts: { vector: number[]; weight: number }[]): number[] {
  const used = parts.filter((part) => part.weight > 0 && part.vector.length > 0);
  if (!used.length) return [];
  const sum = new Array<number>(used[0].vector.length).fill(0);
  for (const part of used) {
    const unit = normalize(part.vector);
    for (let index = 0; index < sum.length; index++) sum[index] += part.weight * (unit[index] ?? 0);
  }
  return normalize(sum);
}

export function maxCosine(vector: number[], against: number[][]): number {
  let best = 0;
  for (const other of against) best = Math.max(best, cosine(vector, other));
  return best;
}

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

/** Smooth 0..1 ramp between edge0 and edge1. */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Vectors are stored as int8 with one scale per vector: about 4x smaller than float32 and still
 * accurate to ~1% in cosine, which is all memory search needs.
 */
export interface PackedVector {
  scale: number;
  data: string;
}

export function packVector(vector: number[]): PackedVector {
  const peak = vector.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const scale = peak === 0 ? 1 : peak / 127;
  const bytes = new Int8Array(vector.length);
  for (let index = 0; index < vector.length; index++) bytes[index] = Math.round(vector[index] / scale);
  let binary = '';
  const view = new Uint8Array(bytes.buffer);
  for (let index = 0; index < view.length; index++) binary += String.fromCharCode(view[index]);
  return { scale, data: btoa(binary) };
}

export function unpackVector(packed: PackedVector): number[] {
  const binary = atob(packed.data);
  const view = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) view[index] = binary.charCodeAt(index);
  return Array.from(new Int8Array(view.buffer), (value) => value * packed.scale);
}
