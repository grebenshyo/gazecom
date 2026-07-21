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

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Bounds window centered on the first patch. Returns undefined when the
 * cap cannot fit the next patch; callers then fail open.
 */
export function deriveCompositeBounds(
  config: CompositeBoundsConfig,
  firstPatch: PatchBoxLike,
  nextSize: { width: number; height: number },
): Rect | undefined {
  if (!config.enabled) return undefined;
  if (firstPatch.width === 0 || firstPatch.height === 0) return undefined;
  if (config.width < nextSize.width || config.height < nextSize.height) {
    return undefined;
  }

  const fpCenterX = firstPatch.x + firstPatch.width / 2;
  const fpCenterY = firstPatch.y + firstPatch.height / 2;
  return {
    x: Math.round(fpCenterX - config.width / 2),
    y: Math.round(fpCenterY - config.height / 2),
    width: config.width,
    height: config.height,
  };
}

/**
 * Convert a composite-space bounds box into the heatmap-space COM rectangle
 * that keeps the next patch fully inside that box.
 */
export function deriveRoamConstraint(params: {
  bounds: Rect;
  basePosition: PatchBoxLike;
  nextSize: { width: number; height: number };
  containerSize: ContainerSize;
}): RoamConstraint | undefined {
  const { bounds, basePosition, nextSize, containerSize } = params;
  if (
    basePosition.width <= 0 ||
    basePosition.height <= 0 ||
    containerSize.width <= 0 ||
    containerSize.height <= 0 ||
    nextSize.width <= 0 ||
    nextSize.height <= 0
  ) {
    return undefined;
  }

  const xRange = deriveAxisRange({
    boundsStart: bounds.x,
    boundsSize: bounds.width,
    baseStart: basePosition.x,
    baseSize: basePosition.width,
    nextSize: nextSize.width,
    containerSize: containerSize.width,
  });
  const yRange = deriveAxisRange({
    boundsStart: bounds.y,
    boundsSize: bounds.height,
    baseStart: basePosition.y,
    baseSize: basePosition.height,
    nextSize: nextSize.height,
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
 * Clamp a normalized COM so the next patch — anchored at
 * `base + com × baseSize` and centered on that anchor — stays inside the
 * bounds window.
 *
 * Placement-level counterpart to `deriveRoamConstraint`: that one nudges
 * the synthetic roamers' *samples*, so only roam/roam2 ever respected the
 * canvas cap. Every other COM source (VLM point, cursor, the camera
 * trackers) knows nothing about bounds — once a patch walked outside the
 * window, planComposite clipped it entirely and, with the base patch now
 * stranded outside, every later patch too: generations kept succeeding
 * while the composite sat idle. Clamping the pipeline's final COM here
 * guards placement for every mode.
 *
 * The result is intentionally NOT limited to [0, 1]: when the base sits
 * outside the window, the feasible range lies beyond the base patch and
 * an out-of-range COM is exactly what pulls placement back inside in a
 * single step.
 *
 * Fails open (returns `com` unchanged) when an axis has no feasible
 * anchor — mirroring planComposite's degenerate-bounds fallback.
 */
export function clampCOMToBounds(
  com: { x: number; y: number },
  bounds: Rect | undefined,
  basePosition: PatchBoxLike,
  nextSize: { width: number; height: number },
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
      nextSize: nextSize.width,
    }),
    y: clampAxisCOM({
      com: com.y,
      boundsStart: bounds.y,
      boundsSize: bounds.height,
      baseStart: basePosition.y,
      baseSize: basePosition.height,
      nextSize: nextSize.height,
    }),
  };
}

function clampAxisCOM(params: {
  com: number;
  boundsStart: number;
  boundsSize: number;
  baseStart: number;
  baseSize: number;
  nextSize: number;
}): number {
  const { com, boundsStart, boundsSize, baseStart, baseSize, nextSize } =
    params;
  const minCOM = (boundsStart + nextSize / 2 - baseStart) / baseSize;
  const maxCOM =
    (boundsStart + boundsSize - nextSize / 2 - baseStart) / baseSize;
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
  nextSize: number;
  containerSize: number;
}): { min: number; max: number } | undefined {
  const { boundsStart, boundsSize, baseStart, baseSize, nextSize, containerSize } =
    params;
  const minCOM = (boundsStart + nextSize / 2 - baseStart) / baseSize;
  const maxCOM =
    (boundsStart + boundsSize - nextSize / 2 - baseStart) / baseSize;

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
