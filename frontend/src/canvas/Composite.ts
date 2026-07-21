/**
 * Pure expanding-canvas math for composite mode.
 *
 * Replaces the imperative drawing code at legacy generation-engine.js:648-785.
 * That code mixed canvas allocation, image loading, async coordination, and
 * pixel arithmetic into one 140-line block. Here we extract the pixel
 * arithmetic into a pure function — the React layer feeds it numbers and
 * uses the result to drive `ctx.drawImage` calls.
 *
 * No DOM dependencies, no async, no I/O. Trivially unit-testable with Vitest.
 */

// `WorkflowType` lives in generation/workflows.ts (canonical home, alongside
// determineWorkflowType which produces it). Imported as a type-only ref so
// no runtime dependency on the generation module is introduced. Re-exported
// here for the convenience of legacy callers that pulled it from this module.
import type { WorkflowType } from "../generation/workflows";

export type { WorkflowType };

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Top-left + size of a rectangle, in composite-canvas pixels. */
export interface PatchBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlanInput {
  /** Dimensions of the current composite canvas. */
  prevSize: Size;
  /** Position+size of the most recently placed patch within the previous composite. */
  prevPosition: PatchBox;
  /** Dimensions of the freshly generated patch (typically 1024×1024). */
  newSize: Size;
  /** Center of mass from the heatmap, normalized to [0, 1] over `prevPosition`. */
  newCOM: Point;
  workflow: WorkflowType;
  /**
   * When true, the new patch is centered on the COM. When false, it's centered
   * on the geometric center of the previous patch.
   */
  useCOM: boolean;
  /**
   * Optional axis-aligned cap on canvas growth. When supplied, the new
   * canvas is clipped to the `bounds` window after natural COM placement.
   * The patch is not slid back inside the window; any part outside the
   * bounds is simply not drawn. The box is expressed in the *previous
   * canvas's* coordinate system — same frame as `prevPosition` — and the
   * caller is responsible for keeping it in sync across coordinate-shift
   * events (the same way `PullTool` keeps its bbox aligned).
   */
  bounds?: PatchBox;
}

export interface PlanResult {
  /** Total size of the new composite canvas. */
  canvasSize: Size;
  /** Where to draw the previous composite on the new canvas. */
  prevDrawAt: Point;
  /** Where to draw the freshly generated patch on the new canvas. */
  newDrawAt: Point;
  /**
   * Render order:
   *  - "old-then-new": the new patch is laid on top. For edit, this means
   *    the model's edited render of the cropped region fully replaces the
   *    previous composite where they overlap, which is the desired behaviour
   *    for edit-conditioned models.
   */
  drawOrder: "old-then-new";
  /** Position+size of the new patch within the resulting composite. */
  newPosition: PatchBox;
  /**
   * Offset applied to coordinates from the previous canvas when drawing into
   * the new canvas. Positive values mean the canvas grew left/up; negative
   * values mean bounds clipping cropped pixels from the left/top. Subscribers
   * use this to keep image-space anchors aligned with the new coordinate
   * frame.
   */
  coordinateShift: Point;
}

/**
 * Compute the composite plan for placing `newSize` into a canvas built around
 * `prevSize` + `prevPosition`. See `PlanResult` for the meaning of fields.
 */
export function planComposite(input: PlanInput): PlanResult {
  const { prevSize, prevPosition, newSize, newCOM, useCOM, bounds } = input;

  // Where on the previous canvas do we anchor the new patch's center?
  // `useCOM` alone decides: set → anchor on the gaze center-of-mass over
  // the previous patch; unset → the previous patch's geometric center.
  // Workflow type no longer forces COM — the pipeline owns that policy and
  // passes one authoritative flag, so the COM toggle is honoured uniformly
  // across every workflow.
  const anchorX = useCOM
    ? prevPosition.x + newCOM.x * prevPosition.width
    : prevPosition.x + prevPosition.width / 2;
  const anchorY = useCOM
    ? prevPosition.y + newCOM.y * prevPosition.height
    : prevPosition.y + prevPosition.height / 2;

  // New patch top-left in *previous* canvas coordinates (may be negative).
  // Snap to integer pixels to avoid subpixel resampling blur on each
  // composite step — drift accumulates fast at sub-pixel granularity.
  // (Ported from legacy generation-engine.js:617-618.)
  const newRawX = Math.round(anchorX - newSize.width / 2);
  const newRawY = Math.round(anchorY - newSize.height / 2);

  // Bounding box of {previous canvas, new patch}, expressed in the previous
  // canvas coordinate frame.
  const naturalMinX = Math.min(0, newRawX);
  const naturalMinY = Math.min(0, newRawY);
  const naturalMaxX = Math.max(prevSize.width, newRawX + newSize.width);
  const naturalMaxY = Math.max(prevSize.height, newRawY + newSize.height);

  let minX = naturalMinX;
  let minY = naturalMinY;
  let maxX = naturalMaxX;
  let maxY = naturalMaxY;

  // Apply optional canvas bounds as a clipping window, not as a placement
  // clamp. Natural COM placement stays intact; the canvas just contains the
  // intersection of the natural composite and the configured limit.
  if (bounds) {
    minX = Math.max(bounds.x, minX);
    minY = Math.max(bounds.y, minY);
    maxX = Math.min(bounds.x + bounds.width, maxX);
    maxY = Math.min(bounds.y + bounds.height, maxY);

    // Defensive fallback for stale or pathological bounds that do not
    // intersect the current composite at all. This should not happen when
    // bounds are derived from the tracked first patch, but fail-open is safer
    // than producing a zero-sized canvas.
    if (maxX <= minX || maxY <= minY) {
      minX = naturalMinX;
      minY = naturalMinY;
      maxX = naturalMaxX;
      maxY = naturalMaxY;
    }
  }

  const canvasSize: Size = {
    width: maxX - minX,
    height: maxY - minY,
  };

  // Coordinate shift maps the previous canvas coordinate frame into the new
  // canvas coordinate frame. Avoid `-minX` directly because JS produces `-0`
  // from `-(0)`, which breaks strict equality in tests.
  const coordinateShift: Point = {
    x: minX === 0 ? 0 : -minX,
    y: minY === 0 ? 0 : -minY,
  };

  // The previous composite is drawn at the shift offset. Negative offsets are
  // intentional when bounds clipping crops from the left/top.
  const prevDrawAt: Point = { x: coordinateShift.x, y: coordinateShift.y };
  const newDrawAt: Point = {
    x: newRawX + coordinateShift.x,
    y: newRawY + coordinateShift.y,
  };

  const drawOrder: PlanResult["drawOrder"] = "old-then-new";

  const newPosition: PatchBox = {
    x: newDrawAt.x,
    y: newDrawAt.y,
    width: newSize.width,
    height: newSize.height,
  };

  return {
    canvasSize,
    prevDrawAt,
    newDrawAt,
    drawOrder,
    newPosition,
    coordinateShift,
  };
}

/**
 * Drive an offscreen canvas using a `PlanResult`. The React layer passes in
 * the two source canvases (or HTMLImageElements) and gets back a ready-to-use
 * HTMLCanvasElement. Kept thin — the math lives in `planComposite`.
 */
export function applyPlan(
  plan: PlanResult,
  prev: CanvasImageSource,
  next: CanvasImageSource,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = plan.canvasSize.width;
  canvas.height = plan.canvasSize.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Composite canvas: 2D context unavailable");
  }
  // Disable smoothing — composite drawImage at integer offsets is a
  // pure copy with smoothing off, which preserves the source pixels
  // exactly. With smoothing on, images get a tiny blur on every step.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(prev, plan.prevDrawAt.x, plan.prevDrawAt.y);
  ctx.drawImage(next, plan.newDrawAt.x, plan.newDrawAt.y);
  return canvas;
}
