/**
 * Adaptive Roam (`roam2` internally) — a roamer with three behavioral modes
 * (explore/focus/scan) that switch on a timer.
 *
 * Ported from legacy js/trackers/roamers.js (Roam2Tracker, lines 142-341).
 * Behavior weights and timers preserved exactly.
 */

import { TrailBuffer, DEFAULT_POINT_VALUE } from "./_trail";
import { clamp, resolveRoamConstraint } from "./_constraint";
import type {
  ContainerSize,
  Tracker,
  TrackerCapabilities,
  TrackerContext,
} from "./Tracker";
import type { Rng } from "./RoamTracker";

const TICK_MS = 16; // 60 fps, matches legacy line 335

type Behavior = "explore" | "focus" | "scan";

export class Roam2Tracker implements Tracker {
  readonly id = "roam2" as const;
  readonly capabilities: TrackerCapabilities = {
    needsCalibration: false,
    needsCamera: false,
    label: "Adaptive Roam",
  };

  private x = 0;
  private y = 0;
  private vx = 0;
  private vy = 0;
  private behavior: Behavior = "explore";
  private behaviorTicksLeft = 0;
  private focusPoint = { x: 0, y: 0 };
  private scanDirection = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private trail = new TrailBuffer(100);
  /** Live travel-speed multiplier (1 = unchanged); set via `setSpeed`. */
  private speedMultiplier = 1;

  constructor(
    private readonly ctx: TrackerContext,
    private readonly rng: Rng = Math.random,
  ) {}

  async init(): Promise<void> {
    /* nothing to load */
  }

  async start(): Promise<void> {
    const size = this.ctx.getContainerSize();
    const bounds = resolveRoamConstraint(this.ctx, size, 20);
    // Start near center, with up to ±100px noise (legacy line 178-180)
    this.x = clamp(
      size.width / 2 + (this.rng() - 0.5) * 200,
      bounds.minX,
      bounds.maxX,
    );
    this.y = clamp(
      size.height / 2 + (this.rng() - 0.5) * 200,
      bounds.minY,
      bounds.maxY,
    );
    this.trail.clear();
    this.selectNewBehavior(size);
    this.timer = setInterval(
      () => this.step(this.ctx.getContainerSize()),
      TICK_MS,
    );
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

  /** Public for testability — see RoamTracker.step() rationale. */
  step(size: ContainerSize): void {
    this.behaviorTicksLeft -= 1;
    if (this.behaviorTicksLeft <= 0) {
      this.selectNewBehavior(size);
    }

    const bounds = resolveRoamConstraint(this.ctx, size, 20);
    switch (this.behavior) {
      case "explore":
        if (this.rng() < 0.1) {
          this.vx += (this.rng() - 0.5) * 20;
          this.vy += (this.rng() - 0.5) * 20;
        }
        break;
      case "focus": {
        this.focusPoint = {
          x: clamp(this.focusPoint.x, bounds.minX, bounds.maxX),
          y: clamp(this.focusPoint.y, bounds.minY, bounds.maxY),
        };
        const dx = this.focusPoint.x - this.x;
        const dy = this.focusPoint.y - this.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 50) {
          this.vx += (dx / dist) * 3;
          this.vy += (dy / dist) * 3;
        } else {
          this.vx += (this.rng() - 0.5) * 2;
          this.vy += (this.rng() - 0.5) * 2;
        }
        break;
      }
      case "scan":
        this.vx = Math.cos(this.scanDirection) * 15;
        this.vy = Math.sin(this.scanDirection) * 15;
        if (this.rng() < 0.02) {
          this.scanDirection += (this.rng() - 0.5) * 0.5;
        }
        break;
    }

    this.vx *= 0.9;
    this.vy *= 0.9;

    const maxSpeed = this.behavior === "focus" ? 20 : 40;
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > maxSpeed) {
      this.vx = (this.vx / speed) * maxSpeed;
      this.vy = (this.vy / speed) * maxSpeed;
    }

    // Scale realized travel by the live speed multiplier (see
    // Tracker.setSpeed); leaves the behavior dynamics untouched.
    this.x += this.vx * this.speedMultiplier;
    this.y += this.vy * this.speedMultiplier;

    if (this.x <= bounds.minX || this.x >= bounds.maxX) {
      this.vx *= -0.7;
      this.x = clamp(this.x, bounds.minX, bounds.maxX);
      if (this.behavior === "scan") {
        this.scanDirection = Math.PI - this.scanDirection;
      }
    }
    if (this.y <= bounds.minY || this.y >= bounds.maxY) {
      this.vy *= -0.7;
      this.y = clamp(this.y, bounds.minY, bounds.maxY);
      if (this.behavior === "scan") {
        this.scanDirection = -this.scanDirection;
      }
    }

    this.trail.push({
      x: Math.round(this.x),
      y: Math.round(this.y),
      value: DEFAULT_POINT_VALUE,
    });
    this.ctx.sink.setData(this.trail.snapshot());
  }

  /** Test helper. */
  getBehavior(): Behavior {
    return this.behavior;
  }

  /** Test helper. */
  getPosition(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  private selectNewBehavior(size: ContainerSize): void {
    const bounds = resolveRoamConstraint(this.ctx, size, 20);
    const r = this.rng();
    if (r < 0.4) {
      this.behavior = "explore";
      this.behaviorTicksLeft = 120 + Math.floor(this.rng() * 180);
    } else if (r < 0.7) {
      this.behavior = "focus";
      this.behaviorTicksLeft = 60 + Math.floor(this.rng() * 120);
      this.focusPoint = {
        x: bounds.minX + this.rng() * (bounds.maxX - bounds.minX),
        y: bounds.minY + this.rng() * (bounds.maxY - bounds.minY),
      };
    } else {
      this.behavior = "scan";
      this.behaviorTicksLeft = 90 + Math.floor(this.rng() * 90);
      this.scanDirection = this.rng() * Math.PI * 2;
    }
  }
}
