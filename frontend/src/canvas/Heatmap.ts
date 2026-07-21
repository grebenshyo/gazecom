/**
 * Heatmap style configurations.
 *
 * Ported verbatim from legacy js/heatmap.js. The Moiré gradient is the
 * project's signature look — its 8-cycle band layout is preserved exactly.
 *
 * The h337 wrapper (createHeatmapInstance / applyHeatmapStyle) lives in
 * the React layer (HeatmapView.tsx, Phase 4) — this module only owns the
 * static style data so it can be imported without DOM or h337 globals.
 */

export type HeatmapStyleName = "classic" | "grayscale" | "moire" | "spectral";

export interface HeatmapStyle {
  radius: number;
  maxOpacity: number;
  minOpacity: number;
  blur: number;
  /** h337 gradient: { "0.0": "#color", ..., "1.0": "#color" } */
  gradient: Record<string, string>;
}

export const heatmapStyles: Record<HeatmapStyleName, HeatmapStyle> = {
  classic: {
    radius: 60,
    maxOpacity: 0.75,
    minOpacity: 0.1,
    blur: 0.75,
    gradient: {
      "0.4": "blue",
      "0.6": "cyan",
      "0.7": "lime",
      "0.8": "yellow",
      "1.0": "red",
    },
  },
  grayscale: {
    radius: 60,
    maxOpacity: 0.75,
    minOpacity: 0.1,
    blur: 0.75,
    gradient: {
      "0.4": "#333",
      "0.6": "#777",
      "0.7": "#aaa",
      "0.8": "#ccc",
      "1.0": "#fff",
    },
  },
  // 8-cycle black/white moiré bands. Do not "simplify" — the visual signature
  // depends on the exact stop placement.
  moire: {
    radius: 60,
    blur: 0.75,
    minOpacity: 0.5,
    maxOpacity: 0.85,
    gradient: {
      "0.00": "#000",
      "0.05": "#000",
      "0.055": "#111",
      "0.06": "#eee",
      "0.065": "#fff",
      "0.12": "#fff",
      "0.125": "#eee",
      "0.13": "#111",
      "0.135": "#000",

      "0.19": "#000",
      "0.195": "#111",
      "0.20": "#eee",
      "0.205": "#fff",
      "0.25": "#fff",
      "0.255": "#eee",
      "0.26": "#111",
      "0.265": "#000",

      "0.31": "#000",
      "0.315": "#111",
      "0.32": "#eee",
      "0.325": "#fff",
      "0.37": "#fff",
      "0.375": "#eee",
      "0.38": "#111",
      "0.385": "#000",

      "0.43": "#000",
      "0.435": "#111",
      "0.44": "#eee",
      "0.445": "#fff",
      "0.49": "#fff",
      "0.495": "#eee",
      "0.50": "#111",
      "0.505": "#000",

      "0.55": "#000",
      "0.555": "#111",
      "0.56": "#eee",
      "0.565": "#fff",
      "0.61": "#fff",
      "0.615": "#eee",
      "0.62": "#111",
      "0.625": "#000",

      "0.67": "#000",
      "0.675": "#111",
      "0.68": "#eee",
      "0.685": "#fff",
      "0.73": "#fff",
      "0.735": "#eee",
      "0.74": "#111",
      "0.745": "#000",

      "0.79": "#000",
      "0.795": "#111",
      "0.80": "#eee",
      "0.805": "#fff",
      "0.85": "#fff",
      "0.855": "#eee",
      "0.86": "#111",
      "0.865": "#000",

      "0.91": "#000",
      "0.915": "#111",
      "0.92": "#eee",
      "0.925": "#fff",
      "0.97": "#fff",
      "0.975": "#eee",
      "0.98": "#111",
      "0.985": "#000",

      "1.00": "#000",
    },
  },
  spectral: {
    radius: 56,
    maxOpacity: 0.9,
    minOpacity: 0.05,
    blur: 0.3,
    gradient: {
      "0.0": "transparent",
      "0.12": "#1a0033",
      "0.25": "#4a0080",
      "0.37": "#0066cc",
      "0.5": "#00cc66",
      "0.62": "#cccc00",
      "0.75": "#ff6600",
      "0.87": "#ff0000",
      "1.0": "#ffffff",
    },
  },
};

export const DEFAULT_HEATMAP_STYLE: HeatmapStyleName = "moire";

/**
 * Compute the center-of-mass of a heatmap data set. Returns normalized [0, 1]
 * coordinates against the given container dimensions.
 *
 * Ported from legacy image-processor.js:113-169 but as a pure function: the
 * caller passes in the data points and container dimensions instead of
 * pulling them off `window.heatmapInstance` and a DOM element.
 *
 * h337's `getData()` returns points whose `x` / `y` come from `for…in`
 * iteration over an object, so they're STRING keys, not numbers (see
 * heatmap.js _unOrganizeData). Number.isFinite(string) is always false,
 * so a strict check would skip every point and return the center default.
 * Coerce defensively — works whether the caller supplies numbers (our
 * trackers' trail points) or strings (h337 round-trip).
 */
export interface HeatmapPoint {
  x: number;
  y: number;
  value: number;
}

export function gazeCOM(
  data: readonly HeatmapPoint[],
  container: { width: number; height: number },
): { x: number; y: number } {
  if (data.length === 0 || container.width === 0 || container.height === 0) {
    return { x: 0.5, y: 0.5 };
  }

  let sx = 0;
  let sy = 0;
  let sv = 0;
  for (const p of data) {
    const x = Number(p.x);
    const y = Number(p.y);
    const v = Number(p.value);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(v)) {
      sx += x * v;
      sy += y * v;
      sv += v;
    }
  }

  if (sv === 0) {
    return { x: 0.5, y: 0.5 };
  }

  return {
    x: clamp01(sx / sv / container.width),
    y: clamp01(sy / sv / container.height),
  };
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
