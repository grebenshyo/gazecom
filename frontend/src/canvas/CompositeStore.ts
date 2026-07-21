/**
 * Persistent composite canvas — the canonical store of the master
 * composite. React observes the lightweight `compositeRevision` /
 * `compositeHasCanvas` fields and copies from this backing canvas directly,
 * so normal generation never PNG-encodes the full master just to refresh UI.
 *
 * Why a singleton, not a pure-functional approach: the legacy app spent a
 * generation or two encoding each composite to PNG and decoding it back
 * for the next composite, which (a) is slow and (b) introduces subtle
 * resampling drift. Holding the canvas in memory as the canonical state
 * eliminates the round-trip. Ported from legacy js/core/image-processor.js
 * (compositeCanvas, setCompositeCanvas, getCompositeSourceForDrawingAsync,
 * setCompositeFromImageSource, refreshCompositeDisplayURL).
 *
 */

import { useStore } from "../store";

class CompositeStore {
  private canvas: HTMLCanvasElement | null = null;

  /** True iff the backing canvas is non-empty. */
  hasCanvas(): boolean {
    return !!(
      this.canvas &&
      this.canvas.width > 0 &&
      this.canvas.height > 0
    );
  }

  /** Returns the live backing canvas, or null if uninitialized. */
  getCanvas(): HTMLCanvasElement | null {
    return this.hasCanvas() ? this.canvas : null;
  }

  /**
   * Replace the backing canvas and publish a cheap revision tick so React
   * views can copy from the canonical pixels without a PNG round-trip.
   */
  async setCanvas(newCanvas: HTMLCanvasElement): Promise<void> {
    if (newCanvas.width === 0 || newCanvas.height === 0) {
      throw new Error("CompositeStore.setCanvas: canvas has zero dimensions");
    }
    const oldCanvas = this.canvas;
    this.canvas = newCanvas;
    this.publish(true);
    if (oldCanvas && oldCanvas !== newCanvas) {
      releaseCanvas(oldCanvas);
    }
  }

  /**
   * Initialize / replace the canvas from an existing image source. Used
   * when the user picks a base image, or in simple (non-composite) mode
   * where each generation result becomes the new base.
   */
  async setFromImageURL(url: string): Promise<void> {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("CompositeStore.setFromImageURL: no 2D context");
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    await this.setCanvas(canvas);
  }

  /** Drop the canvas and publish an empty revision. */
  clear(): void {
    const oldCanvas = this.canvas;
    this.canvas = null;
    if (oldCanvas) {
      releaseCanvas(oldCanvas);
    }
    this.publish(false);
  }

  /** Export the current canvas, optionally flattening transparency over a matte. */
  async toBlob(options: { matteColor?: string } = {}): Promise<Blob | null> {
    if (!this.canvas) return null;
    const source = options.matteColor
      ? flattenCanvasOnMatte(this.canvas, options.matteColor)
      : this.canvas;
    return new Promise<Blob | null>((resolve) =>
      source.toBlob(resolve, "image/png"),
    );
  }

  private publish(hasCanvas: boolean): void {
    const state = useStore.getState();
    state.patch({
      compositeHasCanvas: hasCanvas,
      compositeRevision: state.compositeRevision + 1,
    });
  }
}

export const compositeStore = new CompositeStore();

function flattenCanvasOnMatte(
  source: HTMLCanvasElement,
  matteColor: string,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("CompositeStore.toBlob: no 2D context");
  }
  ctx.fillStyle = matteColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0);
  return canvas;
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  // Dropping dimensions releases the browser-side pixel buffer promptly.
  canvas.width = 0;
  canvas.height = 0;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith("data:") && !src.startsWith("blob:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error(`loadImage: failed for ${src.slice(0, 80)}`));
    img.src = src;
  });
}
