import type { ContainerSize, RoamConstraint } from "../trackers/Tracker";

export interface PatchBoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompositeBoundsConfig {
  enabled: boolean;
  width: number;
  height: number;
}

export type CanvasBoundsBehavior = "prepare" | "growth" | "centered";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SizeLike {
  width: number;
  height: number;
}

/** Validate the configured canvas-size cap. */
export function deriveCompositeMaxSize(
  config: CompositeBoundsConfig,
): SizeLike | undefined {
  if (!config.enabled) return undefined;
  if (config.width <= 0 || config.height <= 0) return undefined;
  return { width: config.width, height: config.height };
}

/**
 * Fixed bounds centered on the first patch. The anchor is stored in the live
 * composite coordinate system and translated after every canvas shift, so the
 * same world-space rectangle survives left/up growth and clipping.
 */
export function deriveCenteredCompositeBounds(
  config: CompositeBoundsConfig,
  firstPatch: PatchBoxLike | null,
): Rect | undefined {
  if (!config.enabled || !firstPatch) return undefined;
  if (config.width <= 0 || config.height <= 0) return undefined;
  if (firstPatch.width <= 0 || firstPatch.height <= 0) return undefined;

  const centerX = firstPatch.x + firstPatch.width / 2;
  const centerY = firstPatch.y + firstPatch.height / 2;
  return {
    x: Math.round(centerX - config.width / 2),
    y: Math.round(centerY - config.height / 2),
    width: config.width,
    height: config.height,
  };
}

/** Resolve the legal COM point range for the selected canvas-limit policy. */
export function deriveCanvasCOMBounds(params: {
  config: CompositeBoundsConfig;
  behavior: CanvasBoundsBehavior;
  compositeSize: SizeLike;
  firstPatch: PatchBoxLike | null;
}): Rect | undefined {
  const { config, behavior, compositeSize, firstPatch } = params;
  if (behavior === "centered") {
    return deriveCenteredCompositeBounds(config, firstPatch);
  }
  return deriveCOMBounds(deriveCompositeMaxSize(config), compositeSize);
}

/**
 * Derive the absolute point range that can still produce a canvas no larger
 * than `maxSize`. Before an axis reaches its cap, this range extends beyond
 * both current edges so generation can grow naturally in either direction.
 * At the cap it collapses to the current 0..size canvas interval.
 */
export function deriveCOMBounds(
  maxSize: SizeLike | undefined,
  compositeSize: SizeLike,
): Rect | undefined {
  if (!maxSize) return undefined;
  if (compositeSize.width <= 0 || compositeSize.height <= 0) return undefined;

  const x = Math.min(0, compositeSize.width - maxSize.width);
  const y = Math.min(0, compositeSize.height - maxSize.height);
  const maxX = Math.max(compositeSize.width, maxSize.width);
  const maxY = Math.max(compositeSize.height, maxSize.height);
  return {
    x,
    y,
    width: maxX - x,
    height: maxY - y,
  };
}

/**
 * Convert a composite-space bounds box into the heatmap-space COM rectangle
 * that keeps the attention point itself inside that box. The generated patch
 * may extend beyond it; compositing clips that overflow without moving it.
 */
export function deriveRoamConstraint(params: {
  bounds: Rect;
  basePosition: PatchBoxLike;
  containerSize: ContainerSize;
}): RoamConstraint | undefined {
  const { bounds, basePosition, containerSize } = params;
  if (
    basePosition.width <= 0 ||
    basePosition.height <= 0 ||
    containerSize.width <= 0 ||
    containerSize.height <= 0
  ) {
    return undefined;
  }

  const xRange = deriveAxisRange({
    boundsStart: bounds.x,
    boundsSize: bounds.width,
    baseStart: basePosition.x,
    baseSize: basePosition.width,
    containerSize: containerSize.width,
  });
  const yRange = deriveAxisRange({
    boundsStart: bounds.y,
    boundsSize: bounds.height,
    baseStart: basePosition.y,
    baseSize: basePosition.height,
    containerSize: containerSize.height,
  });
  if (!xRange || !yRange) return undefined;

  return {
    minX: xRange.min,
    maxX: xRange.max,
    minY: yRange.min,
    maxY: yRange.max,
  };
}

/**
 * Clamp a normalized COM so its absolute anchor point stays inside the bounds
 * window. The patch remains centered on that exact point and may cross the
 * boundary; `planComposite` clips the overflow afterward.
 *
 * Placement-level counterpart to `deriveRoamConstraint`: that one nudges
 * the synthetic roamers' *samples*, so only roam/roam2 ever respected the
 * canvas cap. Every other COM source (VLM point, cursor, the camera trackers)
 * knows nothing about bounds, so the pipeline applies the same point-level
 * constraint before placement.
 *
 * The result is intentionally NOT limited to [0, 1]: when the entire active
 * frame lies beyond the window, an out-of-range COM can place its anchor back
 * on the nearest boundary in one step.
 */
export function clampCOMToBounds(
  com: { x: number; y: number },
  bounds: Rect | undefined,
  basePosition: PatchBoxLike,
): { x: number; y: number } {
  if (!bounds) return com;
  if (basePosition.width <= 0 || basePosition.height <= 0) return com;
  return {
    x: clampAxisCOM({
      com: com.x,
      boundsStart: bounds.x,
      boundsSize: bounds.width,
      baseStart: basePosition.x,
      baseSize: basePosition.width,
    }),
    y: clampAxisCOM({
      com: com.y,
      boundsStart: bounds.y,
      boundsSize: bounds.height,
      baseStart: basePosition.y,
      baseSize: basePosition.height,
    }),
  };
}

function clampAxisCOM(params: {
  com: number;
  boundsStart: number;
  boundsSize: number;
  baseStart: number;
  baseSize: number;
}): number {
  const { com, boundsStart, boundsSize, baseStart, baseSize } = params;
  const minCOM = (boundsStart - baseStart) / baseSize;
  const maxCOM = (boundsStart + boundsSize - baseStart) / baseSize;
  if (!Number.isFinite(minCOM) || !Number.isFinite(maxCOM)) return com;
  if (minCOM > maxCOM) return com;
  if (com < minCOM) return minCOM;
  if (com > maxCOM) return maxCOM;
  return com;
}

function deriveAxisRange(params: {
  boundsStart: number;
  boundsSize: number;
  baseStart: number;
  baseSize: number;
  containerSize: number;
}): { min: number; max: number } | undefined {
  const { boundsStart, boundsSize, baseStart, baseSize, containerSize } = params;
  const minCOM = (boundsStart - baseStart) / baseSize;
  const maxCOM = (boundsStart + boundsSize - baseStart) / baseSize;

  if (!Number.isFinite(minCOM) || !Number.isFinite(maxCOM)) return undefined;
  if (minCOM > maxCOM) return undefined;

  const min = clamp01(minCOM) * containerSize;
  const max = clamp01(maxCOM) * containerSize;
  return { min, max };
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
