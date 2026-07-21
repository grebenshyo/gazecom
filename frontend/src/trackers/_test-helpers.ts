/**
 * Test fixtures for tracker unit tests.
 */

import type { HeatmapPoint, HeatmapSink } from "./Tracker";

export class MockSink implements HeatmapSink {
  added: HeatmapPoint[] = [];
  history: HeatmapPoint[] = [];
  lastSetData: readonly HeatmapPoint[] = [];
  cleared = 0;

  addPoint(point: HeatmapPoint): void {
    this.added.push(point);
  }

  addHistoryPoint(point: HeatmapPoint): void {
    this.history.push(point);
  }

  setData(points: readonly HeatmapPoint[]): void {
    this.lastSetData = points.slice();
  }

  clear(): void {
    this.cleared += 1;
  }
}

/**
 * Mulberry32 — a small, deterministic RNG. Used to make tracker tests
 * reproducible across runs.
 */
export function seededRng(seed = 1): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
