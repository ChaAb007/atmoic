/** Frame-rate independent easing and the small idle behaviours that make the face feel alive. */

import type { MouthShape } from '../contracts.ts';

/**
 * Critically damped spring, solved exactly per step so it is stable at any frame time and never
 * overshoots (no lip jitter).
 */
export class CriticalSpring {
  value: number;
  private velocity = 0;

  constructor(initial = 0) {
    this.value = initial;
  }

  /** omega ≈ 4.74 / (seconds to cover 95% of a step). */
  step(target: number, dt: number, omega: number): number {
    const offset = this.value - target;
    const decay = Math.exp(-omega * dt);
    const j = this.velocity + omega * offset;
    this.value = target + (offset + j * dt) * decay;
    this.velocity = (this.velocity - j * omega * dt) * decay;
    return this.value;
  }
}

/** Mouth settles 95% of the way to a new pose in about 80 ms. */
const MOUTH_OMEGA = 4.74 / 0.08;

export class MouthEaser {
  private readonly open = new CriticalSpring();
  private readonly wide = new CriticalSpring();
  private readonly round = new CriticalSpring();
  private target: MouthShape = { open: 0, wide: 0, round: 0 };

  setTarget(shape: MouthShape): void {
    this.target = {
      open: clamp(shape.open, 0, 1),
      wide: clamp(shape.wide, -1, 1),
      round: clamp(shape.round, 0, 1),
    };
  }

  step(dt: number): MouthShape {
    return {
      open: clamp(this.open.step(this.target.open, dt, MOUTH_OMEGA), 0, 1),
      wide: clamp(this.wide.step(this.target.wide, dt, MOUTH_OMEGA), -1, 1),
      round: clamp(this.round.step(this.target.round, dt, MOUTH_OMEGA), 0, 1),
    };
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : min;
}

/** Exponential approach toward target; rate is roughly 1 / time constant in seconds. */
export function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** Blinks every few seconds; returns lid closure 0..1. */
export class Blinker {
  private nextAt: number;
  private startedAt = -1;
  private readonly random: () => number;

  constructor(random: () => number) {
    this.random = random;
    this.nextAt = 1.5 + random() * 2;
  }

  closure(time: number): number {
    const duration = 0.17;
    if (this.startedAt < 0 && time >= this.nextAt) this.startedAt = time;
    if (this.startedAt < 0) return 0;
    const progress = (time - this.startedAt) / duration;
    if (progress >= 1) {
      this.startedAt = -1;
      // Now and then a quick double blink.
      this.nextAt = time + (this.random() < 0.15 ? 0.25 : 2.5 + this.random() * 3.5);
      return 0;
    }
    return Math.sin(Math.PI * progress);
  }
}

/** Small saccades: the gaze rests, then darts to a nearby point. */
export class GazeWanderer {
  private readonly x = new CriticalSpring();
  private readonly y = new CriticalSpring();
  private targetX = 0;
  private targetY = 0;
  private nextAt = 1;
  private readonly random: () => number;

  constructor(random: () => number) {
    this.random = random;
  }

  /** Offset of the irises in head units; `biasY` nudges the gaze (e.g. up while thinking). */
  step(time: number, dt: number, biasY: number): [number, number] {
    if (time >= this.nextAt) {
      this.targetX = (this.random() - 0.5) * 0.012;
      this.targetY = (this.random() - 0.5) * 0.006;
      this.nextAt = time + 1.2 + this.random() * 2.8;
    }
    return [this.x.step(this.targetX, dt, 40), this.y.step(this.targetY + biasY, dt, 40)];
  }
}
