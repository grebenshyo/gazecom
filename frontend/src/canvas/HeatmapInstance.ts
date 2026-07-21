/**
 * Wrapper around h337 that satisfies the HeatmapSink interface used by the
 * trackers.
 *
 * Replaces legacy js/heatmap.js where `window.heatmapInstance` was the only
 * communication channel between trackers and the heatmap. Now the trackers
 * receive a sink at construction time; this class is one possible
 * implementation.
 */

import h337, {
  type HeatmapInstance as H337Instance,
  type HeatmapPoint as H337Point,
} from "heatmap.js";

import { heatmapStyles, type HeatmapStyleName } from "./Heatmap";
import {
  DEFAULT_EVENT_HISTORY_LENGTH,
  EventHistory,
} from "./EventHistory";
import type { HeatmapPoint, HeatmapSink } from "../trackers/Tracker";

const CANONICAL_HEATMAP_SIZE = 1024;

function createHeatmapWithReadbackHint(
  config: Parameters<typeof h337.create>[0],
): H337Instance {
  if (typeof HTMLCanvasElement === "undefined") {
    return h337.create(config);
  }
  const originalGetContext = HTMLCanvasElement.prototype.getContext as (
    this: HTMLCanvasElement,
    contextId: string,
    options?: unknown,
  ) => RenderingContext | null;

  HTMLCanvasElement.prototype.getContext = function patchedGetContext(
    this: HTMLCanvasElement,
    contextId: string,
    options?: unknown,
  ) {
    if (contextId !== "2d") {
      return originalGetContext.call(this, contextId, options);
    }
    const nextOptions =
      typeof options === "object" && options !== null
        ? { ...options, willReadFrequently: true }
        : { willReadFrequently: true };
    return originalGetContext.call(this, contextId, nextOptions);
  } as HTMLCanvasElement["getContext"];

  try {
    return h337.create(config);
  } finally {
    HTMLCanvasElement.prototype.getContext =
      originalGetContext as HTMLCanvasElement["getContext"];
  }
}

export class HeatmapInstance implements HeatmapSink {
  private inst: H337Instance;
  /** Per-point dot radius (px). Overrides the style's global radius. */
  private pointSize = 30;
  /** ± px random variation of the dot radius (0 = uniform). */
  private jitter = 0;
  /** Current style, so a resize-driven rebuild can preserve it. */
  private style: HeatmapStyleName;
  /** Container size h337's canvas was last built against. */
  private builtW = 0;
  private builtH = 0;
  private resizeObs: ResizeObserver | null = null;
  private readonly eventHistory = new EventHistory(
    DEFAULT_EVENT_HISTORY_LENGTH,
  );
  private eventHistoryMode = false;
  private eventHistoryFrame: number | null = null;

  constructor(
    private readonly container: HTMLElement,
    style: HeatmapStyleName = "moire",
  ) {
    this.style = style;
    this.inst = this.create(style);
    // h337 sizes its shadow canvas from the container *once*, at creation,
    // and never resizes. If the container is 0-sized at mount (async
    // layout: the frame's height follows aspect-ratio / a sibling image
    // load, or the pane was toggled off-screen), every render would call
    // getImageData(w, 0) and throw. Rebuild whenever the container gains
    // or changes size so the heatmap self-heals once it has real bounds.
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => this.syncSize());
      this.resizeObs.observe(this.container);
    }
  }

  /** True once the container has real (non-zero) dimensions. */
  private hasSize(): boolean {
    return this.container.clientWidth > 0 && this.container.clientHeight > 0;
  }

  /**
   * Re-sync the h337 canvas to the current container size. The internal
   * ResizeObserver already does this on layout changes, but its delivery is
   * tied to the rendering lifecycle (deferred in background tabs); the React
   * layer calls this explicitly on a frame-zoom change so the canvas — and
   * therefore the tracker/COM coordinate space — updates deterministically.
   */
  resize(): void {
    this.syncSize();
  }

  /** Rebuild h337 if the container size changed since the last build. */
  private syncSize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    if (w === this.builtW && h === this.builtH) return;
    const data = this.eventHistoryMode ? null : this.inst.getData();
    this.rebuild();
    if (this.eventHistoryMode) {
      this.renderEventHistory();
    } else if (data?.data?.length) {
      this.inst.setData(data);
    }
  }

  /** Tear down h337's canvases and recreate the instance at current size. */
  private rebuild(): void {
    for (const el of this.container.querySelectorAll(".heatmap-canvas")) {
      el.remove();
    }
    this.inst = this.create(this.style);
  }

  /** Disconnect observers and drop h337's canvases. */
  dispose(): void {
    this.cancelEventHistoryRender();
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    for (const el of this.container.querySelectorAll(".heatmap-canvas")) {
      el.remove();
    }
  }

  /** Set the base radius in canonical 1024px heatmap space. */
  setPointSize(px: number): void {
    this.pointSize = Math.max(1, px);
    if (this.eventHistoryMode) this.scheduleEventHistoryRender();
  }

  /** Set random ± canonical-px radius variation (0 = uniform). */
  setPointJitter(px: number): void {
    this.jitter = Math.max(0, px);
    if (this.eventHistoryMode) this.scheduleEventHistoryRender();
  }

  /**
   * Attach a per-point `radius` so the panel's Point-size / Dot-jitter
   * sliders take effect. Jitter is derived deterministically from the
   * point's (x, y), so a given point keeps a stable size across frames
   * (the whole trail is re-set every tick) — dots vary but don't shimmer.
   *
   * Coordinates are rounded to integers, and this is load-bearing: h337
   * stores points in a plain array indexed by x. A fractional x becomes a
   * string property that doesn't update the array's `length`, so h337's
   * renderAll sees `data.length === 0`, clears the canvas, and draws
   * NOTHING — points with fractional coords silently vanish. Rounding here
   * makes the wrapper safe for every caller.
   */
  private withRadius(p: HeatmapPoint): H337Point {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    const size = this.currentSize();
    const radiusScale =
      Math.min(size.width, size.height) / CANONICAL_HEATMAP_SIZE;
    const baseRadius = this.pointSize * radiusScale;
    if (this.jitter <= 0) {
      return { x, y, value: p.value, radius: Math.max(1, baseRadius) };
    }
    const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    const frac = h - Math.floor(h); // [0, 1)
    const radius = Math.max(
      1,
      baseRadius + (frac * 2 - 1) * this.jitter * radiusScale,
    );
    return { x, y, value: p.value, radius };
  }

  /** Recreate the underlying h337 instance with a new style, preserving data. */
  setStyle(style: HeatmapStyleName): void {
    this.style = style;
    const data = this.eventHistoryMode ? null : this.inst.getData();
    this.rebuild();
    if (this.eventHistoryMode) {
      this.renderEventHistory();
    } else if (data?.data?.length) {
      this.inst.setData(data);
    }
  }

  /** HeatmapSink. */
  addPoint(point: HeatmapPoint): void {
    if (!this.hasSize()) return;
    this.disableEventHistoryMode();
    this.inst.addData(this.withRadius(point));
  }

  /** HeatmapSink: retain one WebGazer sample in the bounded event history. */
  addHistoryPoint(point: HeatmapPoint): void {
    if (!this.hasSize()) return;
    const size = this.currentSize();
    this.eventHistoryMode = true;
    this.eventHistory.add(point, size);
    this.scheduleEventHistoryRender();
  }

  /** Change the WebGazer history capacity, evicting oldest excess samples. */
  setEventHistoryLength(length: number): void {
    this.eventHistory.setLimit(length);
    if (this.eventHistoryMode) this.scheduleEventHistoryRender();
  }

  /** HeatmapSink. */
  setData(points: readonly HeatmapPoint[]): void {
    // Skip while the container has no size — h337's getImageData would
    // throw on a 0-height canvas. The ResizeObserver rebuilds and the
    // trackers re-set the full trail every tick, so nothing is lost.
    if (!this.hasSize()) return;
    this.disableEventHistoryMode();
    this.inst.setData({ max: 1, data: points.map((p) => this.withRadius(p)) });
  }

  /** HeatmapSink. */
  clear(): void {
    this.disableEventHistoryMode();
    if (!this.hasSize()) return;
    this.inst.setData({ max: 1, data: [] });
  }

  /** Read-only access to current data (used by gazeCOM in the pipeline). */
  getData(): { x: number; y: number; value: number }[] {
    if (this.eventHistoryMode) {
      return this.eventHistory.project(this.currentSize());
    }
    const d = this.inst.getData();
    return d?.data ?? [];
  }

  /** Pull the rendered <canvas> element h337 created — used for compositing. */
  getCanvas(): HTMLCanvasElement | null {
    return this.container.querySelector("canvas.heatmap-canvas");
  }

  private currentSize(): { width: number; height: number } {
    return {
      width: this.container.clientWidth,
      height: this.container.clientHeight,
    };
  }

  private scheduleEventHistoryRender(): void {
    if (this.eventHistoryFrame !== null) return;
    this.eventHistoryFrame = window.requestAnimationFrame(() => {
      this.eventHistoryFrame = null;
      this.renderEventHistory();
    });
  }

  private renderEventHistory(): void {
    if (!this.eventHistoryMode || !this.hasSize()) return;
    const size = this.currentSize();
    const data = this.eventHistory
      .project(size)
      .map((point) => this.withRadius(point));
    // A fixed ceiling prevents h337 from globally re-normalizing every time
    // repeated coordinates raise its internal maximum. Density still builds
    // through overlapping kernels, while FIFO eviction bounds that density.
    this.inst.setData({ max: 1, data });
  }

  private disableEventHistoryMode(): void {
    this.cancelEventHistoryRender();
    this.eventHistoryMode = false;
    this.eventHistory.clear();
  }

  private cancelEventHistoryRender(): void {
    if (this.eventHistoryFrame === null) return;
    window.cancelAnimationFrame(this.eventHistoryFrame);
    this.eventHistoryFrame = null;
  }

  private create(style: HeatmapStyleName): H337Instance {
    const config = heatmapStyles[style] ?? heatmapStyles.classic;
    // Record the size this canvas is built against so syncSize() can tell
    // when a later layout change requires a rebuild.
    this.builtW = this.container.clientWidth;
    this.builtH = this.container.clientHeight;
    return createHeatmapWithReadbackHint({
      container: this.container,
      ...config,
    });
  }
}
