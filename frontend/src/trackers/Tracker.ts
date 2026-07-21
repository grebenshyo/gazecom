/**
 * Tracker contract — single interface for all six tracking modes.
 *
 * Replaces the implicit duck-typed contract in legacy js/trackers/*.js where
 * each class happened to expose `init/start/stop/cleanup/getUIConfig` but
 * with no enforcement. Now there's one TS interface and TrackerManager
 * (Phase 4) just iterates.
 *
 * Design notes:
 * - Trackers don't import the heatmap directly. They emit points to a
 *   `HeatmapSink`. This lets us swap implementations (h337, plain canvas,
 *   tests with a mock sink) without touching tracker code.
 * - Trackers don't query the DOM for container bounds. They receive a
 *   `getContainerSize` callback so layout changes (window resize) are
 *   reflected without restarting tracking.
 * - The deterministic algorithmic trackers (roam, roam2, cursor) expose a
 *   `step()` method. Tests can call it directly without faking RAF.
 */

import type { TrackingMode } from "../store";

export interface HeatmapPoint {
  x: number;
  y: number;
  value: number;
}

export interface ContainerSize {
  width: number;
  height: number;
}

export interface RoamConstraint {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * The heatmap surface a tracker writes to. WebGazer emits discrete events into
 * a bounded history; trail-based modes replace their recent-point window as a
 * whole each tick.
 */
export interface HeatmapSink {
  /** Push one point (additive). */
  addPoint(point: HeatmapPoint): void;
  /** Retain one discrete sample in WebGazer's bounded event history. */
  addHistoryPoint(point: HeatmapPoint): void;
  /** Replace the entire dataset (used by trail-based trackers). */
  setData(points: readonly HeatmapPoint[]): void;
  /** Clear all points. */
  clear(): void;
}

export interface TrackerCapabilities {
  /** Whether the tracker needs an explicit calibration step (WebGazer). */
  needsCalibration: boolean;
  /** Whether the tracker accesses the user's webcam. */
  needsCamera: boolean;
  /** Human-readable label for the tracker mode dropdown. */
  label: string;
}

export interface Tracker {
  readonly id: TrackingMode;
  readonly capabilities: TrackerCapabilities;

  /** Idempotent setup: load deps, allocate buffers. Safe to call again. */
  init(): Promise<void>;

  /** Begin emitting points to the sink. */
  start(): Promise<void>;

  /**
   * Stop emitting points. The tracker may keep models/cameras in memory if
   * stopping is reversible (saliency.start can resume after stop in legacy);
   * `dispose` is the hard release.
   */
  stop(): Promise<void>;

  /** Release all resources (camera, models, scripts). */
  dispose(): Promise<void>;

  /**
   * Live speed multiplier for the synthetic roamers (roam, roam2), scaling
   * how fast the generated point travels. Optional — only the algorithmic
   * roamers implement it; real-input trackers (webgazer, handpose, msi,
   * cursor) don't have a speed to set. Applied without restarting tracking.
   */
  setSpeed?(multiplier: number): void;

  /**
   * Live trail window length — the number of recent points kept, which
   * shapes the heatmap smear. Optional — implemented by every trail-based
   * tracker (roam, roam2, cursor, handpose, msi); the additive WebGazer
   * tracker has no trail and omits it. Applied without restarting.
   */
  setTrailLength?(length: number): void;

  /**
   * Clear any tracker-owned point buffer as well as the rendered heatmap.
   * Optional because trackers without internal heatmap state can rely on
   * the React layer calling HeatmapSink.clear() directly.
   */
  clearHeatmap?(): void;
}

/** Factory shape used by Phase 4 to spin up a tracker for a given mode. */
export interface TrackerContext {
  sink: HeatmapSink;
  getContainerSize: () => ContainerSize;
  /**
   * Optional live heatmap-space bounds for algorithmic roamers. Used to keep
   * COM-generated patches inside the composite cap without coupling trackers
   * to composite state. Real-input trackers ignore this.
   */
  getRoamConstraint?: () => RoamConstraint | null;
  /**
   * Latest VLM-driven point, normalized to [0, 1], or `null` before the
   * first point is produced. Injected by the React layer from the store so
   * the VLM tracker stays decoupled from it (mirrors `getRoamConstraint`).
   * Only `VLMTracker` reads this.
   */
  getVlmPoint?: () => { x: number; y: number } | null;
}
