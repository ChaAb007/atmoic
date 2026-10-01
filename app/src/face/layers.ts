/** Builds the three.js objects of the hologram. All of them share one uniforms object. */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  LinearSRGBColorSpace,
  LineSegments,
  Matrix3,
  Mesh,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  Vector2,
  type IUniform,
} from 'three';
import type { BustData } from './bust/geometry.ts';
import {
  BUST_VERTEX,
  DOT_FRAGMENT,
  HALO_FRAGMENT,
  HALO_VERTEX,
  LINE_FRAGMENT,
  MOTES_FRAGMENT,
  MOTES_VERTEX,
  ORBITS_VERTEX,
  RIBBONS_VERTEX,
  SHELL_FRAGMENT,
  SHELL_VERTEX,
} from './shaders.ts';

export type FaceUniforms = {
  uTime: IUniform<number>;
  uPixelRatio: IUniform<number>;
  /** Pixels per world unit at distance 1 (CSS pixels). */
  uPointScale: IUniform<number>;
  uOpen: IUniform<number>;
  uWide: IUniform<number>;
  uRound: IUniform<number>;
  uBlink: IUniform<number>;
  uGaze: IUniform<Vector2>;
  uHeadRot: IUniform<Matrix3>;
  uBreath: IUniform<number>;
  uListen: IUniform<number>;
  uThink: IUniform<number>;
  uSpeak: IUniform<number>;
  uLevel: IUniform<number>;
  uEnergy: IUniform<number>;
  uColorBase: IUniform<Color>;
  uColorRim: IUniform<Color>;
  uColorAccent: IUniform<Color>;
  uIntensity: IUniform<number>;
  uScan: IUniform<number>;
  uOrbit: IUniform<number>;
  uRibbonY: IUniform<number>;
  /** 0..1 while the head materialises top to bottom. */
  uReveal: IUniform<number>;
};

/** A color whose components are used exactly as written (the shaders skip color conversion). */
export function displayColor(hex: number): Color {
  return new Color().setHex(hex, LinearSRGBColorSpace);
}

export function createUniforms(): FaceUniforms {
  return {
    uTime: { value: 0 },
    uPixelRatio: { value: 1 },
    uPointScale: { value: 500 },
    uOpen: { value: 0 },
    uWide: { value: 0 },
    uRound: { value: 0 },
    uBlink: { value: 0 },
    uGaze: { value: new Vector2() },
    uHeadRot: { value: new Matrix3() },
    uBreath: { value: 0 },
    uListen: { value: 0 },
    uThink: { value: 0 },
    uSpeak: { value: 0 },
    uLevel: { value: 0 },
    uEnergy: { value: 0 },
    uColorBase: { value: new Color() },
    uColorRim: { value: new Color() },
    uColorAccent: { value: displayColor(0xa66bff) },
    uIntensity: { value: 1 },
    uScan: { value: 1 },
    uOrbit: { value: 0 },
    uRibbonY: { value: -0.74 },
    uReveal: { value: 0 },
  };
}

function glowMaterial(
  uniforms: FaceUniforms,
  vertexShader: string,
  fragmentShader: string,
  defines: Record<string, string> = {},
): ShaderMaterial {
  return new ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    defines,
    transparent: true,
    blending: AdditiveBlending,
    // The shaders output premultiplied color (see glow() in shaders.ts), so three adds it with
    // ONE, ONE and the canvas alpha only grows where there is light.
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: false,
  });
}

function geometryWith(attributes: Record<string, BufferAttribute>): BufferGeometry {
  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(attributes)) geometry.setAttribute(name, attribute);
  return geometry;
}

export type GlowPoints = Points<BufferGeometry, ShaderMaterial>;
export type GlowMesh = Mesh<BufferGeometry, ShaderMaterial>;

export interface BustLayers {
  readonly points: GlowPoints;
  readonly contours: LineSegments<BufferGeometry, ShaderMaterial>;
  readonly shell: GlowMesh;
}

export function createBust(data: BustData, uniforms: FaceUniforms): BustLayers {
  const { points } = data;
  const attributes = {
    position: new BufferAttribute(points.position, 3),
    normal: new BufferAttribute(points.normal, 3),
    aKind: new BufferAttribute(points.kind, 1),
    aSeed: new BufferAttribute(points.seed, 1),
    aSize: new BufferAttribute(points.size, 1),
    aShade: new BufferAttribute(points.shade, 2),
  };
  // The contour lines reuse the point buffers through an index, so the GPU stores them once.
  const contourGeometry = geometryWith(attributes);
  contourGeometry.setIndex(new BufferAttribute(data.contourIndex, 1));

  const shellGeometry = geometryWith({
    position: new BufferAttribute(data.shell.position, 3),
    normal: new BufferAttribute(data.shell.normal, 3),
    aAmbient: new BufferAttribute(data.shell.ambient, 1),
  });
  shellGeometry.setIndex(new BufferAttribute(data.shell.index, 1));

  return {
    points: new Points(geometryWith(attributes), glowMaterial(uniforms, BUST_VERTEX, DOT_FRAGMENT)),
    contours: new LineSegments(contourGeometry, glowMaterial(uniforms, BUST_VERTEX, LINE_FRAGMENT, { LINES: '' })),
    shell: new Mesh(shellGeometry, glowMaterial(uniforms, SHELL_VERTEX, SHELL_FRAGMENT)),
  };
}

const DUST_COUNT = 220;
const ORB_COUNT = 34;

/** Floating dust and glass-like orbs around the head. */
export function createMotes(uniforms: FaceUniforms, random: () => number): GlowPoints {
  const count = DUST_COUNT + ORB_COUNT;
  const position = new Float32Array(count * 3);
  const seed = new Float32Array(count * 4);
  const size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const isOrb = i >= DUST_COUNT;
    const radius = isOrb ? 0.8 + 0.75 * random() : 0.55 + 1.0 * Math.sqrt(random());
    position.set([random() * Math.PI * 2, -1.25 + random() * 2.3, radius], i * 3);
    seed.set([random(), random(), random(), random()], i * 4);
    size[i] = isOrb ? 0.03 + 0.045 * random() : 0.006 + 0.007 * random();
  }
  const geometry = geometryWith({
    position: new BufferAttribute(position, 3),
    aSeed: new BufferAttribute(seed, 4),
    aSize: new BufferAttribute(size, 1),
  });
  return new Points(geometry, glowMaterial(uniforms, MOTES_VERTEX, MOTES_FRAGMENT));
}

/** Points laid out as (u along a strand, strand index); the vertex shader shapes them. */
function strandGeometry(strands: number, perStrand: number, span: number): BufferGeometry {
  const position = new Float32Array(strands * perStrand * 3);
  for (let s = 0; s < strands; s++) {
    for (let i = 0; i < perStrand; i++) position.set([(i / perStrand) * span, s, 0], (s * perStrand + i) * 3);
  }
  return geometryWith({ position: new BufferAttribute(position, 3) });
}

export function createOrbits(uniforms: FaceUniforms): GlowPoints {
  return new Points(strandGeometry(3, 130, Math.PI * 2), glowMaterial(uniforms, ORBITS_VERTEX, DOT_FRAGMENT));
}

export function createRibbons(uniforms: FaceUniforms): GlowPoints {
  return new Points(strandGeometry(4, 150, 1), glowMaterial(uniforms, RIBBONS_VERTEX, DOT_FRAGMENT));
}

export function createHalo(uniforms: FaceUniforms): GlowMesh {
  const halo = new Mesh(new PlaneGeometry(3.6, 3.6), glowMaterial(uniforms, HALO_VERTEX, HALO_FRAGMENT));
  halo.position.set(0, -0.05, -0.7);
  return halo;
}
