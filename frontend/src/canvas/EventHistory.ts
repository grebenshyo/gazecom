import type { HeatmapPoint } from "../trackers/Tracker";

export interface HeatmapSize {
  width: number;
  height: number;
}

export const DEFAULT_EVENT_HISTORY_LENGTH = 300;

interface NormalizedSample {
  x: number;
  y: number;
  value: number;
}

/**
 * Bounded FIFO history in normalized heatmap coordinates.
 *
 * Samples remain discrete events rather than a time-based trail. Normalized
 * storage lets a live history survive frame resizing without drifting, while
 * the circular buffer keeps memory and rendered density strictly bounded.
 */
export class EventHistory {
  private samples: NormalizedSample[] = [];
  private oldestIndex = 0;

  constructor(private limit: number) {
    this.limit = normalizeLimit(limit);
  }

  add(point: HeatmapPoint, size: HeatmapSize): void {
    if (size.width <= 0 || size.height <= 0) return;
    const value = Number(point.value);
    if (!Number.isFinite(value) || value <= 0) return;

    const sample = {
      x: clamp01(point.x / size.width),
      y: clamp01(point.y / size.height),
      value,
    };

    if (this.samples.length < this.limit) {
      this.samples.push(sample);
      return;
    }

    this.samples[this.oldestIndex] = sample;
    this.oldestIndex = (this.oldestIndex + 1) % this.samples.length;
  }

  setLimit(limit: number): void {
    const nextLimit = normalizeLimit(limit);
    if (nextLimit === this.limit) return;

    const ordered = this.orderedSamples();
    this.limit = nextLimit;
    this.samples = ordered.slice(-nextLimit);
    this.oldestIndex = 0;
  }

  clear(): void {
    this.samples = [];
    this.oldestIndex = 0;
  }

  project(size: HeatmapSize): HeatmapPoint[] {
    if (size.width <= 0 || size.height <= 0) return [];
    return this.orderedSamples().map((sample) => ({
      x: sample.x * size.width,
      y: sample.y * size.height,
      value: sample.value,
    }));
  }

  get length(): number {
    return this.samples.length;
  }

  private orderedSamples(): NormalizedSample[] {
    if (this.oldestIndex === 0) return this.samples.slice();
    return [
      ...this.samples.slice(this.oldestIndex),
      ...this.samples.slice(0, this.oldestIndex),
    ];
  }
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.round(value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
