/**
 * Tracker factory and barrel.
 *
 * The React layer (Phase 4) calls `createTracker(mode, ctx, refs)` and
 * receives an instance of the matching class. Switching modes is just
 * dispose-old + create-new.
 */

import type { TrackingMode } from "../store";
import { CursorTracker } from "./CursorTracker";
import { HandposeTracker, type HandposeViewRefs } from "./HandposeTracker";
import { Roam2Tracker } from "./Roam2Tracker";
import { RoamTracker } from "./RoamTracker";
import { SaliencyTracker, type SaliencyViewRefs } from "./SaliencyTracker";
import { VLMTracker } from "./VLMTracker";
import { WebGazerTracker } from "./WebGazerTracker";
import type { Tracker, TrackerContext } from "./Tracker";

export type { Tracker, TrackerContext, HeatmapPoint, HeatmapSink, TrackerCapabilities, ContainerSize } from "./Tracker";
export {
  CursorTracker,
  HandposeTracker,
  Roam2Tracker,
  RoamTracker,
  SaliencyTracker,
  VLMTracker,
  WebGazerTracker,
};

export { TRACKING_MODE_DEFAULTS } from "./trackingDefaults";

export interface TrackerRefs {
  /** Heatmap container element (used by Cursor + WebGazer for bounds). */
  container: HTMLElement | null;
  /** <video> element shared by camera-using trackers. */
  video: HTMLVideoElement | null;
  /**
   * Overlay <canvas> drawn over the video — used by Handpose to mark
   * fingertips and by MSI to draw saliency peaks. Same dimensions as
   * the video element.
   */
  vizCanvas: HTMLCanvasElement | null;
}

export function createTracker(
  mode: TrackingMode,
  ctx: TrackerContext,
  refs: () => TrackerRefs,
): Tracker {
  switch (mode) {
    case "webgazer":
      return new WebGazerTracker(ctx, () => refs().container);
    case "handpose":
      return new HandposeTracker(ctx, () => {
        const r = refs();
        return r.video
          ? ({ video: r.video, vizCanvas: r.vizCanvas } satisfies HandposeViewRefs)
          : null;
      });
    case "msi":
      return new SaliencyTracker(ctx, () => {
        const r = refs();
        return r.video
          ? ({ video: r.video, vizCanvas: r.vizCanvas } satisfies SaliencyViewRefs)
          : null;
      });
    case "roam":
      return new RoamTracker(ctx);
    case "roam2":
      return new Roam2Tracker(ctx);
    case "cursor":
      return new CursorTracker(ctx, () => refs().container);
    case "vlm":
      return new VLMTracker(ctx);
  }
}
