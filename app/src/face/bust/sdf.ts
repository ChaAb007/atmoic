/**
 * Signed distance field of a calm human bust, built from smoothly blended ellipsoids and capsules.
 * Negative inside, positive outside. The ellipsoid distance is iq's approximation, which is not an
 * exact bound, so callers march with conservative steps and bisect to the surface.
 */

import { EYE, MOUTH } from './anatomy.ts';

function length3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Polynomial smooth minimum: blends two shapes over a band of width k. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Smooth maximum, used with a negated shape to carve it out. */
function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

function ellipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number): number {
  const k0 = length3(x / rx, y / ry, z / rz);
  const k1 = length3(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return k1 === 0 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}

function sphere(x: number, y: number, z: number, r: number): number {
  return length3(x, y, z) - r;
}

/** Capsule from a to b with radius r. */
function capsule(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r: number,
): number {
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const h = Math.min(Math.max((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0), 1);
  return length3(pax - bax * h, pay - bay * h, paz - baz * h) - r;
}

/** v^1.5 for v >= 0, without Math.pow (this runs a few hundred thousand times at startup). */
function pow15(v: number): number {
  return v * Math.sqrt(v);
}

/**
 * Ellipsoid squared off with exponent 2.5. Distance is the first-order estimate (k - 1) / |grad k|,
 * which is accurate near the surface where it matters.
 */
function squircleEllipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number): number {
  const ax = Math.abs(x / rx);
  const ay = Math.abs(y / ry);
  const az = Math.abs(z / rz);
  const sum = ax * pow15(ax) + ay * pow15(ay) + az * pow15(az);
  if (sum === 0) return -Math.min(rx, ry, rz);
  const k = Math.pow(sum, 0.4);
  const gradient = length3(pow15(ax) / rx, pow15(ay) / ry, pow15(az) / rz) / pow15(k);
  return (k - 1) / gradient;
}

function cranium(x: number, y: number, z: number): number {
  // Squared off a little so the crown is broad and the sides read flatter than front and back.
  return squircleEllipsoid(x, y - 0.1, z + 0.07, 0.31, 0.385, 0.43);
}

const JAW_TILT = { cos: Math.cos(0.32), sin: Math.sin(0.32) } as const;

function faceMass(x: number, y: number, z: number): number {
  // The jaw narrows toward the chin, and the jawline rises toward the ears.
  const taper = 1 - 0.36 * smoothstep(-0.06, -0.42, y);
  const dy = y + 0.1;
  const dz = z - 0.07;
  const ly = dy * JAW_TILT.cos + dz * JAW_TILT.sin;
  const lz = -dy * JAW_TILT.sin + dz * JAW_TILT.cos;
  return ellipsoid(x / taper, ly, lz, 0.262, 0.325, 0.3) * taper;
}

function nose(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  const upperBridge = capsule(x, y, z, 0, 0.075, 0.322, 0, -0.005, 0.368, 0.016);
  const lowerBridge = capsule(x, y, z, 0, -0.005, 0.368, 0, -0.075, 0.398, 0.022);
  const tip = ellipsoid(x, y + 0.102, z - 0.398, 0.031, 0.029, 0.031);
  const alae = ellipsoid(ax - 0.03, y + 0.12, z - 0.362, 0.024, 0.02, 0.026);
  return smin(smin(smin(upperBridge, lowerBridge, 0.02), tip, 0.04), alae, 0.025);
}

/** Distance to the two lips only; also used to tag lip points. */
export function lipsDistance(x: number, y: number, z: number): number {
  const upper = ellipsoid(x, y - (MOUTH.y + 0.022), z - (MOUTH.z - 0.012), 0.074, 0.021, 0.034);
  const lower = ellipsoid(x, y - (MOUTH.y - 0.024), z - (MOUTH.z - 0.018), 0.066, 0.024, 0.034);
  return Math.min(upper, lower);
}

/** Chin, cheekbones, brow, eyes, nose and lips; all lie in front of z = 0.09 and below y = 0.18. */
function frontFeatures(d: number, x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  d = smin(d, ellipsoid(x, y + 0.372, z - 0.225, 0.082, 0.052, 0.065), 0.05); // chin
  d = smin(d, ellipsoid(ax - 0.165, y + 0.03, z - 0.232, 0.095, 0.058, 0.08), 0.05); // cheekbones
  d = smin(d, ellipsoid(ax - 0.11, y - 0.108, z - 0.31, 0.1, 0.028, 0.055), 0.035); // brow ridge
  d = smax(d, -ellipsoid(ax - EYE.x, y - (EYE.y + 0.005), z - 0.37, 0.068, 0.043, 0.07), 0.04); // sockets
  d = smin(d, sphere(ax - EYE.x, y - EYE.y, z - EYE.z, EYE.radius), 0.012); // eyeballs
  d = smin(d, nose(x, y, z), 0.025);
  d = smin(d, lipsDistance(x, y, z), 0.022);
  return smax(d, -ellipsoid(x, y - MOUTH.y, z - (MOUTH.z + 0.02), MOUTH.halfWidth, 0.0035, 0.05), 0.006); // lip line
}

function head(x: number, y: number, z: number): number {
  let d = smin(cranium(x, y, z), faceMass(x, y, z), 0.08);
  // The bounds skip features that are too far away for their blends to reach this point.
  if (z > 0.09 && y > -0.48 && y < 0.18) d = frontFeatures(d, x, y, z);
  const ax = Math.abs(x);
  if (ax > 0.25 && z > -0.15 && z < 0.01 && y > -0.13 && y < 0.11) {
    d = smin(d, ellipsoid(ax - 0.305, y + 0.01, z + 0.07, 0.032, 0.1, 0.055), 0.02); // ears
  }
  return d;
}

function body(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  let d = capsule(x, y, z, 0, -0.22, -0.08, 0, -1.0, -0.06, 0.145); // neck
  d = smin(d, capsule(x, y, z, -0.5, -0.87, -0.08, 0.5, -0.87, -0.08, 0.15), 0.3); // shoulders and trapezius
  d = smin(d, ellipsoid(x, y + 1.13, z + 0.04, 0.58, 0.32, 0.24), 0.15); // chest
  return smin(d, sphere(ax - 0.66, y + 0.97, z + 0.07, 0.16), 0.12); // deltoids
}

/** Signed distance to the whole bust at (x, y, z). */
export function bustDistance(x: number, y: number, z: number): number {
  // Each part is far enough from the other outside these bands that the blend has no effect.
  if (y < -0.62) return body(x, y, z);
  if (y > 0.0) return head(x, y, z);
  return smin(head(x, y, z), body(x, y, z), 0.045);
}
