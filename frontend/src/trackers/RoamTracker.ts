/**
 * Algorithmic roamer — random momentum-based exploration with occasional
 * burst accelerations and direction glitches.
 *
 * Ported from legacy js/trackers/roamers.js (AutoRoamerTracker, lines 5-140).
 * The movement model is preserved: 15% chance of strong burst per tick,
 * 0.84 friction, max speed 128, periodic 10–410 px direction jumps.
 *
 * Refactor: the movement math lives in pure `step()` so tests can drive it
 * deterministically (legacy used RAF directly which is hostile to testing).
 */

import { TrailBuffer, DEFAULT_POINT_VALUE } from "./_trail";
import { clamp, resolveRoamConstraint } from "./_constraint";
import type {
  ContainerSize,
  HeatmapSink,
  Tracker,
  TrackerCapabilities,
  TrackerContext,
} from "./Tracker";

const TICK_MS = 8; // ~120 fps, matches legacy line 134

export interface RoamConfig {
  burstChance: number; // 0–1, prob per tick of an acceleration burst
  burstStrength: number; // px / tick² added during a burst
  driftStrength: number; // px / tick² added during normal drift
  friction: number; // 0–1 multiplier per tick
  maxSpeed: number; // px / tick cap
  glitchInterval: [number, number]; // ticks: glitch fires every uniform(min, max)
  glitchDistance: [number, number]; // px: glitch jump distance
  trailLength: number;
  pointValue: number;
}

export const DEFAULT_ROAM_CONFIG: RoamConfig = {
  burstChance: 0.15,
  burstStrength: 512,
  driftStrength: 64,
  friction: 0.84,
  maxSpeed: 128,
  glitchInterval: [10, 20],
  glitchDistance: [10, 410],
  trailLength: 300,
  pointValue: DEFAULT_POINT_VALUE,
};

/**
 * Random-number source — defaults to Math.random but injectable for tests.
 */
export type Rng = () => number;

export class RoamTracker implements Tracker {
  readonly id = "roam" as const;
  readonly capabilities: TrackerCapabilities = {
    needsCalibration: false,
    needsCamera: false,
    label: "Roam",
  };

  private x = 0;
  private y = 0;
  private vx = 0;
  private vy = 0;
  private glitchCounter = 0;
  private nextGlitchAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly trail: TrailBuffer;
  /** Live travel-speed multiplier (1 = unchanged); set via `setSpeed`. */
  private speedMultiplier = 1;

  constructor(
    private readonly ctx: TrackerContext,
    private readonly config: RoamConfig = DEFAULT_ROAM_CONFIG,
    private readonly rng: Rng = Math.random,
  ) {
    this.trail = new TrailBuffer(this.config.trailLength);
  }

  async init(): Promise<void> {
    /* nothing to load */
  }

  async start(): Promise<void> {
    const size = this.ctx.getContainerSize();
    const bounds = resolveRoamConstraint(this.ctx, size);
    this.x = bounds.minX + this.rng() * (bounds.maxX - bounds.minX);
    this.y = bounds.minY + this.rng() * (bounds.maxY - bounds.minY);
    this.trail.clear();
    this.scheduleGlitch();
    this.timer = setInterval(() => this.step(this.ctx.getContainerSize()), TICK_MS);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.trail.clear();
  }

  /**
   * Advance the simulation by one tick. Public so tests can drive it
   * deterministically without needing setInterval / RAF.
   */
  step(size: ContainerSize): void {
    const { config: c, rng } = this;

    // Acceleration: occasional bursts, otherwise small drift.
    if (rng() < c.burstChance) {
      this.vx += (rng() - 0.5) * c.burstStrength;
      this.vy += (rng() - 0.5) * c.burstStrength;
    } else {
      this.vx += (rng() - 0.5) * c.driftStrength;
      this.vy += (rng() - 0.5) * c.driftStrength;
    }

    // Friction.
    this.vx *= c.friction;
    this.vy *= c.friction;

    // Speed cap.
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > c.maxSpeed) {
      this.vx = (this.vx / speed) * c.maxSpeed;
      this.vy = (this.vy / speed) * c.maxSpeed;
    }

    // Apply velocity, scaled by the live speed multiplier. Scaling the
    // realized travel (rather than the velocity state itself) keeps the
    // burst/friction/cap dynamics — and the movement's character —
    // intact while making the roamer cover ground faster or slower.
    this.x += this.vx * this.speedMultiplier;
    this.y += this.vy * this.speedMultiplier;

    // Periodic glitches: hard direction jumps to mimic eye saccades / loss
    // of tracking.
    this.glitchCounter += 1;
    if (this.glitchCounter >= this.nextGlitchAt) {
      const [minD, maxD] = c.glitchDistance;
      const jumpDistance = minD + rng() * (maxD - minD);
      const jumpAngle = rng() * Math.PI * 2;
      this.x += Math.cos(jumpAngle) * jumpDistance;
      this.y += Math.sin(jumpAngle) * jumpDistance;
      this.glitchCounter = 0;
      this.scheduleGlitch();
    }

    // Bounce off the current roam bounds. In bounded composite mode these are
    // tighter than the heatmap frame, so the next COM steers back inward.
    const bounds = resolveRoamConstraint(this.ctx, size);
    if (this.x <= bounds.minX || this.x >= bounds.maxX) {
      this.vx *= -0.8;
      this.x = clamp(this.x, bounds.minX, bounds.maxX);
    }
    if (this.y <= bounds.minY || this.y >= bounds.maxY) {
      this.vy *= -0.8;
      this.y = clamp(this.y, bounds.minY, bounds.maxY);
    }

    // Emit point.
    this.trail.push({
      x: Math.round(this.x),
      y: Math.round(this.y),
      value: c.pointValue,
    });
    this.ctx.sink.setData(this.trail.snapshot());
  }

  /** Live travel-speed multiplier (roam-only; see Tracker.setSpeed). */
  setSpeed(multiplier: number): void {
    this.speedMultiplier = multiplier;
  }

  /** Live trail window length (see Tracker.setTrailLength). */
  setTrailLength(length: number): void {
    this.trail.setCapacity(length);
  }

  clearHeatmap(): void {
    this.trail.clear();
    this.ctx.sink.clear();
  }

  /** Test helper. */
  getPosition(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  private scheduleGlitch(): void {
    const [minI, maxI] = this.config.glitchInterval;
    this.nextGlitchAt = Math.floor(minI + this.rng() * (maxI - minI));
  }
}

// Re-export sink type so consumers don't need to import from Tracker.ts
export type { HeatmapSink };
