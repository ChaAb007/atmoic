/**
 * Turns the bust distance field into render data: glowing points laid out along horizontal slices
 * (they read as holographic scan lines), contour line indices along some of those slices, and a
 * coarse closed shell mesh for the fresnel glow. Pure math, no three.js, so it runs anywhere.
 */

import { createRandom } from '../random.ts';
import { BUST_BOTTOM_Y, EYE, PointKind } from './anatomy.ts';
import { bustDistance, lipsDistance, smoothstep } from './sdf.ts';

export interface BustPoints {
  readonly count: number;
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly kind: Float32Array;
  readonly seed: Float32Array;
  readonly size: Float32Array;
  /** Baked shading per point: (ambient occlusion 0..1, ridge 0..1). */
  readonly shade: Float32Array;
}

export interface BustShell {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  /** Ambient occlusion per vertex, so creases do not glow like the silhouette. */
  readonly ambient: Float32Array;
  readonly index: Uint32Array;
}

export interface BustData {
  readonly points: BustPoints;
  /** Pairs of point indices tracing every other slice. */
  readonly contourIndex: Uint32Array;
  readonly shell: BustShell;
}

/** Rays cast around each slice. */
const ANGLES = 192;
/** The shell uses every n-th ray and every n-th slice. */
const SHELL_STRIDE = 2;
const CONTOUR_EVERY = 2;
const AXIS_Z = -0.05;
const MAX_RADIUS = 1.2;
const POINT_SIZE = 0.007;

interface Slice {
  readonly y: number;
  /** Surface point (x, z) for each of the ANGLES rays. */
  readonly ring: Float32Array;
}

interface PointBuffers {
  position: number[];
  normal: number[];
  kind: number[];
  seed: number[];
  size: number[];
  shade: number[];
}

type Vec3 = readonly [number, number, number];

interface SurfacePoint {
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly kind: number;
  readonly seed: number;
  readonly size: number;
  readonly shade: readonly [ambient: number, ridge: number];
}

/** How much of the detailed face region this height is in (0..1). */
function faceZone(y: number): number {
  return smoothstep(-0.6, -0.5, y) * smoothstep(0.32, 0.2, y);
}

/** Vertical distance between slices, measured along the surface. */
function sliceSpacing(y: number): number {
  if (y < -0.8) return 0.036;
  return 0.024 - 0.0098 * faceZone(y);
}

/** Distance between neighbouring points along a slice; finest across the front of the face. */
function pointSpacing(y: number, theta: number): number {
  if (y < -0.75) return 0.042;
  const side = Math.abs(theta);
  const front = smoothstep(1.35, 0.7, side) * faceZone(y);
  // The back of the head is dimmed in the shader, so it can be sparse.
  const back = smoothstep(1.9, 2.5, side);
  return 0.027 + 0.011 * back - 0.0105 * front;
}

function isInside(x: number, y: number, z: number): boolean {
  return bustDistance(x, y, z) < 0;
}

/**
 * Distance from the vertical axis to the surface along a horizontal ray, or 0 if the axis is
 * outside. `guess` (the neighbouring ray's answer) lets the march start close to the surface.
 */
function surfaceRadius(y: number, dx: number, dz: number, guess = 0): number {
  let t = Math.max(guess - 0.03, 0);
  let d = bustDistance(dx * t, y, AXIS_Z + dz * t);
  if (d >= 0 && t > 0) {
    t = 0;
    d = bustDistance(0, y, AXIS_Z);
  }
  if (d >= 0) return 0;
  let inside = t;
  while (t < MAX_RADIUS) {
    inside = t;
    t += Math.max(-d * 0.8, 0.004);
    d = bustDistance(dx * t, y, AXIS_Z + dz * t);
    if (d >= 0) break;
  }
  let outside = t;
  for (let i = 0; i < 8; i++) {
    const mid = (inside + outside) / 2;
    if (isInside(dx * mid, y, AXIS_Z + dz * mid)) inside = mid;
    else outside = mid;
  }
  return (inside + outside) / 2;
}

function topOfHead(): number {
  let y = 0.7;
  while (!isInside(0, y, AXIS_Z)) y -= 0.002;
  return y;
}

/**
 * Slice heights spaced evenly along the surface, so the crown and the slope of the shoulders get
 * as many as the cheeks. The probes skip the midline: small features there (nose, lips) would
 * crowd slices into bright bands across the whole face.
 */
function sliceHeights(top: number): number[] {
  const probes = [0.6, Math.PI / 2, (3 * Math.PI) / 4, Math.PI];
  const dy = 0.003;
  let previous: number[] = [];
  const radiiAt = (y: number) => probes.map((a, i) => surfaceRadius(y, Math.sin(a), Math.cos(a), previous[i]));
  const heights: number[] = [];
  previous = radiiAt(top - 0.001);
  let accumulated = 0.6;
  for (let y = top - 0.001 - dy; y > BUST_BOTTOM_Y; y -= dy) {
    const radii = radiiAt(y);
    const dr = Math.min(Math.max(...radii.map((r, i) => Math.abs(r - previous[i]))), 4 * dy);
    const before = accumulated;
    accumulated += Math.hypot(dy, dr) / sliceSpacing(y);
    for (let n = Math.floor(before) + 1; n <= accumulated; n++) {
      heights.push(y + dy * (1 - (n - before) / (accumulated - before)));
    }
    previous = radii;
  }
  return heights;
}

function angleOf(k: number): number {
  return -Math.PI + (2 * Math.PI * k) / ANGLES;
}

function traceSlice(y: number): Slice {
  const ring = new Float32Array(ANGLES * 2);
  let r = 0;
  for (let k = 0; k < ANGLES; k++) {
    const a = angleOf(k);
    r = surfaceRadius(y, Math.sin(a), Math.cos(a), r);
    ring[k * 2] = Math.sin(a) * r;
    ring[k * 2 + 1] = AXIS_Z + Math.cos(a) * r;
  }
  return { y, ring };
}

function surfaceNormal(x: number, y: number, z: number): Vec3 {
  const e = 0.0015;
  const nx = bustDistance(x + e, y, z) - bustDistance(x - e, y, z);
  const ny = bustDistance(x, y + e, z) - bustDistance(x, y - e, z);
  const nz = bustDistance(x, y, z + e) - bustDistance(x, y, z - e);
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/**
 * Baked shading so the face reads even head-on: creases (eye sockets, under the nose, lip
 * corners) darken by ambient occlusion along the normal, and tight ridges (brow, nose bridge,
 * lips, chin) brighten by local convexity.
 */
function ambientOcclusion(p: Vec3, n: Vec3): number {
  let occlusion = 0;
  let weight = 1;
  for (const h of [0.012, 0.025, 0.045, 0.07]) {
    occlusion += (weight * (h - bustDistance(p[0] + n[0] * h, p[1] + n[1] * h, p[2] + n[2] * h))) / h;
    weight *= 0.6;
  }
  return Math.min(Math.max(1 - occlusion * 1.1, 0), 1);
}

/** 0 on flat or hollow surfaces, toward 1 on tight convex ridges. */
function ridge(p: Vec3): number {
  const e = 0.02;
  const around =
    bustDistance(p[0] + e, p[1], p[2]) + bustDistance(p[0] - e, p[1], p[2]) +
    bustDistance(p[0], p[1] + e, p[2]) + bustDistance(p[0], p[1] - e, p[2]) +
    bustDistance(p[0], p[1], p[2] + e) + bustDistance(p[0], p[1], p[2] - e);
  return smoothstep(0.03, 0.2, around / 6 / e);
}

function pushPoint(out: PointBuffers, point: SurfacePoint): number {
  out.position.push(...point.position);
  out.normal.push(...point.normal);
  out.kind.push(point.kind);
  out.seed.push(point.seed);
  out.size.push(point.size);
  out.shade.push(...point.shade);
  return out.kind.length - 1;
}

/** Spreads points evenly (by local spacing) around one slice; returns their indices in order. */
function samplePointsOnSlice(slice: Slice, out: PointBuffers, random: () => number): number[] {
  const { y, ring } = slice;
  const cumulative = new Float64Array(ANGLES + 1);
  for (let k = 0; k < ANGLES; k++) {
    const next = (k + 1) % ANGLES;
    const length = Math.hypot(ring[next * 2] - ring[k * 2], ring[next * 2 + 1] - ring[k * 2 + 1]);
    cumulative[k + 1] = cumulative[k] + length / pointSpacing(y, angleOf(k) + Math.PI / ANGLES);
  }
  const total = cumulative[ANGLES];
  const count = Math.max(3, Math.round(total));
  const offset = random();
  const indices: number[] = [];
  let k = 0;
  for (let j = 0; j < count; j++) {
    const u = ((j + offset) * total) / count;
    while (cumulative[k + 1] < u) k++;
    const f = (u - cumulative[k]) / (cumulative[k + 1] - cumulative[k] || 1);
    const next = (k + 1) % ANGLES;
    const x = ring[k * 2] + (ring[next * 2] - ring[k * 2]) * f;
    const z = ring[k * 2 + 1] + (ring[next * 2 + 1] - ring[k * 2 + 1]) * f;
    const isLip = z > 0.28 && lipsDistance(x, y, z) < 0.008;
    const position: Vec3 = [x, y, z];
    const normal = surfaceNormal(x, y, z);
    indices.push(pushPoint(out, {
      position,
      normal,
      kind: isLip ? PointKind.lip : PointKind.skin,
      seed: random(),
      size: POINT_SIZE * (isLip ? 1.05 : 0.8 + 0.4 * random()),
      shade: [ambientOcclusion(position, normal), ridge(position)],
    }));
  }
  return indices;
}

/** Joins neighbouring points of a slice into line segments, skipping gaps (e.g. across the ears). */
function contourSegments(indices: readonly number[], position: readonly number[], maxGap: number): number[] {
  const segments: number[] = [];
  for (let i = 0; i < indices.length; i++) {
    const a = indices[i];
    const b = indices[(i + 1) % indices.length];
    const gap = Math.hypot(
      position[a * 3] - position[b * 3],
      position[a * 3 + 1] - position[b * 3 + 1],
      position[a * 3 + 2] - position[b * 3 + 2],
    );
    if (gap < maxGap) segments.push(a, b);
  }
  return segments;
}

/** Eyelid outlines and a glowing iris and pupil, laid on the front of each eyeball. */
function addEyes(out: PointBuffers, random: () => number): void {
  const add = (cx: number, x: number, y: number, lift: number, kind: number, size: number): void => {
    const dx = x - cx;
    const dy = y - EYE.y;
    const r = EYE.radius + lift;
    const z = EYE.z + Math.sqrt(Math.max(r * r - dx * dx - dy * dy, 0));
    pushPoint(out, {
      position: [x, y, z],
      normal: [dx / r, dy / r, (z - EYE.z) / r],
      kind,
      seed: random(),
      size: POINT_SIZE * size,
      shade: [1, 0],
    });
  };
  for (const side of [-1, 1]) {
    const cx = side * EYE.x;
    for (let i = 0; i <= 26; i++) {
      const u = -1 + (2 * i) / 26;
      const bulge = 1 - u * u;
      const upper = EYE.y + 0.004 + 0.021 * Math.pow(bulge, 0.75) + 0.003 * u * side;
      const lower = EYE.y + 0.001 - 0.012 * Math.pow(bulge, 0.85);
      for (const y of i === 0 || i === 26 ? [upper] : [upper, lower]) {
        add(cx, cx + u * 0.046, y, 0.006, PointKind.eyelid, 0.9);
      }
    }
    for (let i = 0; i < 22; i++) {
      const a = (2 * Math.PI * i) / 22;
      add(cx, cx + Math.cos(a) * 0.018, EYE.y + 0.002 + Math.sin(a) * 0.018, 0.004, PointKind.iris, 0.95);
    }
    for (let i = 0; i < 7; i++) {
      const a = (2 * Math.PI * i) / 7;
      const radius = i === 0 ? 0 : 0.0065;
      add(cx, cx + Math.cos(a) * radius, EYE.y + 0.002 + Math.sin(a) * radius, 0.005, PointKind.iris, 1.3);
    }
  }
}

function buildShell(allSlices: readonly Slice[]): BustShell {
  const slices = allSlices.filter((_, i) => i % SHELL_STRIDE === 0);
  const columns = ANGLES / SHELL_STRIDE;
  const position = new Float32Array(slices.length * columns * 3);
  const normal = new Float32Array(position.length);
  const ambient = new Float32Array(slices.length * columns);
  slices.forEach((slice, row) => {
    for (let c = 0; c < columns; c++) {
      const k = c * SHELL_STRIDE;
      const vertex = row * columns + c;
      const p: Vec3 = [slice.ring[k * 2], slice.y, slice.ring[k * 2 + 1]];
      const n = surfaceNormal(...p);
      position.set(p, vertex * 3);
      normal.set(n, vertex * 3);
      ambient[vertex] = ambientOcclusion(p, n);
    }
  });
  const index: number[] = [];
  for (let row = 0; row < slices.length - 1; row++) {
    for (let c = 0; c < columns; c++) {
      const a = row * columns + c;
      const b = row * columns + ((c + 1) % columns);
      const below = a + columns;
      const belowNext = b + columns;
      index.push(a, below, b, b, below, belowNext);
    }
  }
  return { position, normal, ambient, index: Uint32Array.from(index) };
}

/** Builds the bust once; deterministic for a given seed. */
export function buildBust(seed = 7): BustData {
  const random = createRandom(seed);
  const slices = sliceHeights(topOfHead()).map(traceSlice);
  const out: PointBuffers = { position: [], normal: [], kind: [], seed: [], size: [], shade: [] };
  const contour: number[] = [];
  slices.forEach((slice, i) => {
    const indices = samplePointsOnSlice(slice, out, random);
    if (i % CONTOUR_EVERY === 0 && slice.y > -1.05) {
      contour.push(...contourSegments(indices, out.position, pointSpacing(slice.y, Math.PI) * 2.5));
    }
  });
  addEyes(out, random);
  return {
    points: {
      count: out.kind.length,
      position: Float32Array.from(out.position),
      normal: Float32Array.from(out.normal),
      kind: Float32Array.from(out.kind),
      seed: Float32Array.from(out.seed),
      size: Float32Array.from(out.size),
      shade: Float32Array.from(out.shade),
    },
    contourIndex: Uint32Array.from(contour),
    shell: buildShell(slices),
  };
}
