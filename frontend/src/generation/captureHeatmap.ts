/**
 * Compose the visible heatmap layer onto the base image and return PNG bytes.
 *
 * Replaces legacy `html2canvas(heatmapContainer, ...)` at
 * generation-engine.js:340. html2canvas is slow (it parses CSS and rasterizes
 * via SVG <foreignObject>) and lossy. We have direct access to the source
 * images, so we composite them on a pristine 1024×1024 canvas instead.
 */

import type { HeatmapInstance } from "../canvas/HeatmapInstance";
import { useStore } from "../store";

const TARGET = 1024;

/**
 * Draw the base image at 0,0 (cover-fitted to TARGET×TARGET) and overlay
 * the heatmap canvas on top. If the heatmap matte is enabled, flatten
 * transparent base pixels onto that matte before the heatmap is drawn, so
 * the PNG sent to Comfy matches the visible frame instead of relying on
 * downstream alpha handling.
 */
export async function captureHeatmapOnBase(args: {
  baseImageURL: string;
  heatmap: HeatmapInstance;
}): Promise<Blob> {
  const { baseImageURL, heatmap } = args;

  const baseImg = await loadImage(baseImageURL);

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TARGET;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("captureHeatmapOnBase: no 2D context");

  fillCanvasIfNeeded(ctx, TARGET, effectiveHeatmapBgColor());

  // Cover-fit base image (legacy used it as CSS background-size:cover).
  drawImageCover(ctx, baseImg, TARGET, TARGET);

  // Overlay h337's rendered canvas, scaling if needed.
  const hmCanvas = heatmap.getCanvas();
  if (hmCanvas && hmCanvas.width > 0 && hmCanvas.height > 0) {
    ctx.drawImage(hmCanvas, 0, 0, hmCanvas.width, hmCanvas.height, 0, 0, TARGET, TARGET);
  }

  return canvasToBlob(canvas);
}

/**
 * Draw the current base image as a plain 1024x1024 patch with no heatmap
 * overlay or alpha mask. Edit workflows use this when COM is off so their
 * image conditioner receives the visible working patch directly.
 */
export async function captureBasePatch(args: {
  baseImageURL: string;
}): Promise<Blob> {
  const baseImg = await loadImage(args.baseImageURL);

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TARGET;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("captureBasePatch: no 2D context");

  fillCanvasIfNeeded(ctx, TARGET, effectiveHeatmapBgColor());
  drawImageCover(ctx, baseImg, TARGET, TARGET);

  return canvasToBlob(canvas);
}

/**
 * Apply the heatmap as an alpha mask on the base image (in-/outpainting).
 *
 * Replaces legacy image-processor.js:172-273 (processForInpainting). The
 * default-mask fallback (a center circle when the heatmap is empty) is
 * preserved.
 */
export async function buildInpaintingMask(args: {
  baseImageURL: string;
  heatmap: HeatmapInstance;
}): Promise<Blob> {
  const { baseImageURL, heatmap } = args;

  const baseImg = await loadImage(baseImageURL);

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TARGET;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("buildInpaintingMask: no 2D context");

  drawImageCover(ctx, baseImg, TARGET, TARGET);

  const hmCanvas = heatmap.getCanvas();
  if (hmCanvas && hmCanvas.width > 0 && hmCanvas.height > 0) {
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(hmCanvas, 0, 0, hmCanvas.width, hmCanvas.height, 0, 0, TARGET, TARGET);
    ctx.globalCompositeOperation = "source-over";

    if (!hasAnyTransparency(ctx, TARGET)) {
      drawDefaultCircleMask(ctx, TARGET);
    }
  } else {
    drawDefaultCircleMask(ctx, TARGET);
  }

  return canvasToBlob(canvas);
}

/**
 * Crop a 1024×1024 region of the master composite around an absolute pixel
 * point.
 *
 * Replaces the crop logic at legacy image-processor.js:309-342 and the
 * duplicates in generation-engine.js:355-428 (processInpaintingWithCOM)
 * and 430-493 (processStandardWithCOM).
 */
export async function cropAroundPoint(args: {
  imageURL: string;
  /** Pixel coordinates in the source image's space. */
  centerX: number;
  centerY: number;
  /** Whether to overlay the heatmap as an alpha mask (in-/outpainting + COM). */
  applyHeatmapMask?: boolean;
  heatmap?: HeatmapInstance;
}): Promise<Blob> {
  const { imageURL, centerX, centerY, applyHeatmapMask, heatmap } = args;

  const src = await loadImage(imageURL);
  return cropAroundSource({
    source: src,
    centerX,
    centerY,
    applyHeatmapMask,
    heatmap,
  });
}

/**
 * Crop a 1024x1024 region from the live composite canvas. This is the
 * composite-mode counterpart to `cropAroundPoint`, but it avoids encoding
 * the entire master composite just to decode it back into an image first.
 */
export async function cropAroundCanvasPoint(args: {
  source: HTMLCanvasElement;
  /** Pixel coordinates in the source canvas's space. */
  centerX: number;
  centerY: number;
  /** Whether to overlay the heatmap as an alpha mask (in-/outpainting + COM). */
  applyHeatmapMask?: boolean;
  heatmap?: HeatmapInstance;
}): Promise<Blob> {
  return cropAroundSource(args);
}

function cropAroundSource(args: {
  source: CanvasImageSource;
  centerX: number;
  centerY: number;
  applyHeatmapMask?: boolean;
  heatmap?: HeatmapInstance;
}): Promise<Blob> {
  const { source, centerX, centerY, applyHeatmapMask, heatmap } = args;

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TARGET;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("cropAroundPoint: no 2D context");

  const sx = centerX - TARGET / 2;
  const sy = centerY - TARGET / 2;
  ctx.drawImage(source, sx, sy, TARGET, TARGET, 0, 0, TARGET, TARGET);

  if (applyHeatmapMask && heatmap) {
    const hmCanvas = heatmap.getCanvas();
    if (hmCanvas && hmCanvas.width > 0 && hmCanvas.height > 0) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(hmCanvas, 0, 0, hmCanvas.width, hmCanvas.height, 0, 0, TARGET, TARGET);
      ctx.globalCompositeOperation = "source-over";
    }
  }

  return canvasToBlob(canvas);
}

/**
 * Build the human-readable frame sent to a VLM. This is deliberately not the
 * exact Comfy payload: no heatmap mask, no alpha, no UI overlays. COM uses the
 * same crop window the user is steering; non-COM uses the current base patch.
 */
export async function captureVisionFrame(args: {
  imageURL: string;
  centerX?: number;
  centerY?: number;
}): Promise<Blob> {
  const { imageURL, centerX, centerY } = args;
  if (centerX === undefined || centerY === undefined) {
    return captureBasePatch({ baseImageURL: imageURL });
  }
  const crop = await cropAroundPoint({ imageURL, centerX, centerY });
  return flattenAlphaOnBg(crop);
}

export async function captureVisionFrameFromCanvas(args: {
  source: HTMLCanvasElement;
  centerX: number;
  centerY: number;
}): Promise<Blob> {
  const crop = await cropAroundCanvasPoint(args);
  return flattenAlphaOnBg(crop);
}

/**
 * Flatten an RGBA blob onto the effective frame background and return a
 * fully-opaque PNG.
 *
 * Used by the edit pipeline (workflow type `"edit"`): the COM-cropped
 * patch arrives with transparent strips wherever the crop window ran past
 * the master composite's edge. Edit-conditioned models like FLUX-2 KLEIN
 * use Qwen-VL image conditioning — feeding them transparent regions
 * wastes that capability. Compositing onto the live UI bg color matches
 * exactly what the user sees on screen, so the model gets a coherent RGB
 * frame to extend rather than an alpha-mask to inpaint.
 *
 * The bg color is read live so generation tracks either the active theme
 * (default) or the opt-in matte color used by the visible frames.
 */
export async function flattenAlphaOnBg(rgbaBlob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(rgbaBlob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("flattenAlphaOnBg: no 2D context");

    const bg = effectiveFrameBgColor();
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith("data:") && !src.startsWith("blob:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`loadImage: failed for ${src.slice(0, 80)}`));
    img.src = src;
  });
}

function drawImageCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
): void {
  // Square images at native size — no cover scaling needed in the common case.
  // For non-square sources, crop the largest centered square.
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, w, h);
}

function fillCanvasIfNeeded(
  ctx: CanvasRenderingContext2D,
  size: number,
  color: string | null,
): void {
  if (!color) return;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
}

function effectiveHeatmapBgColor(): string | null {
  const state = useStore.getState();
  return state.heatmapMatteEnabled ? state.matteColor : null;
}

function effectiveFrameBgColor(): string {
  const state = useStore.getState();
  if (state.compositeMatteEnabled) return state.matteColor;
  return (
    getComputedStyle(document.body).getPropertyValue("--bg-color").trim() ||
    "#000"
  );
}

function hasAnyTransparency(
  ctx: CanvasRenderingContext2D,
  size: number,
): boolean {
  const data = ctx.getImageData(0, 0, size, size).data;
  // Sample every 100th pixel — full-pixel scan would be 1 MB of work and
  // we only need a yes/no answer here.
  for (let i = 3; i < data.length; i += 400) {
    if (data[i] < 255) return true;
  }
  return false;
}

function drawDefaultCircleMask(
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("canvasToBlob: encoding returned null"));
      },
      "image/png",
    );
  });
}
