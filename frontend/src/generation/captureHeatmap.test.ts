import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HeatmapInstance } from "../canvas/HeatmapInstance";
import { cropAroundCanvasPoint } from "./captureHeatmap";

describe("COM crop heatmap overlay", () => {
  let source: HTMLCanvasElement;
  let heatmapCanvas: HTMLCanvasElement;
  let heatmap: HeatmapInstance;
  let context: CanvasRenderingContext2D;

  beforeEach(() => {
    source = document.createElement("canvas");
    source.width = source.height = 2048;
    heatmapCanvas = document.createElement("canvas");
    heatmapCanvas.width = heatmapCanvas.height = 512;
    heatmap = {
      getCanvas: () => heatmapCanvas,
    } as HeatmapInstance;
    context = {
      drawImage: vi.fn(),
      globalCompositeOperation: "source-over",
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      (callback) => callback(new Blob([], { type: "image/png" })),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([256, 512, 1024])(
    "keeps a point at working-patch (800, 256) centered with a %ipx display",
    async (displaySize) => {
      heatmapCanvas.width = heatmapCanvas.height = displaySize;
      await cropAroundCanvasPoint({
        source,
        centerX: 1100,
        centerY: 56,
        heatmap,
        heatmapOverlayBounds: { x: 300, y: -200, width: 1024, height: 1024 },
      });

      expect(context.drawImage).toHaveBeenNthCalledWith(
        1, source, 588, -456, 1024, 1024, 0, 0, 1024, 1024,
      );
      // (800, 256) becomes (512, 512), including the working patch's origin.
      expect(context.drawImage).toHaveBeenNthCalledWith(
        2, heatmapCanvas, 0, 0, displaySize, displaySize, -288, 256, 1024, 1024,
      );
      expect(context.drawImage).toHaveBeenCalledTimes(2);
      expect(context.globalCompositeOperation).toBe("source-over");
      expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves edge offsets so the output canvas clips the overlay", async () => {
    await cropAroundCanvasPoint({
      source,
      centerX: 0,
      centerY: 1024,
      heatmap,
      heatmapOverlayBounds: { x: 0, y: 0, width: 1024, height: 1024 },
    });

    expect(context.drawImage).toHaveBeenNthCalledWith(
      2, heatmapCanvas, 0, 0, 512, 512, 512, -512, 1024, 1024,
    );
  });

  it("keeps plain edit and vision crops free of heatmap overlays", async () => {
    await cropAroundCanvasPoint({ source, centerX: 512, centerY: 512, heatmap });
    expect(context.drawImage).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing inpainting alpha-mask draw", async () => {
    const operations: string[] = [];
    vi.mocked(context.drawImage).mockImplementation(() => {
      operations.push(context.globalCompositeOperation);
    });
    await cropAroundCanvasPoint({
      source, centerX: 800, centerY: 256, heatmap, applyHeatmapMask: true,
    });

    expect(operations).toEqual(["source-over", "destination-out"]);
    expect(context.drawImage).toHaveBeenNthCalledWith(
      2, heatmapCanvas, 0, 0, 512, 512, 0, 0, 1024, 1024,
    );
    expect(context.globalCompositeOperation).toBe("source-over");
  });

  it("accepts an empty heatmap canvas without dropping the image crop", async () => {
    heatmapCanvas.width = heatmapCanvas.height = 0;
    await cropAroundCanvasPoint({
      source, centerX: 512, centerY: 512, heatmap,
      heatmapOverlayBounds: { x: 0, y: 0, width: 1024, height: 1024 },
    });
    expect(context.drawImage).toHaveBeenCalledTimes(1);
  });
});
