import { describe, expect, it } from "vitest";

import {
  buildRotatePromptContext,
  buildSelectPromptCandidates,
  inputKindFor,
  pullPositionForCanvasPoint,
  renderGuidePrompt,
  renderPromptPoolTemplate,
  renderRotatePrompt,
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

describe("pullPositionForCanvasPoint", () => {
  it("centers the Pull frame on a normalized canvas point", () => {
    expect(
      pullPositionForCanvasPoint(
        { x: 0.75, y: 0.25 },
        { width: 2048, height: 1024 },
      ),
    ).toEqual({ x: 1024, y: -256 });
  });

  it("keeps edge pulls outside current content instead of clamping the box", () => {
    expect(
      pullPositionForCanvasPoint(
        { x: 0, y: 1 },
        { width: 1024, height: 1024 },
      ),
    ).toEqual({ x: -512, y: 512 });
  });
});

describe("renderGuidePrompt", () => {
  it("describes a bounded workspace with live dimensions", () => {
    expect(
      renderGuidePrompt(
        "Crop {crop_size}; canvas {canvas_width}x{canvas_height}. {canvas_limit}",
        { width: 2048, height: 1536 },
        { enabled: true, width: 2048, height: 1536 },
      ),
    ).toBe(
      "Crop 1024; canvas 2048x1536. The workspace is limited to 2048 x 1536 pixels; content outside it is clipped.",
    );
  });

  it("explains edge expansion when the canvas is unbounded", () => {
    const prompt = renderGuidePrompt(
      "{canvas_limit} {max_width}x{max_height}",
      { width: 1024, height: 1024 },
      { enabled: false, width: 2048, height: 2048 },
    );

    expect(prompt).toContain("choosing an edge lets the next crop expand it");
    expect(prompt).toContain("unboundedxunbounded");
  });
});

describe("renderRotatePrompt", () => {
  const slots = [
    { text: "red structure", weight: 1, height: null },
    { text: "muted detail", weight: 10, height: null, muted: true },
    { text: "zero influence", weight: 0, height: null },
    { text: "blue atmosphere", weight: 3, height: null },
  ];

  it("builds context from positive, unmuted slots with normalized weights", () => {
    expect(buildRotatePromptContext(slots)).toEqual([
      { probability: 0.25, prompt: "red structure" },
      { probability: 0.75, prompt: "blue atmosphere" },
    ]);
  });

  it("expands the visible pool placeholder without adding hidden instructions", () => {
    const prompt = renderRotatePrompt(
      "Use these only as placement context:\n{prompt_pool}\n\n" +
        "Choose coordinates for a {crop_size} crop.",
      slots,
      true,
      { width: 2048, height: 2048 },
      { enabled: true, width: 2048, height: 2048 },
    );

    expect(prompt).toContain("Choose coordinates for a 1024 crop.");
    expect(prompt).toContain("Use these only as placement context:");
    expect(prompt).toContain('"probability": 0.25');
    expect(prompt).toContain('"prompt": "red structure"');
    expect(prompt).toContain('"probability": 0.75');
    expect(prompt).toContain('"prompt": "blue atmosphere"');
    expect(prompt).not.toContain("muted detail");
    expect(prompt).not.toContain("zero influence");
    expect(prompt).not.toContain('"id"');
    expect(prompt.indexOf('"probability": 0.25')).toBeLessThan(
      prompt.indexOf("Choose coordinates"),
    );
  });

  it("rejects hidden Rotate context without a visible placeholder", () => {
    expect(() =>
      renderRotatePrompt(
        "Choose coordinates for a {crop_size} crop.",
        slots,
        true,
        { width: 2048, height: 2048 },
        { enabled: true, width: 2048, height: 2048 },
      ),
    ).toThrow('requires the "{prompt_pool}" placeholder');
  });

  it("leaves the normal Guide prompt unchanged when context is disabled", () => {
    expect(
      renderRotatePrompt(
        "Choose coordinates for a {crop_size} crop.",
        slots,
        false,
        { width: 2048, height: 2048 },
        { enabled: true, width: 2048, height: 2048 },
      ),
    ).toBe("Choose coordinates for a 1024 crop.");
  });

  it("renders an empty visible pool when substitution is disabled", () => {
    expect(
      renderRotatePrompt(
        "Context: {prompt_pool}\nChoose coordinates.",
        slots,
        false,
        { width: 2048, height: 2048 },
        { enabled: true, width: 2048, height: 2048 },
      ),
    ).toBe("Context: []\nChoose coordinates.");
  });
});

describe("renderPromptPoolTemplate", () => {
  it("expands the visible prompt-pool contract with stable slot IDs", () => {
    const candidates = buildSelectPromptCandidates([
      { text: "red shape", weight: 0, height: null },
      { text: "hidden", weight: 100, height: null, muted: true },
      { text: "blue field", weight: 1, height: null },
    ]);

    expect(candidates).toEqual([
      {
        id: 1,
        slotIndex: 0,
        sourceText: "red shape",
        slotSignature: '["red shape","off",false]',
        prompt: "red shape",
      },
      {
        id: 3,
        slotIndex: 2,
        sourceText: "blue field",
        slotSignature: '["blue field","off",false]',
        prompt: "blue field",
      },
    ]);
    const prompt = renderPromptPoolTemplate(
      "Candidates:\n{prompt_pool}\nCrop {crop_size}.",
      candidates,
      { width: 2048, height: 2048 },
      { enabled: true, width: 2048, height: 2048 },
    );
    expect(prompt).toContain('"id": 1');
    expect(prompt).toContain('"prompt": "red shape"');
    expect(prompt).toContain('"id": 3');
    expect(prompt).not.toContain("hidden");
    expect(prompt).toContain("Crop 1024.");
  });

  it("refuses to hide the candidate pool outside the editable prompt", () => {
    expect(() =>
      renderPromptPoolTemplate(
        "Choose a prompt ID.",
        [
          {
            id: 1,
            slotIndex: 0,
            sourceText: "red",
            slotSignature: '["red","off",false]',
            prompt: "red",
          },
        ],
        { width: 1024, height: 1024 },
        { enabled: false, width: 2048, height: 2048 },
      ),
    ).toThrow('must include the "{prompt_pool}" placeholder');
  });

  it("exposes an empty pool so Hybrid can still choose to write", () => {
    const prompt = renderPromptPoolTemplate(
      "Available prompts:\n{prompt_pool}",
      [],
      { width: 1024, height: 1024 },
      { enabled: false, width: 2048, height: 2048 },
    );

    expect(prompt).toContain("Available prompts:\n[]");
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
