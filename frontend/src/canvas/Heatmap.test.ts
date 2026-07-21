import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEATMAP_STYLE,
  gazeCOM,
  heatmapStyles,
  type HeatmapPoint,
} from "./Heatmap";

const container = { width: 1024, height: 1024 };

describe("gazeCOM", () => {
  it("returns center when data is empty", () => {
    expect(gazeCOM([], container)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("returns center when container has zero dimensions", () => {
    const pts: HeatmapPoint[] = [{ x: 100, y: 100, value: 1 }];
    expect(gazeCOM(pts, { width: 0, height: 0 })).toEqual({ x: 0.5, y: 0.5 });
  });

  it("returns center when total weight is zero", () => {
    const pts: HeatmapPoint[] = [
      { x: 100, y: 100, value: 0 },
      { x: 200, y: 200, value: 0 },
    ];
    expect(gazeCOM(pts, container)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("equal-weight points: COM is their geometric mean (normalized)", () => {
    const pts: HeatmapPoint[] = [
      { x: 256, y: 256, value: 1 },
      { x: 768, y: 768, value: 1 },
    ];
    const com = gazeCOM(pts, container);
    expect(com.x).toBeCloseTo(0.5, 6);
    expect(com.y).toBeCloseTo(0.5, 6);
  });

  it("weighted points pull COM toward the heaviest", () => {
    const pts: HeatmapPoint[] = [
      { x: 100, y: 100, value: 1 },
      { x: 900, y: 900, value: 9 },
    ];
    const com = gazeCOM(pts, container);
    // Weighted center: (100·1 + 900·9) / 10 = 820 in pixels.
    // Normalized: 820 / 1024 = 0.80078125
    expect(com.x).toBeCloseTo(820 / 1024, 6);
    expect(com.y).toBeCloseTo(820 / 1024, 6);
  });

  it("clamps results to [0, 1]", () => {
    // A point with a giant coordinate (data corruption) shouldn't escape.
    const pts: HeatmapPoint[] = [{ x: 99999, y: 99999, value: 1 }];
    const com = gazeCOM(pts, container);
    expect(com.x).toBe(1);
    expect(com.y).toBe(1);
  });

  it("ignores non-finite values", () => {
    const pts: HeatmapPoint[] = [
      { x: 256, y: 256, value: 1 },
      { x: NaN, y: 256, value: 1 },
      { x: 256, y: 256, value: 1 },
    ];
    const com = gazeCOM(pts, container);
    expect(com.x).toBeCloseTo(0.25, 6);
    expect(com.y).toBeCloseTo(0.25, 6);
  });

  it("coerces stringified numeric coords (h337 getData returns these)", () => {
    // h337's _unOrganizeData iterates object keys via `for…in`, yielding
    // string keys, so its getData() returns points with x/y as strings.
    // Without coercion we'd skip every such point and return the center
    // default, which masquerades as a tracker bug.
    const pts = [
      { x: "256" as unknown as number, y: "256" as unknown as number, value: "1" as unknown as number },
      { x: "768" as unknown as number, y: "768" as unknown as number, value: "1" as unknown as number },
    ];
    const com = gazeCOM(pts, container);
    expect(com.x).toBeCloseTo(0.5, 6);
    expect(com.y).toBeCloseTo(0.5, 6);
  });
});

describe("heatmapStyles", () => {
  it("exposes all four named styles", () => {
    expect(Object.keys(heatmapStyles).sort()).toEqual([
      "classic",
      "grayscale",
      "moire",
      "spectral",
    ]);
  });

  it("default style is moire (the project's signature look)", () => {
    expect(DEFAULT_HEATMAP_STYLE).toBe("moire");
    expect(heatmapStyles[DEFAULT_HEATMAP_STYLE]).toBeDefined();
  });

  it("each style has a non-empty gradient", () => {
    for (const [name, style] of Object.entries(heatmapStyles)) {
      const stops = Object.keys(style.gradient);
      expect(
        stops.length,
        `style "${name}" has empty gradient`,
      ).toBeGreaterThan(0);
    }
  });

  it("moire gradient uses only black/white-spectrum colors", () => {
    const allowed = new Set(["#000", "#111", "#eee", "#fff"]);
    for (const color of Object.values(heatmapStyles.moire.gradient)) {
      expect(allowed.has(color)).toBe(true);
    }
  });
});
