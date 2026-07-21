/**
 * VLM tracker — the vision model drives tracking.
 *
 * The point is produced by the generation pipeline: after each frame is
 * generated it's sent to the vision model, which returns the single most
 * salient point (`generation/pipeline.ts` → `maybeUpdateVlmPoint`). That
 * point is stored, normalized, in `store.vlmPoint`; `buildInput` reads it
 * for the crop COM, and this tracker renders it into the heatmap.
 *
 * Rendering goes through the normal `HeatmapSink`, so the point picks up
 * the active heatmap style (Moiré rings, Blackbody, …) and the Point-size /
 * Dot-jitter sliders exactly like every other tracker's output — and,
 * because the heatmap canvas is also what `captureHeatmapOnBase` /
 * `buildInpaintingMask` capture, the point participates in standard and
 * in-/outpainting inputs too.
 *
 * Like the trail trackers, the (static) point is re-emitted every tick
 * rather than written once: the clears/rebuilds a generation triggers
 * (feedback swap, composite growth, resize) wipe one-shot writes, and the
 * re-emit refills within a frame. The historical "dot vanishes" bug was NOT
 * this loop failing but h337 silently dropping fractional coordinates —
 * fixed at the wrapper (`HeatmapInstance.withRadius` rounds).
 *
 * Before the first point exists (`getVlmPoint()` → null) the center is
 * shown, satisfying "press tracking → a point at the center".
 */

import type { Tracker, TrackerCapabilities, TrackerContext } from "./Tracker";

const TICK_MS = 16; // ~60 fps, same cadence as CursorTracker
const CENTER = { x: 0.5, y: 0.5 };

export class VLMTracker implements Tracker {
  readonly id = "vlm" as const;
  readonly capabilities: TrackerCapabilities = {
    needsCalibration: false,
    needsCamera: false,
    label: "VLM",
  };

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ctx: TrackerContext) {}

  async init(): Promise<void> {
    /* nothing to load */
  }

  async start(): Promise<void> {
    this.emit();
    this.timer = setInterval(() => this.emit(), TICK_MS);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.ctx.sink.clear();
  }

  clearHeatmap(): void {
    this.ctx.sink.clear();
  }

  /** Render the current VLM point (or the center, before one exists). */
  private emit(): void {
    const p = this.ctx.getVlmPoint?.() ?? CENTER;
    const { width, height } = this.ctx.getContainerSize();
    if (width <= 0 || height <= 0) return;
    this.ctx.sink.setData([{ x: p.x * width, y: p.y * height, value: 1 }]);
  }
}
