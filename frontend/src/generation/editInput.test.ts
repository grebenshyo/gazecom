import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HeatmapInstance } from "../canvas/HeatmapInstance";
import { compositeStore } from "../canvas/CompositeStore";
import { useStore } from "../store";
import { generateRequest } from "./api";
import {
  captureBasePatch,
  captureHeatmapOnBase,
  buildInpaintingMask,
  cropAroundCanvasPoint,
  cropAroundPoint,
  flattenAlphaOnBg,
} from "./captureHeatmap";
import { generateOnce } from "./pipeline";

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  generateRequest: vi.fn(async () => ({ kind: "skipped" })),
}));

vi.mock("./captureHeatmap", async (importOriginal) => ({
  ...await importOriginal<typeof import("./captureHeatmap")>(),
  captureBasePatch: vi.fn(async () => new Blob()),
  captureHeatmapOnBase: vi.fn(async () => new Blob()),
  buildInpaintingMask: vi.fn(async () => new Blob()),
  cropAroundCanvasPoint: vi.fn(async () => new Blob()),
  cropAroundPoint: vi.fn(async () => new Blob()),
  flattenAlphaOnBg: vi.fn(async (blob: Blob) => blob),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(useStore.getInitialState(), true);
});

afterEach(() => vi.restoreAllMocks());

describe("VLM Edit generation input", () => {
  it.each([
    { behavior: "point", com: true, composite: true, canvas: true },
    { behavior: "point", com: true, composite: false, canvas: false },
    { behavior: "point", com: false, composite: true, canvas: true },
    { behavior: "guide", com: true, composite: true, canvas: true },
    { behavior: "guide", com: false, composite: false, canvas: true },
  ] as const)("excludes the heatmap for $behavior (COM $com, composite $composite)", async (spec) => {
    const source = document.createElement("canvas");
    source.width = source.height = 1024;
    vi.spyOn(compositeStore, "getCanvas").mockReturnValue(spec.canvas ? source : null);
    const heatmap = {
      getData: vi.fn(() => [{ x: 300, y: 100, value: 1 }]),
      getCanvas: vi.fn(),
    } as unknown as HeatmapInstance;
    useStore.getState().patch({
      trackingMode: "vlm",
      trackingActive: true,
      vlmModel: "test-model",
      vlmBehavior: spec.behavior,
      vlmGuidePromptChoice: "rotate",
      vlmRotatePoolContext: false,
      comMode: spec.com,
      compositeMode: spec.composite,
      feedbackMode: false,
      boundsEnabled: false,
      baseImageURL: "test-image.png",
      baseImgPosition: { x: 0, y: 0, width: 1024, height: 1024 },
      pinnedWorkflows: { "edit/test.json": 1 },
      mutedWorkflows: [],
      pinnedPrompts: [{ text: "paint blue", weight: 1, height: null }],
    });
    useStore.getState().patch({
      vlmPoint: { x: 0.75, y: 0.25 },
      vlmGuideAction: spec.behavior === "guide" ? { x: 0.5, y: 0.5 } : null,
    });

    await generateOnce({ heatmap, containerSize: () => ({ width: 512, height: 512 }) });

    if (spec.behavior === "point" && spec.com) {
      const crop = spec.canvas ? cropAroundCanvasPoint : cropAroundPoint;
      expect(crop).toHaveBeenCalledWith(expect.objectContaining({
        centerX: 768,
        centerY: 256,
        heatmap: undefined,
        heatmapOverlayBounds: undefined,
        applyHeatmapMask: false,
      }));
      expect(captureBasePatch).not.toHaveBeenCalled();
    } else {
      expect(captureBasePatch).toHaveBeenCalledWith({ baseImageURL: "test-image.png" });
      expect(cropAroundCanvasPoint).not.toHaveBeenCalled();
      expect(cropAroundPoint).not.toHaveBeenCalled();
    }
    expect(captureHeatmapOnBase).not.toHaveBeenCalled();
    expect(buildInpaintingMask).not.toHaveBeenCalled();
    expect(heatmap.getCanvas).not.toHaveBeenCalled();
    expect(flattenAlphaOnBg).toHaveBeenCalledTimes(1);
    expect(generateRequest).toHaveBeenCalledWith(
      expect.objectContaining({ workflow: "edit/test.json", prompt: "paint blue" }),
      undefined,
    );
  });
});
