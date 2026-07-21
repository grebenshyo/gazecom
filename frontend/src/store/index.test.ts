import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageKeys } from "../lib/persistence";

// `useStore` is created at module-load and reads localStorage during
// construction. To test hydration we clear localStorage, reset modules,
// then re-import.

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  localStorage.clear();
});

describe("useStore — actions", () => {
  it("set() updates a single field", async () => {
    const { useStore } = await import("./index");
    useStore.getState().set("steps", 30);
    expect(useStore.getState().steps).toBe(30);
  });

  it("patch() updates multiple fields atomically", async () => {
    const { useStore } = await import("./index");
    useStore.getState().patch({ steps: 5, llmModel: "deepseek", vlmModel: "llava" });
    expect(useStore.getState().steps).toBe(5);
    expect(useStore.getState().llmModel).toBe("deepseek");
    expect(useStore.getState().vlmModel).toBe("llava");
  });

  it("resetGeneration() clears composite-related fields", async () => {
    const { useStore } = await import("./index");
    useStore.getState().patch({
      compositeHasCanvas: true,
      isComposited: true,
      generationInProgress: true,
    });
    const beforeRevision = useStore.getState().compositeRevision;
    useStore.getState().resetGeneration();
    const s = useStore.getState();
    expect(s.compositeHasCanvas).toBe(false);
    expect(s.compositeRevision).toBe(beforeRevision + 1);
    expect(s.isComposited).toBe(false);
    expect(s.generationInProgress).toBe(false);
  });

  it("resetSection() restores only the requested section", async () => {
    const { DEFAULT_LLM_ENHANCE_PROMPT, useStore } = await import("./index");
    useStore.getState().patch({
      llmModel: "text-model",
      vlmModel: "vision-model",
      llmEnhancePrompt: "custom wrapper",
    });

    useStore.getState().resetSection("prompting");

    expect(useStore.getState()).toMatchObject({
      llmModel: "",
      vlmModel: "vision-model",
      llmEnhancePrompt: DEFAULT_LLM_ENHANCE_PROMPT,
    });
  });

  it("resetSection() restores Settings profiles and View defaults", async () => {
    const { useStore } = await import("./index");
    useStore.getState().set("trackingMode", "roam2");
    useStore.getState().set("pointSize", 150);
    useStore.getState().patch({ uiScale: 100, frameZoom: 40 });

    useStore.getState().resetSection("settings");
    useStore.getState().resetSection("view");

    expect(useStore.getState()).toMatchObject({
      trackingMode: "roam",
      roamSpeed: 0.2,
      trailLength: 300,
      pointSize: 50,
      pointJitter: 0,
      uiScale: 80,
      frameZoom: 85,
    });
  });

  it("resetSection() restores Workflow and Advanced defaults", async () => {
    const { DEFAULT_VLM_POINT_PROMPT, useStore } = await import("./index");
    useStore.getState().patch({
      pinnedWorkflows: { "edit/custom.json": 100 },
      steps: 42,
      compositeMatteEnabled: true,
      boundsEnabled: true,
      boundsWidth: 4096,
      vlmModel: "vision-model",
      vlmPointPrompt: "custom point prompt",
    });

    useStore.getState().resetSection("workflow");
    useStore.getState().resetSection("advanced");

    expect(useStore.getState()).toMatchObject({
      pinnedWorkflows: {},
      steps: 10,
      compositeMatteEnabled: false,
      boundsEnabled: false,
      boundsWidth: 2048,
      vlmModel: "",
      vlmPointPrompt: DEFAULT_VLM_POINT_PROMPT,
    });
  });
});

describe("useStore — persistence", () => {
  it("starts with no Ollama model selected", async () => {
    const { useStore } = await import("./index");
    expect(useStore.getState().llmModel).toBe("");
    expect(useStore.getState().vlmModel).toBe("");
  });

  it("uses the tuned Roam profile on a fresh install", async () => {
    const { useStore } = await import("./index");
    const s = useStore.getState();
    expect(s.trackingMode).toBe("roam");
    expect(s.roamSpeed).toBe(0.2);
    expect(s.trailLength).toBe(300);
    expect(s.eventHistoryLength).toBe(300);
    expect(s.heatmapStyle).toBe("moire");
    expect(s.pointSize).toBe(50);
    expect(s.pointJitter).toBe(0);
    expect(s.cropBoxBorderWidth).toBe(4);
  });

  it("applies the distinct Roam profiles when switching modes", async () => {
    const { useStore } = await import("./index");

    useStore.getState().set("trackingMode", "roam2");
    expect(useStore.getState()).toMatchObject({
      roamSpeed: 2,
      trailLength: 100,
      heatmapStyle: "moire",
      pointSize: 10,
      pointJitter: 50,
    });

    useStore.getState().set("trackingMode", "roam");
    expect(useStore.getState()).toMatchObject({
      roamSpeed: 0.2,
      trailLength: 300,
      heatmapStyle: "moire",
      pointSize: 50,
      pointJitter: 0,
    });
  });

  it("restores each mode's saved profile while sharing heatmap style", async () => {
    const { useStore } = await import("./index");

    useStore.getState().set("trackingMode", "handpose");
    expect(useStore.getState()).toMatchObject({
      trailLength: 200,
      pointSize: 50,
      pointJitter: 0,
    });
    useStore.getState().set("trailLength", 450);
    useStore.getState().set("pointSize", 75);
    useStore.getState().set("pointJitter", 5);
    useStore.getState().set("heatmapStyle", "spectral");

    useStore.getState().set("trackingMode", "cursor");
    expect(useStore.getState()).toMatchObject({
      trailLength: 100,
      pointSize: 50,
      pointJitter: 0,
      heatmapStyle: "spectral",
    });

    useStore.getState().set("trackingMode", "handpose");
    expect(useStore.getState()).toMatchObject({
      trailLength: 450,
      pointSize: 75,
      pointJitter: 5,
      heatmapStyle: "spectral",
    });
  });

  it("uses the tuned defaults when entering direct-input modes", async () => {
    const { useStore } = await import("./index");

    const sizes = {
      webgazer: 50,
      handpose: 50,
      msi: 100,
      cursor: 50,
      vlm: 50,
    } as const;
    for (const [mode, pointSize] of Object.entries(sizes) as Array<
      [keyof typeof sizes, number]
    >) {
      useStore.getState().set("trackingMode", mode);
      expect(useStore.getState()).toMatchObject({
        pointSize,
        pointJitter: 0,
      });
    }
    expect(useStore.getState().eventHistoryLength).toBe(300);
  });

  it("persists mode profiles as they are adjusted", async () => {
    const { useStore } = await import("./index");
    useStore.getState().set("trackingMode", "msi");
    useStore.getState().set("trailLength", 750);
    useStore.getState().set("pointSize", 55);

    expect(
      JSON.parse(localStorage.getItem(StorageKeys.trackingProfiles)!),
    ).toMatchObject({
      msi: { trailLength: 750, pointSize: 55, pointJitter: 0 },
    });

    vi.resetModules();
    const { useStore: reloadedStore } = await import("./index");
    expect(reloadedStore.getState()).toMatchObject({
      trackingMode: "msi",
      trailLength: 750,
      pointSize: 55,
      pointJitter: 0,
    });
  });

  it("persists set() of a persistent field to localStorage", async () => {
    const { useStore } = await import("./index");
    useStore.getState().set("theme", "dark");
    // zustand subscribeWithSelector fires synchronously.
    expect(localStorage.getItem(StorageKeys.theme)).toBe('"dark"');
  });

  it("hydrates from localStorage on construction", async () => {
    localStorage.setItem(StorageKeys.theme, '"dark"');
    localStorage.setItem(StorageKeys.steps, "30");
    localStorage.setItem(StorageKeys.eventHistoryLength, "900");
    localStorage.setItem(StorageKeys.vlmModel, '"moondream:latest"');
    localStorage.setItem(StorageKeys.llmEnhancePrompt, '"custom {prompt}"');
    localStorage.setItem(StorageKeys.compositeMatteEnabled, "true");
    localStorage.setItem(StorageKeys.heatmapMatteEnabled, "true");
    localStorage.setItem(StorageKeys.matteColor, '"#123abc"');
    localStorage.setItem(StorageKeys.uiScale, "72");
    localStorage.setItem(StorageKeys.cropBoxBorderWidth, "7");
    const { useStore } = await import("./index");
    expect(useStore.getState().theme).toBe("dark");
    expect(useStore.getState().steps).toBe(30);
    expect(useStore.getState().eventHistoryLength).toBe(900);
    expect(useStore.getState().vlmModel).toBe("moondream:latest");
    expect(useStore.getState().llmEnhancePrompt).toBe("custom {prompt}");
    expect(useStore.getState().compositeMatteEnabled).toBe(true);
    expect(useStore.getState().heatmapMatteEnabled).toBe(true);
    expect(useStore.getState().matteColor).toBe("#123abc");
    expect(useStore.getState().uiScale).toBe(72);
    expect(useStore.getState().cropBoxBorderWidth).toBe(7);
  });

  it("uses legacy matteEnabled as a fallback for split matte settings", async () => {
    localStorage.setItem(StorageKeys.matteEnabled, "true");
    const { useStore } = await import("./index");
    expect(useStore.getState().compositeMatteEnabled).toBe(true);
    expect(useStore.getState().heatmapMatteEnabled).toBe(true);
  });

  it("falls back when persisted matte color is invalid", async () => {
    localStorage.setItem(StorageKeys.matteColor, '"not-a-color"');
    const { useStore } = await import("./index");
    expect(useStore.getState().matteColor).toBe("#808080");
  });

  it("does not persist transient fields like generationInProgress", async () => {
    const { useStore } = await import("./index");
    useStore.getState().set("generationInProgress", true);
    const all = Object.keys(localStorage);
    expect(all.some((k) => k.includes("generation"))).toBe(false);
  });

  it("does not persist live derived prompt text", async () => {
    const { useStore } = await import("./index");
    useStore.getState().set("pinnedPrompts", [
      {
        text: "describe",
        weight: 100,
        height: null,
        derivedText: "large generated prompt",
        derivedHeight: 128,
      },
    ]);

    const raw = localStorage.getItem(StorageKeys.pinnedPrompts);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual([
      {
        text: "describe",
        weight: 100,
        height: null,
        derivedText: "",
        derivedHeight: 128,
      },
    ]);
  });
});
