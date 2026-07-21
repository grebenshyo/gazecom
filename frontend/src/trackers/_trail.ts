/**
 * Trail buffer used by Roam/Adaptive Roam/Cursor/Handpose/MSI.
 *
 * Each tracker pushes a point per tick and the heatmap displays the most
 * recent N. Legacy code re-implemented this in five places with a magic
 * "100" trail length and an inline `while (trail.length > 100) shift()`
 * loop. This module owns the contract.
 */

import type { HeatmapPoint } from "./Tracker";

export const DEFAULT_TRAIL_LENGTH = 100;

/** Default value emitted per trail point — matches legacy AutoRoamer. */
export const DEFAULT_POINT_VALUE = 20;

export class TrailBuffer {
  private data: HeatmapPoint[] = [];

  constructor(private maxLength = DEFAULT_TRAIL_LENGTH) {}

  push(point: HeatmapPoint): void {
    this.data.push(point);
    if (this.data.length > this.maxLength) {
      // shift in batches to avoid O(n²) when length blows out.
      this.data.splice(0, this.data.length - this.maxLength);
    }
  }

  /**
   * Resize the sliding window (number of recent points kept). Trims
   * immediately when shrinking so the heatmap reshapes on the next tick.
   * Driven by the panel's trail-length slider via each tracker's
   * `setTrailLength`.
   */
  setCapacity(maxLength: number): void {
    this.maxLength = Math.max(1, Math.floor(maxLength));
    if (this.data.length > this.maxLength) {
      this.data.splice(0, this.data.length - this.maxLength);
    }
  }

  /** Read-only snapshot for HeatmapSink.setData(). */
  snapshot(): readonly HeatmapPoint[] {
    return this.data;
  }

  clear(): void {
    this.data = [];
  }

  get length(): number {
    return this.data.length;
  }
}
