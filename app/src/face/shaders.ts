/**
 * GLSL for the hologram. Every layer is additive light, so draw order does not matter and nothing
 * writes depth. Colors are display values written without color-space conversion, so faint layers
 * stay faint instead of being lifted into a haze. The rig chunk (mouth, eyes, head sway,
 * breathing) is shared by the points, the contour lines and the shell, so they move together.
 */

import { BUST_BOTTOM_Y, EYE, JAW, MOUTH, NECK_PIVOT, PointKind } from './bust/anatomy.ts';

function glslFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

const RIG_CONSTANTS = /* glsl */ `
const float MOUTH_Y = ${glslFloat(MOUTH.y)};
const float HINGE_Y = ${glslFloat(JAW.hingeY)};
const float HINGE_Z = ${glslFloat(JAW.hingeZ)};
const float JAW_MAX = ${glslFloat(JAW.maxAngle)};
const float EYE_Y = ${glslFloat(EYE.y)};
const float NECK_Y = ${glslFloat(NECK_PIVOT.y)};
const float NECK_Z = ${glslFloat(NECK_PIVOT.z)};
const float BOTTOM_Y = ${glslFloat(BUST_BOTTOM_Y)};
const float KIND_LIP = ${glslFloat(PointKind.lip)};
const float KIND_EYELID = ${glslFloat(PointKind.eyelid)};
const float KIND_IRIS = ${glslFloat(PointKind.iris)};
`;

const RIG = /* glsl */ `
uniform float uTime;
uniform float uOpen;
uniform float uWide;
uniform float uRound;
uniform float uBlink;
uniform vec2 uGaze;
uniform mat3 uHeadRot;
uniform float uBreath;
uniform float uReveal;
${RIG_CONSTANTS}

// The head materialises from the crown down: 1 once the reveal line has passed height y.
float revealLine() {
  return mix(0.62, BOTTOM_Y - 0.1, uReveal);
}

float revealed(float y) {
  return smoothstep(revealLine() - 0.04, revealLine() + 0.04, y);
}

// A bright band riding the reveal line, gone once the head is complete.
float revealEdge(float y) {
  return exp(-pow((y - revealLine()) * 30.0, 2.0)) * (1.0 - smoothstep(0.85, 1.0, uReveal));
}

float mouthRegion(vec3 p) {
  vec2 d = vec2(p.x / 0.12, (p.y - MOUTH_Y) / 0.075);
  return exp(-dot(d, d) * 1.5) * smoothstep(0.14, 0.28, p.z);
}

// 1 for the lower lip, chin and jaw; the lips part sharply while the cheeks stretch softly.
float jawWeight(vec3 p) {
  float ax = abs(p.x);
  float soft = mix(0.004, 0.08, smoothstep(0.05, 0.2, ax));
  float lineY = MOUTH_Y + 0.12 * smoothstep(0.1, 0.3, ax);
  float below = 1.0 - smoothstep(lineY - soft, lineY + soft, p.y);
  return below * smoothstep(-0.2, 0.05, p.z) * smoothstep(-0.62, -0.44, p.y);
}

void rigMouth(inout vec3 p, inout vec3 n) {
  float m = mouthRegion(p);
  float wide = uWide * (1.0 - 0.6 * uRound);
  p.x *= 1.0 + m * (0.2 * wide - 0.3 * uRound);
  p.z += m * (0.03 * uRound - 0.01 * max(wide, 0.0));
  float upperLip = m * smoothstep(MOUTH_Y - 0.004, MOUTH_Y + 0.012, p.y);

  float angle = uOpen * JAW_MAX * jawWeight(p);
  float c = cos(angle);
  float s = sin(angle);
  vec2 r = vec2(p.y - HINGE_Y, p.z - HINGE_Z);
  p.yz = vec2(HINGE_Y + r.x * c - r.y * s, HINGE_Z + r.x * s + r.y * c);
  n.yz = vec2(n.y * c - n.z * s, n.y * s + n.z * c);
  p.y += upperLip * uOpen * 0.01;
}

void rigEyes(inout vec3 p, float kind) {
  if (kind < KIND_EYELID - 0.5) return;
  p.y = EYE_Y + (p.y - EYE_Y) * (1.0 - 0.9 * uBlink);
  if (kind > KIND_IRIS - 0.5) p.xy += uGaze;
}

void rigHead(inout vec3 p, inout vec3 n) {
  float w = smoothstep(NECK_Y - 0.25, NECK_Y + 0.15, p.y);
  vec3 pivot = vec3(0.0, NECK_Y, NECK_Z);
  p = mix(p, uHeadRot * (p - pivot) + pivot, w);
  n = normalize(mix(n, uHeadRot * n, w));
  float chest = 1.0 - smoothstep(-0.9, -0.6, p.y);
  p.y += uBreath * (0.005 + 0.008 * chest);
  p.x *= 1.0 + uBreath * 0.008 * chest;
}
`;

/**
 * Every fragment shader ends with glow(). The canvas is composited over the page as premultiplied
 * alpha, so a plain additive blend would pile up alpha until the canvas turned opaque and hid the
 * page background. Instead each fragment adds premultiplied light whose alpha is its brightest
 * channel: still valid premultiplied, and dark wherever the hologram is dark. Color is clamped
 * before weighting, as fixed-point blending would, so dim dots never subtract light.
 */
const GLOW = /* glsl */ `
vec4 glow(vec3 color, float alpha) {
  vec3 c = clamp(color, 0.0, 1.0) * clamp(alpha, 0.0, 1.0);
  return vec4(c, max(max(c.r, c.g), c.b));
}
`;

/**
 * 1 well inside the canvas, 0 at its edges (clip-space input). With a transparent canvas, anything
 * the viewport clipped (shoulders, rings, orbs, the halo) would otherwise end in a hard line.
 */
const EDGE = /* glsl */ `
float edgeFade(vec4 clip) {
  vec2 ndc = abs(clip.xy / max(clip.w, 1e-4));
  return (1.0 - smoothstep(0.8, 1.0, ndc.x)) * (1.0 - smoothstep(0.85, 1.0, ndc.y));
}
`;

const LIGHT = /* glsl */ `
uniform vec3 uColorBase;
uniform vec3 uColorRim;
uniform float uIntensity;
uniform float uScan;
uniform float uThink;
uniform float uListen;
uniform float uLevel;
`;

/** Bust points and contour lines (LINES defined) share this vertex shader. */
export const BUST_VERTEX = /* glsl */ `
attribute float aKind;
attribute float aSeed;
attribute float aSize;
attribute vec2 aShade;
uniform float uPixelRatio;
uniform float uPointScale;
${RIG}
${LIGHT}
${EDGE}
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec3 p = position;
  vec3 n = normal;
  rigEyes(p, aKind);
  rigMouth(p, n);
  rigHead(p, n);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 nv = normalize(normalMatrix * n);
  float facing = dot(nv, normalize(-mv.xyz));
  float rim = pow(1.0 - abs(facing), 2.0);
  float front = smoothstep(-0.25, 0.35, facing);

  // A key light from the upper left models the face like halftone: lit dots grow and brighten,
  // shadowed ones shrink and fade.
  float key = max(dot(nv, normalize(vec3(-0.5, 0.5, 0.7))), 0.0);
  float fill = max(dot(nv, normalize(vec3(0.7, 0.1, 0.7))), 0.0);
  float twinkle = 0.8 + 0.2 * sin(uTime * (0.7 + aSeed * 2.3) + aSeed * 61.0);
  float scan = exp(-pow((position.y - uScan) * 13.0, 2.0));
  float pulse = uThink * 0.2 * sin(uTime * 2.4 - position.y * 7.0 + aSeed * 1.5);
  float feature = aKind > KIND_IRIS - 0.5 ? 2.4 : (aKind > KIND_LIP - 0.5 ? 1.5 : 1.0);
  // Baked occlusion keeps crease walls (eye sockets, nostrils) from glowing like the silhouette.
  float ambient = aShade.x;
  float ridge = aShade.y;
  float lit = clamp((key * key + 0.35 * fill * fill) * ambient * (1.0 + 0.8 * ridge), 0.0, 1.0);
  float surface = 0.06 + 1.5 * lit;
  float edge = rim * ambient * ambient * (1.0 + 0.5 * ridge);
  float bright = (surface + edge) * twinkle * feature
    + scan * (0.3 + 0.7 * uThink) + pulse + uLevel * uListen * 0.3 + revealEdge(position.y) * 2.0;
  // A dark seam between the lips so the closed mouth reads as a mouth.
  float seam = mouthRegion(position) * (1.0 - smoothstep(0.003, 0.011, abs(position.y - MOUTH_Y)));

  vColor = mix(uColorBase, uColorRim, clamp(rim * 1.2 + lit * 0.45 + scan * 0.4 + (feature - 1.0) * 0.3, 0.0, 1.0))
    * bright * uIntensity;
  // The shoulders fade out downward so the face stays the focus.
  float body = mix(0.45, 1.0, smoothstep(-0.95, -0.55, position.y)) * smoothstep(BOTTOM_Y, BOTTOM_Y + 0.3, position.y);
  vAlpha = mix(0.08, 1.0, front) * body * (1.0 - 0.85 * seam) * revealed(position.y);
  if (aKind > KIND_IRIS - 0.5) vAlpha *= 1.0 - 0.85 * uBlink;
#ifdef LINES
  vAlpha *= 0.13;
#else
  float halftone = aKind > KIND_LIP - 0.5 ? 1.0 : mix(0.6, 1.35, max(lit, edge));
  gl_PointSize = aSize * halftone * uPointScale * uPixelRatio / -mv.z;
#endif
  gl_Position = projectionMatrix * mv;
  vAlpha *= edgeFade(gl_Position);
}
`;

/** Soft round dot with a bright core. */
export const DOT_FRAGMENT = /* glsl */ `
${GLOW}
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c) * 4.0;
  if (d2 > 1.0) discard;
  float falloff = (1.0 - d2) * (0.35 + 0.65 * exp(-d2 * 5.0));
  gl_FragColor = glow(vColor, vAlpha * falloff);
}
`;

export const LINE_FRAGMENT = /* glsl */ `
${GLOW}
varying vec3 vColor;
varying float vAlpha;

void main() {
  gl_FragColor = glow(vColor, vAlpha);
}
`;

export const SHELL_VERTEX = /* glsl */ `
attribute float aAmbient;
${RIG}
${EDGE}
varying float vRim;
varying float vFade;
varying float vY;

void main() {
  vec3 p = position;
  vec3 n = normal;
  rigMouth(p, n);
  rigHead(p, n);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float facing = dot(normalize(normalMatrix * n), normalize(-mv.xyz));
  // The shell only outlines the silhouette; the points draw the face itself, and the mouth opens dark.
  float faceFront = smoothstep(0.12, 0.3, position.z) * smoothstep(-0.5, -0.3, position.y);
  vRim = pow(1.0 - clamp(facing, 0.0, 1.0), 3.0) * (1.0 - faceFront) * aAmbient * aAmbient;
  vFade = smoothstep(BOTTOM_Y, BOTTOM_Y + 0.4, position.y) * mix(0.4, 1.0, smoothstep(-0.95, -0.55, position.y))
    * revealed(position.y);
  vY = p.y;
  gl_Position = projectionMatrix * mv;
  vFade *= edgeFade(gl_Position);
}
`;

export const SHELL_FRAGMENT = /* glsl */ `
uniform float uTime;
${LIGHT}
${GLOW}
varying float vRim;
varying float vFade;
varying float vY;

void main() {
  float lines = 0.8 + 0.2 * sin(vY * 260.0 - uTime * 3.0);
  float scan = exp(-pow((vY - uScan) * 9.0, 2.0));
  vec3 color = uColorRim * vRim * (0.5 * lines + 0.5 * scan) + uColorBase * 0.02;
  gl_FragColor = glow(color * uIntensity * vFade, 1.0);
}
`;

/**
 * Floating motes and orbs. position = (orbit angle, height, orbit radius); the CPU accumulates
 * uOrbit so speed changes between states never make particles jump.
 */
export const MOTES_VERTEX = /* glsl */ `
attribute vec4 aSeed;
attribute float aSize;
uniform float uTime;
uniform float uOrbit;
uniform float uPixelRatio;
uniform float uPointScale;
uniform float uSpeak;
uniform vec3 uColorRim;
uniform vec3 uColorBase;
uniform vec3 uColorAccent;
uniform float uIntensity;
${EDGE}
varying vec3 vColor;
varying float vAlpha;
varying float vOrb;

void main() {
  float angle = position.x + uOrbit * (0.5 + aSeed.x);
  float y = position.y + uTime * 0.018 * (0.4 + aSeed.w);
  y = mod(y + 1.25, 2.3) - 1.25;
  y += 0.04 * sin(uTime * (0.3 + aSeed.y * 0.5) + aSeed.z * 6.283);
  float radius = position.z * (1.0 + 0.04 * sin(uTime * 0.5 + aSeed.z * 9.0));
  vec3 p = vec3(sin(angle) * radius, y, cos(angle) * radius * 0.75 - 0.15);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth = smoothstep(-1.2, 0.6, p.z);
  float edge = smoothstep(-1.25, -0.95, y) * smoothstep(1.05, 0.75, y);
  vOrb = step(0.02, aSize);
  vec3 tint = mix(uColorRim, uColorBase, aSeed.y);
  vColor = mix(tint, uColorAccent, uSpeak * aSeed.z * 0.8) * uIntensity
    * (0.6 + 0.4 * sin(uTime * (0.8 + aSeed.x) + aSeed.w * 20.0));
  // Fade motes that drift across the face (in front or showing through) so they never cover it.
  float overFace = 1.0 - smoothstep(0.3, 0.5, length(vec2(p.x, (p.y + 0.05) * 0.72)));
  vAlpha = edge * (0.3 + 0.7 * depth) * (vOrb > 0.5 ? 0.9 : 0.85) * (1.0 - 0.9 * overFace);
  gl_PointSize = aSize * uPointScale * uPixelRatio / -mv.z;
  gl_Position = projectionMatrix * mv;
  vAlpha *= edgeFade(gl_Position);
}
`;

export const MOTES_FRAGMENT = /* glsl */ `
${GLOW}
varying vec3 vColor;
varying float vAlpha;
varying float vOrb;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c) * 4.0;
  if (d2 > 1.0) discard;
  // Orbs get a bright rim and core like small glass spheres; motes are plain soft dots.
  float sphere = 0.3 * exp(-d2 * 2.0) + 0.6 * smoothstep(0.55, 0.9, d2) * (1.0 - d2) * 4.0 + 1.2 * exp(-d2 * 14.0);
  float soft = (1.0 - d2) * exp(-d2 * 3.0);
  gl_FragColor = glow(vColor, vAlpha * mix(soft, sphere, vOrb));
}
`;

/** Listening: three tilted orbits around the head, like an atom, with comets that react to the mic. */
export const ORBITS_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uListen;
uniform float uLevel;
uniform float uPixelRatio;
uniform float uPointScale;
uniform vec3 uColorRim;
uniform float uIntensity;
${EDGE}
varying vec3 vColor;
varying float vAlpha;

void main() {
  float ring = position.y;
  float along = position.x;
  float spin = uTime * (0.55 + 0.2 * ring) * (mod(ring, 2.0) > 0.5 ? -1.0 : 1.0);
  float wobble = uLevel * 0.025 * sin(along * 3.0 + uTime * 5.0 + ring * 2.1);
  float radius = (0.56 + 0.05 * ring) * (0.9 + 0.1 * uListen) + wobble + uLevel * 0.06;
  float a = along + spin;
  vec3 p = vec3(cos(a) * radius, sin(a) * radius * 0.26, sin(a) * radius * 0.97);
  float tilt = ring * 2.0944 + 0.35 + 0.1 * sin(uTime * 0.4 + ring);
  p.xy = vec2(p.x * cos(tilt) - p.y * sin(tilt), p.x * sin(tilt) + p.y * cos(tilt));
  p.z -= 0.02;

  float trail = fract(along / 6.28318);
  float comet = pow(trail, 10.0) * 1.6;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vColor = uColorRim * uIntensity * (0.45 + comet + uLevel * 0.6);
  vAlpha = uListen * (0.35 + 0.65 * smoothstep(-0.5, 0.3, p.z));
  gl_PointSize = (0.008 + comet * 0.006) * uPointScale * uPixelRatio / -mv.z;
  gl_Position = projectionMatrix * mv;
  vAlpha *= edgeFade(gl_Position);
}
`;

/** Speaking: flowing wave ribbons near the bottom whose height follows the voice. */
export const RIBBONS_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uSpeak;
uniform float uEnergy;
uniform float uPixelRatio;
uniform float uPointScale;
uniform vec3 uColorRim;
uniform vec3 uColorAccent;
uniform float uIntensity;
uniform float uRibbonY;
${EDGE}
varying vec3 vColor;
varying float vAlpha;

void main() {
  float u = position.x;
  float i = position.y;
  float envelope = pow(sin(3.14159 * u), 1.6);
  float amplitude = (0.012 + 0.075 * uEnergy) * (1.0 - 0.17 * i);
  float wave = sin(u * (8.0 + i * 2.7) - uTime * (2.6 + i * 0.8) + i * 1.9)
    + 0.35 * sin(u * 23.0 + uTime * 4.1 + i);
  vec3 p = vec3((u - 0.5) * 1.9, uRibbonY + amplitude * envelope * wave + (i - 1.5) * 0.006, 0.5 + i * 0.03);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vColor = mix(uColorAccent, uColorRim, u * 0.45 + i * 0.08) * uIntensity * (0.65 + 0.6 * uEnergy);
  vAlpha = uSpeak * envelope * (0.95 - 0.12 * i);
  gl_PointSize = 0.011 * uPointScale * uPixelRatio / -mv.z;
  gl_Position = projectionMatrix * mv;
  vAlpha *= edgeFade(gl_Position);
}
`;

/** A cheap glow behind the head instead of a bloom pass. */
export const HALO_VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec4 vClip;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vClip = gl_Position;
}
`;

export const HALO_FRAGMENT = /* glsl */ `
uniform vec3 uColorBase;
uniform vec3 uColorRim;
uniform float uIntensity;
uniform float uListen;
uniform float uLevel;
uniform float uThink;
uniform float uTime;
varying vec2 vUv;
varying vec4 vClip;
${GLOW}
${EDGE}

void main() {
  vec2 c = (vUv - 0.5) * vec2(2.0, 2.0);
  float r2 = dot(c, c);
  float head = exp(-dot(c - vec2(0.0, 0.08), c - vec2(0.0, 0.08)) * 7.0);
  float wide = exp(-r2 * 2.2);
  float pulse = 1.0 + uThink * 0.3 * sin(uTime * 2.4) + uListen * uLevel * 0.3;
  vec3 color = (uColorBase * wide * 0.09 + uColorRim * head * 0.06) * pulse * uIntensity;
  gl_FragColor = glow(color, edgeFade(vClip));
}
`;
