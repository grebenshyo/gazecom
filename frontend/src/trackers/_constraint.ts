import type { ContainerSize, RoamConstraint, TrackerContext } from "./Tracker";

export function resolveRoamConstraint(
  ctx: TrackerContext,
  size: ContainerSize,
  fallbackInset = 0,
): RoamConstraint {
  const live = ctx.getRoamConstraint?.();
  if (live) {
    const resolved = sanitizeConstraint(live, size);
    if (resolved) return resolved;
  }

  const maxX = Math.max(fallbackInset, size.width - fallbackInset);
  const maxY = Math.max(fallbackInset, size.height - fallbackInset);
  return {
    minX: Math.min(fallbackInset, maxX),
    maxX,
    minY: Math.min(fallbackInset, maxY),
    maxY,
  };
}

function sanitizeConstraint(
  constraint: RoamConstraint,
  size: ContainerSize,
): RoamConstraint | null {
  const minX = clamp(constraint.minX, 0, size.width);
  const maxX = clamp(constraint.maxX, 0, size.width);
  const minY = clamp(constraint.minY, 0, size.height);
  const maxY = clamp(constraint.maxY, 0, size.height);

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxY) ||
    minX > maxX ||
    minY > maxY
  ) {
    return null;
  }
  return { minX, maxX, minY, maxY };
}

export function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
