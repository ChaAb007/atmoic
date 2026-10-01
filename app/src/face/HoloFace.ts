/**
 * The holographic face: a procedural human bust drawn as glowing points, contour lines and a
 * fresnel shell, with floating orbs, a listening orbit, thinking shimmer and speaking ribbons.
 * The canvas stays transparent; the page provides the background. The head is sculpted in a
 * worker and materialises top to bottom once it is ready. Throws if WebGL is unavailable.
 */

import {
  Euler,
  Matrix4,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type BufferGeometry,
  type Color,
  type Object3D,
  type ShaderMaterial,
} from 'three';
import type { Face, FaceState, MouthShape } from '../contracts.ts';
import type { BustData } from './bust/geometry.ts';
import { loadBust } from './bust/load.ts';
import {
  createBust,
  createHalo,
  createMotes,
  createOrbits,
  createRibbons,
  createUniforms,
  displayColor,
  type FaceUniforms,
  type GlowPoints,
} from './layers.ts';
import { Blinker, GazeWanderer, MouthEaser, approach, clamp } from './motion.ts';
import { createRandom } from './random.ts';

const FIELD_OF_VIEW = 30;
/** World-space box kept in view: the head, neck and the top of the shoulders. */
const FRAME = { centerY: -0.22, halfHeight: 0.86, halfWidth: 0.5 } as const;
const MAX_PIXEL_RATIO = 2;
/** Below this frame rate the render resolution steps down (never below 1x). */
const SLOW_FRAME_MS = 40;
const REVEAL_SECONDS = 1.6;

const STATES: readonly FaceState[] = ['ready', 'listening', 'thinking', 'speaking'];

interface Look {
  readonly base: Color;
  readonly rim: Color;
  readonly intensity: number;
}

const LOOKS: Record<FaceState, Look> = {
  ready: { base: displayColor(0x2a66ff), rim: displayColor(0x86d8ff), intensity: 1.15 },
  listening: { base: displayColor(0x12a8ff), rim: displayColor(0xa8f8ff), intensity: 1.45 },
  thinking: { base: displayColor(0x4b5cff), rim: displayColor(0xc0ceff), intensity: 1.2 },
  speaking: { base: displayColor(0x7550ff), rim: displayColor(0xd6b4ff), intensity: 1.3 },
};

export interface HoloFaceOptions {
  /** Step the render resolution down on slow devices (default true). */
  readonly adaptiveResolution?: boolean;
}

type Layer = Object3D & { geometry: BufferGeometry; material: ShaderMaterial };

export class HoloFace implements Face {
  private readonly canvas: HTMLCanvasElement;
  private readonly adaptiveResolution: boolean;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FIELD_OF_VIEW, 1, 0.1, 30);
  private readonly uniforms: FaceUniforms = createUniforms();
  private readonly mouth = new MouthEaser();
  private readonly blinker: Blinker;
  private readonly gaze: GazeWanderer;
  private readonly weights: Record<FaceState, number> = { ready: 1, listening: 0, thinking: 0, speaking: 0 };
  private readonly orbits: GlowPoints;
  private readonly ribbons: GlowPoints;
  private readonly layers: Layer[] = [];
  private readonly resizeObserver: ResizeObserver | null;
  private readonly headPose = { euler: new Euler(), matrix: new Matrix4() };

  private state: FaceState = 'ready';
  private targetLevel = 0;
  private level = 0;
  private energy = 0;
  private time = 0;
  private orbitPhase = 0;
  private scanPhase = 0.3;
  private pixelRatio: number;
  private frameId: number | null = null;
  private lastFrameAt: number | null = null;
  private slowFrames = { total: 0, count: 0 };
  private revealStartedAt: number | null = null;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, options: HoloFaceOptions = {}) {
    this.canvas = canvas;
    this.adaptiveResolution = options.adaptiveResolution ?? true;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    this.renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'default',
    });
    this.renderer.setClearColor(0x000000, 0);

    const random = createRandom(11);
    this.blinker = new Blinker(random);
    this.gaze = new GazeWanderer(random);

    this.orbits = createOrbits(this.uniforms);
    this.ribbons = createRibbons(this.uniforms);
    for (const layer of [createHalo(this.uniforms), createMotes(this.uniforms, random), this.orbits, this.ribbons]) {
      this.addLayer(layer);
    }
    loadBust().then(
      (data) => this.attachBust(data),
      (error: unknown) => console.error('HoloFace: could not sculpt the head', error),
    );

    this.resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resize());
    this.resizeObserver?.observe(canvas);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.resize();
    this.applyFrame(0);
    if (!document.hidden) this.startLoop();
  }

  /** Points drawn per frame across all layers (diagnostics). */
  get pointCount(): number {
    return this.layers
      .filter((layer) => layer.type === 'Points')
      .reduce((sum, layer) => sum + layer.geometry.getAttribute('position').count, 0);
  }

  setState(state: FaceState): void {
    this.state = state;
  }

  setInputLevel(level: number): void {
    this.targetLevel = clamp(level, 0, 1);
  }

  setMouth(shape: MouthShape): void {
    this.mouth.setTarget(shape);
  }

  resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height, false);

    const aspect = width / height;
    const tanHalf = Math.tan((FIELD_OF_VIEW * Math.PI) / 360);
    const distance = Math.max(FRAME.halfHeight / tanHalf, FRAME.halfWidth / (tanHalf * aspect));
    this.camera.aspect = aspect;
    this.camera.position.set(0, FRAME.centerY + 0.14, distance);
    this.camera.lookAt(0, FRAME.centerY, 0);
    this.camera.updateProjectionMatrix();

    this.uniforms.uPointScale.value = height / (2 * tanHalf);
    this.uniforms.uPixelRatio.value = this.pixelRatio;
    if (this.frameId === null) this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.resizeObserver?.disconnect();
    for (const layer of this.layers) {
      layer.geometry.dispose();
      layer.material.dispose();
    }
    this.renderer.dispose();
  }

  private addLayer(layer: Layer): void {
    this.scene.add(layer);
    this.layers.push(layer);
  }

  private attachBust(data: BustData): void {
    if (this.disposed) return;
    const bust = createBust(data, this.uniforms);
    for (const layer of [bust.shell, bust.contours, bust.points]) this.addLayer(layer);
    this.revealStartedAt = this.time;
  }

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.stopLoop();
    else this.startLoop();
  };

  private startLoop(): void {
    if (this.disposed || this.frameId !== null) return;
    this.lastFrameAt = null;
    this.frameId = requestAnimationFrame(this.frame);
  }

  private stopLoop(): void {
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }

  private readonly frame = (now: number): void => {
    this.frameId = requestAnimationFrame(this.frame);
    const elapsedMs = this.lastFrameAt === null ? 16 : now - this.lastFrameAt;
    this.lastFrameAt = now;
    this.adaptResolution(elapsedMs);
    // Clamp so a stalled frame does not make springs or particles leap.
    this.applyFrame(Math.min(elapsedMs / 1000, 0.05));
    this.renderer.render(this.scene, this.camera);
  };

  /** Steps the render resolution down if the device cannot keep up. */
  private adaptResolution(elapsedMs: number): void {
    if (!this.adaptiveResolution || this.pixelRatio <= 1 || elapsedMs > 250) return;
    this.slowFrames.total += elapsedMs;
    this.slowFrames.count += 1;
    if (this.slowFrames.count < 90) return;
    const average = this.slowFrames.total / this.slowFrames.count;
    this.slowFrames = { total: 0, count: 0 };
    if (average > SLOW_FRAME_MS) {
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.5);
      this.resize();
    }
  }

  private applyFrame(dt: number): void {
    this.time += dt;
    const u = this.uniforms;
    // Shader time wraps hourly so float32 precision never makes long sessions stutter.
    u.uTime.value = this.time % 3600;
    this.updateStateBlend(dt);
    this.updateMouth(dt);
    this.updateIdle(dt);

    const { listening, thinking } = this.weights;
    this.orbitPhase += dt * (0.05 + 0.22 * thinking + 0.08 * listening);
    this.scanPhase += dt / (6.5 - 3.8 * thinking);
    u.uOrbit.value = this.orbitPhase;
    u.uScan.value = 0.62 - (this.scanPhase % 1) * 1.9;
    if (this.revealStartedAt !== null) {
      u.uReveal.value = clamp((this.time - this.revealStartedAt) / REVEAL_SECONDS, 0, 1);
    }
    this.orbits.visible = u.uListen.value > 0.005;
    this.ribbons.visible = u.uSpeak.value > 0.005;
  }

  private updateStateBlend(dt: number): void {
    const u = this.uniforms;
    const base = u.uColorBase.value.setRGB(0, 0, 0);
    const rim = u.uColorRim.value.setRGB(0, 0, 0);
    let intensity = 0;
    let total = 0;
    for (const state of STATES) {
      const weight = approach(this.weights[state], state === this.state ? 1 : 0, 5, dt);
      this.weights[state] = weight;
      const look = LOOKS[state];
      base.r += look.base.r * weight;
      base.g += look.base.g * weight;
      base.b += look.base.b * weight;
      rim.r += look.rim.r * weight;
      rim.g += look.rim.g * weight;
      rim.b += look.rim.b * weight;
      intensity += look.intensity * weight;
      total += weight;
    }
    base.multiplyScalar(1 / total);
    rim.multiplyScalar(1 / total);

    const rising = this.targetLevel > this.level;
    this.level = approach(this.level, this.state === 'listening' ? this.targetLevel : 0, rising ? 25 : 6, dt);
    u.uLevel.value = this.level;
    u.uListen.value = this.weights.listening;
    u.uThink.value = this.weights.thinking;
    u.uSpeak.value = this.weights.speaking;
    u.uIntensity.value = intensity / total + this.weights.listening * this.level * 0.25;
  }

  private updateMouth(dt: number): void {
    const u = this.uniforms;
    const shape = this.mouth.step(dt);
    u.uOpen.value = shape.open;
    u.uWide.value = shape.wide;
    u.uRound.value = shape.round;
    const rising = shape.open > this.energy;
    this.energy = approach(this.energy, shape.open, rising ? 18 : 3, dt);
    u.uEnergy.value = this.energy;
  }

  /** Breathing, a slow head sway, blinks and small gaze shifts; each state leans the head a little. */
  private updateIdle(dt: number): void {
    const u = this.uniforms;
    const t = this.time;
    const { listening, thinking, speaking } = this.weights;
    u.uBreath.value = Math.sin((t * Math.PI * 2) / 4.4);
    u.uBlink.value = this.blinker.closure(t);
    const [gazeX, gazeY] = this.gaze.step(t, dt, 0.004 * thinking);
    u.uGaze.value.set(gazeX, gazeY);

    const yaw = 0.075 * Math.sin(t * 0.31) + 0.025 * Math.sin(t * 0.77 + 1.3) - 0.05 * thinking;
    const pitch = 0.02 * Math.sin(t * 0.23 + 2) + 0.03 * listening - 0.05 * thinking + 0.03 * speaking * this.energy;
    const roll = 0.015 * Math.sin(t * 0.19 + 0.5) + 0.045 * listening;
    const { euler, matrix } = this.headPose;
    matrix.makeRotationFromEuler(euler.set(pitch, yaw, roll));
    u.uHeadRot.value.setFromMatrix4(matrix);
  }
}
