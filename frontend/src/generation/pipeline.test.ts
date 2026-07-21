import { describe, expect, it } from "vitest";

import {
  inputKindFor,
  resolveInputCOM,
  resolvePromptTransforms,
} from "./pipeline";

describe("inputKindFor", () => {
  it("uses COM crop whenever COM is enabled", () => {
    expect(inputKindFor("standard", true)).toBe("com-crop");
    expect(inputKindFor("inpainting", true)).toBe("com-crop");
    expect(inputKindFor("edit", true)).toBe("com-crop");
  });

  it("keeps non-COM input policies distinct", () => {
    expect(inputKindFor("standard", false)).toBe("heatmap-base");
    expect(inputKindFor("inpainting", false)).toBe("inpaint-mask");
    expect(inputKindFor("edit", false)).toBe("plain-base");
  });
});

describe("resolveInputCOM", () => {
  const containerSize = { width: 1000, height: 1000 };
  const heatmapData = [{ x: 100, y: 200, value: 1 }];

  it("uses the store-backed VLM point without waiting for a render tick", () => {
    expect(
      resolveInputCOM({
        trackingMode: "vlm",
        vlmPoint: { x: 0.8, y: 0.3 },
        heatmapData,
        containerSize,
      }),
    ).toEqual({ x: 0.8, y: 0.3 });
  });

  it("defaults VLM placement to center before the first response", () => {
    expect(
      resolveInputCOM({
        trackingMode: "vlm",
        vlmPoint: null,
        heatmapData,
        containerSize,
      }),
    ).toEqual({ x: 0.5, y: 0.5 });
  });

  it("keeps every other tracker on the normal heatmap COM path", () => {
    expect(
      resolveInputCOM({
        trackingMode: "roam",
        vlmPoint: { x: 0.8, y: 0.3 },
        heatmapData,
        containerSize,
      }),
    ).toEqual({ x: 0.1, y: 0.2 });
  });
});

describe("resolvePromptTransforms", () => {
  it("enhances before vision and returns the unprocessed vision output", async () => {
    const calls: string[] = [];

    const result = await resolvePromptTransforms(
      "current instruction",
      true,
      async (prompt) => {
        calls.push(`llm:${prompt}`);
        return "evolved instruction";
      },
      async (prompt) => {
        calls.push(`vlm:${prompt}`);
        return "raw visual description";
      },
      (prompt) => calls.push(`preview:${prompt}`),
    );

    expect(calls).toEqual([
      "llm:current instruction",
      "preview:evolved instruction",
      "vlm:evolved instruction",
    ]);
    expect(result).toBe("raw visual description");
  });

  it("does not invoke vision when the slot has vision disabled", async () => {
    let described = false;

    const result = await resolvePromptTransforms(
      "current prompt",
      false,
      async () => "enhanced prompt",
      async () => {
        described = true;
        return "unused";
      },
    );

    expect(result).toBe("enhanced prompt");
    expect(described).toBe(false);
  });
});
