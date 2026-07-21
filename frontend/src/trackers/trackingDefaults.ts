/**
 * Per-mode tracking and heatmap defaults.
 *
 * Kept in its own lightweight module (rather than the trackers barrel) so
 * the store can import it without pulling in every tracker class — the
 * store is imported almost everywhere, and this file has no heavy deps.
 *
 * Each mode starts from one of these values, then keeps its own persisted
 * speed/trail/dot profile. Heatmap style is intentionally absent: it is a
 * single global selection shared across modes.
 */

import type { TrackingMode } from "../store";

export interface TrackingModeDefaults {
  roamSpeed: number;
  trailLength: number;
  pointSize: number;
  pointJitter: number;
}

export const TRACKING_MODE_DEFAULTS: Record<
  TrackingMode,
  TrackingModeDefaults
> = {
  webgazer: {
    roamSpeed: 0.2,
    trailLength: 100,
    pointSize: 50,
    pointJitter: 0,
  },
  handpose: {
    roamSpeed: 0.2,
    trailLength: 200,
    pointSize: 50,
    pointJitter: 0,
  },
  roam: {
    roamSpeed: 0.2,
    trailLength: 300,
    pointSize: 50,
    pointJitter: 0,
  },
  roam2: {
    roamSpeed: 2,
    trailLength: 100,
    pointSize: 10,
    pointJitter: 50,
  },
  msi: {
    roamSpeed: 0.2,
    trailLength: 1000,
    pointSize: 100,
    pointJitter: 0,
  },
  cursor: {
    roamSpeed: 0.2,
    trailLength: 100,
    pointSize: 50,
    pointJitter: 0,
  },
  vlm: {
    roamSpeed: 0.2,
    trailLength: 100,
    pointSize: 50,
    pointJitter: 0,
  },
};
