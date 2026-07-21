/**
 * WebGazer eye-tracking adapter.
 *
 * Ported from legacy js/trackers/webgazer.js. The library is loaded lazily
 * from its CDN on first init().
 *
 * Calibration is driven by the React layer (Phase 4): the UI presents the
 * 5-point dot sequence and calls `recordCalibrationClick(x, y)` on each
 * click. This tracker exposes the bare hooks; sequencing logic doesn't
 * belong here.
 */

import { loadScript } from "./_loadScript";
import type {
  HeatmapPoint,
  Tracker,
  TrackerCapabilities,
  TrackerContext,
} from "./Tracker";

const WEBGAZER_CDN = "https://webgazer.cs.brown.edu/webgazer.js";

interface WebGazerLib {
  begin(): Promise<unknown>;
  pause(): unknown;
  end(): unknown;
  resume(): unknown;
  clearData(): unknown;
  showVideo(b: boolean): unknown;
  showFaceOverlay(b: boolean): unknown;
  showFaceFeedbackBox(b: boolean): unknown;
  showPredictionPoints(b: boolean): unknown;
  saveDataAcrossSessions(b: boolean): unknown;
  setGazeListener(cb: (data: { x: number; y: number } | null) => void): unknown;
  recordScreenPosition(x: number, y: number, label: string): unknown;
  params: {
    showVideoPreview: boolean;
    showFaceOverlay: boolean;
    showFaceFeedbackBox: boolean;
    faceMeshSolutionPath: string;
  };
}

/**
 * Where MediaPipe FaceMesh (bundled inside webgazer) loads its runtime
 * assets (wasm, packed data, loader js). The brown.edu webgazer build
 * defaults `faceMeshSolutionPath` to the RELATIVE "./mediapipe/face_mesh",
 * which only works on sites that vendor those files — on ours it 404s and
 * `webgazer.begin()` throws ("t is not a function" inside face_mesh.js).
 * Pin the exact face_mesh version the webgazer bundle was built against
 * (0.4.1633559619, visible in its source) so js/wasm stay in lockstep.
 */
const FACE_MESH_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619";
const PREVIEW_WIDTH = 240;
const PREVIEW_HEIGHT = 180;
const PREVIEW_INSET = 8;
const PREVIEW_RADIUS = 8;
const PREVIEW_Z_INDEX = "30";
const PREVIEW_FEEDBACK_Z_INDEX = "32";

const PREVIEW_SURFACE_IDS = [
  "webgazerVideoContainer",
  "webgazerVideoFeed",
  "webgazerVideoCanvas",
  "webgazerFaceOverlay",
] as const;

const PREVIEW_OVERLAY_IDS = [
  ...PREVIEW_SURFACE_IDS,
  "webgazerFaceFeedbackBox",
] as const;

interface PreviewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PreviewLayoutBasis {
  surface: PreviewRect;
  feedback: PreviewRect | null;
}

declare global {
  interface Window {
    webgazer?: WebGazerLib;
  }
}

export class WebGazerTracker implements Tracker {
  readonly id = "webgazer" as const;
  readonly capabilities: TrackerCapabilities = {
    needsCalibration: true,
    needsCamera: true,
    label: "WebGazer",
  };

  private active = false;
  private begun = false;
  private gazeHandler: ((data: { x: number; y: number } | null) => void) | null = null;
  private previewLayoutBasis: PreviewLayoutBasis | null = null;
  private previewListenersBound = false;
  private readonly syncPreviewOverlay = () => this.layoutPreviewOverlay();

  constructor(
    private readonly ctx: TrackerContext,
    private readonly resolveContainer: () => HTMLElement | null,
  ) {}

  async init(): Promise<void> {
    if (!window.webgazer) {
      await loadScript(WEBGAZER_CDN);
    }
    const wg = this.requireLib();
    wg.params.showVideoPreview = true;
    wg.params.showFaceOverlay = false;
    wg.params.showFaceFeedbackBox = false;
    wg.saveDataAcrossSessions(this._cache);
    // Must be set before begin() — that's when webgazer constructs FaceMesh
    // and resolves its asset URLs through this path.
    wg.params.faceMeshSolutionPath = FACE_MESH_CDN;

    this.gazeHandler = (data) => {
      if (!data || !this.active) return;
      const container = this.resolveContainer();
      if (!container) return;
      const r = container.getBoundingClientRect();
      const x = data.x - r.left;
      const y = data.y - r.top;
      if (x >= 0 && y >= 0 && x <= r.width && y <= r.height) {
        const point: HeatmapPoint = { x, y, value: 1 };
        this.ctx.sink.addHistoryPoint(point);
      }
    };
    wg.setGazeListener(this.gazeHandler);
  }

  async start(): Promise<void> {
    const wg = this.requireLib();
    if (!this.begun) {
      await wg.begin();
      this.begun = true;
    }
    wg.showVideo(true);
    wg.showFaceOverlay(true);
    wg.showFaceFeedbackBox(true);
    wg.showPredictionPoints(true);
    this.bindPreviewLayoutListeners();
    this.layoutPreviewOverlay();
    window.requestAnimationFrame(this.syncPreviewOverlay);
    this.active = true;
  }

  async stop(): Promise<void> {
    // Stop tracking means "stop feeding gaze points", not "tear down the
    // camera preview". Keep WebGazer's feedback live until dispose(), which
    // happens on mode change or page unload.
    this.active = false;
  }

  async dispose(): Promise<void> {
    await this.stop();
    const wg = window.webgazer;
    if (wg) {
      try {
        if (this.begun) wg.pause();
        wg.showVideo(false);
        wg.showFaceOverlay(false);
        wg.showFaceFeedbackBox(false);
        if (this.begun) wg.end();
      } catch {
        /* WebGazer's end() can throw if called before begin(); ignore. */
      }
    }
    this.unbindPreviewLayoutListeners();
    this.previewLayoutBasis = null;
    this.begun = false;
  }

  /**
   * Called by the calibration UI when the user clicks one of the 5 dots.
   * Forwards to webgazer.recordScreenPosition for model fitting. Session
   * persistence is independent: cache mode controls whether WebGazer loads
   * and saves model data, never whether a calibration click is learned.
   */
  recordCalibrationClick(x: number, y: number): void {
    const wg = this.requireLib();
    wg.recordScreenPosition(x, y, "click");
  }

  setCacheMode(enabled: boolean): void {
    this._cache = enabled;
    window.webgazer?.saveDataAcrossSessions(enabled);
  }

  clearCalibrationData(): void {
    window.webgazer?.clearData();
  }

  clearHeatmap(): void {
    // WebGazer's red prediction marker is a separate fixed-position DOM
    // element, not part of h337, so clearing the sink alone cannot remove it.
    window.webgazer?.showPredictionPoints(false);
    this.ctx.sink.clear();
  }

  isCachingCalibration(): boolean {
    return this._cache;
  }

  private _cache = true;

  private requireLib(): WebGazerLib {
    if (!window.webgazer) {
      throw new Error("WebGazer not loaded. Call init() first.");
    }
    return window.webgazer;
  }

  private bindPreviewLayoutListeners(): void {
    if (this.previewListenersBound) return;
    window.addEventListener("resize", this.syncPreviewOverlay);
    window.addEventListener("scroll", this.syncPreviewOverlay, true);
    this.previewListenersBound = true;
  }

  private unbindPreviewLayoutListeners(): void {
    if (!this.previewListenersBound) return;
    window.removeEventListener("resize", this.syncPreviewOverlay);
    window.removeEventListener("scroll", this.syncPreviewOverlay, true);
    this.previewListenersBound = false;
  }

  private layoutPreviewOverlay(): void {
    const basis = this.getPreviewLayoutBasis();
    const container = this.resolveContainer();
    const r = container?.getBoundingClientRect();
    const maxWidth = Math.max(120, (r?.width ?? PREVIEW_WIDTH) - PREVIEW_INSET * 2);
    const width = Math.min(PREVIEW_WIDTH, maxWidth);
    const height = Math.round(width * (PREVIEW_HEIGHT / PREVIEW_WIDTH));
    const rawLeft = r ? r.right - width - PREVIEW_INSET : PREVIEW_INSET;
    const rawTop = r ? r.bottom - height - PREVIEW_INSET : PREVIEW_INSET;
    const left = clamp(rawLeft, PREVIEW_INSET, window.innerWidth - width - PREVIEW_INSET);
    const top = clamp(rawTop, PREVIEW_INSET, window.innerHeight - height - PREVIEW_INSET);

    for (const id of PREVIEW_SURFACE_IDS) {
      const el = document.getElementById(id);
      if (!el) continue;
      Object.assign(el.style, {
        position: "fixed",
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        borderRadius: `${PREVIEW_RADIUS}px`,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: PREVIEW_Z_INDEX,
      });
    }

    for (const id of PREVIEW_OVERLAY_IDS) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.style.zIndex = PREVIEW_Z_INDEX;
    }

    const feedback = document.getElementById("webgazerFaceFeedbackBox");
    if (feedback) {
      const mapped = this.mapFeedbackRect(basis, { left, top, width, height });
      Object.assign(feedback.style, {
        position: "fixed",
        left: `${mapped.left}px`,
        top: `${mapped.top}px`,
        width: `${mapped.width}px`,
        height: `${mapped.height}px`,
        borderRadius: "",
        pointerEvents: "none",
        zIndex: PREVIEW_FEEDBACK_Z_INDEX,
      });
    }
  }

  private getPreviewLayoutBasis(): PreviewLayoutBasis | null {
    if (this.previewLayoutBasis) {
      if (!this.previewLayoutBasis.feedback) {
        this.previewLayoutBasis.feedback = readRect(
          document.getElementById("webgazerFaceFeedbackBox"),
        );
      }
      return this.previewLayoutBasis;
    }
    const surface = readRect(
      document.getElementById("webgazerVideoContainer") ??
        document.getElementById("webgazerVideoFeed"),
    );
    if (!surface) return null;
    this.previewLayoutBasis = {
      surface,
      feedback: readRect(document.getElementById("webgazerFaceFeedbackBox")),
    };
    return this.previewLayoutBasis;
  }

  private mapFeedbackRect(
    basis: PreviewLayoutBasis | null,
    target: PreviewRect,
  ): PreviewRect {
    if (basis?.feedback) {
      const scaleX = target.width / basis.surface.width;
      const scaleY = target.height / basis.surface.height;
      return {
        left: target.left + (basis.feedback.left - basis.surface.left) * scaleX,
        top: target.top + (basis.feedback.top - basis.surface.top) * scaleY,
        width: basis.feedback.width * scaleX,
        height: basis.feedback.height * scaleY,
      };
    }

    const width = target.width * 0.5;
    const height = target.height * 0.5;
    return {
      left: target.left + (target.width - width) / 2,
      top: target.top + (target.height - height) / 2,
      width,
      height,
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function readRect(el: HTMLElement | null): PreviewRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return {
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
  };
}
