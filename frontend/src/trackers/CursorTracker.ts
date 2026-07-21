/**
 * Cursor tracker — follows the mouse pointer inside the heatmap container.
 *
 * Ported from legacy js/trackers/roamers.js (CursorTracker, lines 343-442).
 *
 * Refactor: the legacy version queried `document.getElementById('heatmapContainer')`
 * inside its constructor. Here the container element is supplied by the
 * Phase 4 React layer, which knows when the element exists and where it is.
 */

import { TrailBuffer, DEFAULT_POINT_VALUE } from "./_trail";
import type {
  Tracker,
  TrackerCapabilities,
  TrackerContext,
} from "./Tracker";

const TICK_MS = 16; // ~60 fps

export class CursorTracker implements Tracker {
  readonly id = "cursor" as const;
  readonly capabilities: TrackerCapabilities = {
    needsCalibration: false,
    needsCamera: false,
    label: "Cursor",
  };

  private container: HTMLElement | null = null;
  private mouseX = -1;
  private mouseY = -1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private trail = new TrailBuffer(100);
  private readonly handleMove: (e: MouseEvent) => void;

  constructor(
    private readonly ctx: TrackerContext,
    private readonly resolveContainer: () => HTMLElement | null,
  ) {
    this.handleMove = (e: MouseEvent) => {
      if (!this.container) return;
      const r = this.container.getBoundingClientRect();
      this.mouseX = e.clientX - r.left;
      this.mouseY = e.clientY - r.top;
    };
  }

  async init(): Promise<void> {
    /* nothing to load */
  }

  async start(): Promise<void> {
    this.container = this.resolveContainer();
    if (!this.container) {
      throw new Error("CursorTracker: heatmap container not found");
    }
    this.trail.clear();
    this.container.addEventListener("mousemove", this.handleMove);
    this.timer = setInterval(() => this.step(), TICK_MS);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.container) {
      this.container.removeEventListener("mousemove", this.handleMove);
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.trail.clear();
    this.container = null;
  }

  /** Live trail window length (see Tracker.setTrailLength). */
  setTrailLength(length: number): void {
    this.trail.setCapacity(length);
  }

  clearHeatmap(): void {
    this.trail.clear();
    this.ctx.sink.clear();
  }

  /**
   * One sample. Public for testability — tests call setMousePosition()
   * then step() to drive deterministically.
   */
  step(): void {
    if (this.mouseX < 0 || this.mouseY < 0) return;
    this.trail.push({
      x: Math.round(this.mouseX),
      y: Math.round(this.mouseY),
      value: DEFAULT_POINT_VALUE,
    });
    this.ctx.sink.setData(this.trail.snapshot());
  }

  /** Test helper. */
  setMousePosition(x: number, y: number): void {
    this.mouseX = x;
    this.mouseY = y;
  }

  /** Test helper. */
  getTrailLength(): number {
    return this.trail.length;
  }
}
