import { afterEach, describe, expect, it } from "vitest";
import {
  StorageKeys,
  applySettingsFile,
  clearAllGazeComKeys,
  clearKey,
  createSettingsFile,
  readJSON,
  writeJSON,
} from "./persistence";

afterEach(() => {
  localStorage.clear();
});

describe("readJSON / writeJSON", () => {
  it("round-trips primitive values", () => {
    writeJSON(StorageKeys.steps, 42);
    expect(readJSON(StorageKeys.steps, 0)).toBe(42);
  });

  it("round-trips objects", () => {
    writeJSON(StorageKeys.panelPosition, { left: 10, top: 20 });
    expect(readJSON(StorageKeys.panelPosition, null)).toEqual({
      left: 10,
      top: 20,
    });
  });

  it("returns fallback when key is missing", () => {
    expect(readJSON(StorageKeys.theme, "light")).toBe("light");
  });

  it("returns fallback when stored value is malformed JSON", () => {
    localStorage.setItem(StorageKeys.steps, "not-json");
    expect(readJSON(StorageKeys.steps, 99)).toBe(99);
  });
});

describe("clearKey / clearAllGazeComKeys", () => {
  it("clearKey removes a single key", () => {
    writeJSON(StorageKeys.steps, 7);
    clearKey(StorageKeys.steps);
    expect(localStorage.getItem(StorageKeys.steps)).toBeNull();
  });

  it("clearAllGazeComKeys wipes only gazecom.* keys", () => {
    writeJSON(StorageKeys.steps, 7);
    writeJSON(StorageKeys.theme, "dark");
    localStorage.setItem("other-app-key", "keep-me");
    clearAllGazeComKeys();
    expect(localStorage.getItem(StorageKeys.steps)).toBeNull();
    expect(localStorage.getItem(StorageKeys.theme)).toBeNull();
    expect(localStorage.getItem("other-app-key")).toBe("keep-me");
  });
});

describe("settings files", () => {
  it("exports current settings", () => {
    writeJSON(StorageKeys.steps, 42);
    writeJSON(StorageKeys.vlmModel, "gemma4:latest");
    writeJSON(StorageKeys.llmThinkingMode, "off");
    writeJSON(StorageKeys.vlmThinkingMode, "low");
    writeJSON(StorageKeys.vlmBehavior, "guide");
    writeJSON(StorageKeys.vlmGuidePromptChoice, "hybrid");
    writeJSON(StorageKeys.vlmRotatePoolContext, true);
    writeJSON(StorageKeys.vlmGuideHistoryLimit, 12);
    writeJSON(StorageKeys.vlmScope, "canvas");
    writeJSON(StorageKeys.vlmGuidePrompt, "Choose the next location.");
    writeJSON(StorageKeys.vlmSelectPrompt, "Choose from {prompt_pool}.");
    writeJSON(StorageKeys.vlmComposePrompt, "Choose the next edit.");
    writeJSON(
      StorageKeys.vlmHybridPrompt,
      "Choose or write from {prompt_pool}.",
    );
    writeJSON(StorageKeys.vlmPointPromptHeight, 180);
    writeJSON(StorageKeys.vlmGuideActionHeight, 96);
    writeJSON(StorageKeys.autoCollapsePanels, true);
    writeJSON(StorageKeys.mutedWorkflows, ["edit/example.json"]);

    const file = createSettingsFile();

    expect(file).toMatchObject({
      format: "gazeCOM-settings",
      schema: 2,
      settings: {
        steps: 42,
        vlmModel: "gemma4:latest",
        llmThinkingMode: "off",
        vlmThinkingMode: "low",
        vlmBehavior: "guide",
        vlmGuidePromptChoice: "hybrid",
        vlmRotatePoolContext: true,
        vlmGuideHistoryLimit: 12,
        vlmScope: "canvas",
        vlmGuidePrompt: "Choose the next location.",
        vlmSelectPrompt: "Choose from {prompt_pool}.",
        vlmComposePrompt: "Choose the next edit.",
        vlmHybridPrompt: "Choose or write from {prompt_pool}.",
        vlmPointPromptHeight: 180,
        vlmGuideActionHeight: 96,
        autoCollapsePanels: true,
        mutedWorkflows: ["edit/example.json"],
      },
    });
  });

  it("imports recognized settings, ignores unknown fields, and replaces old values", () => {
    writeJSON(StorageKeys.steps, 77);
    writeJSON(StorageKeys.theme, "dark");
    localStorage.setItem("other-app-key", "keep-me");

    const count = applySettingsFile({
      format: "gazeCOM-settings",
      schema: 2,
      exportedAt: "2026-07-21T00:00:00.000Z",
      settings: { steps: 12, futureSetting: "ignored" },
    });

    expect(count).toBe(1);
    expect(readJSON(StorageKeys.steps, 0)).toBe(12);
    expect(localStorage.getItem(StorageKeys.theme)).toBeNull();
    expect(localStorage.getItem("other-app-key")).toBe("keep-me");
  });

  it("accepts a blank workflow step setting", () => {
    const count = applySettingsFile({
      format: "gazeCOM-settings",
      schema: 2,
      settings: { steps: null },
    });

    expect(count).toBe(1);
    expect(readJSON(StorageKeys.steps, 99)).toBeNull();
  });

  it("rejects invalid known values before changing current settings", () => {
    writeJSON(StorageKeys.steps, 77);

    expect(() =>
      applySettingsFile({
        format: "gazeCOM-settings",
        schema: 2,
        settings: { steps: "many" },
      }),
    ).toThrow('Invalid value for setting "steps".');
    expect(readJSON(StorageKeys.steps, 0)).toBe(77);
  });

  it("rejects an invalid VLM behavior", () => {
    expect(() =>
      applySettingsFile({
        format: "gazeCOM-settings",
        schema: 2,
        settings: { vlmBehavior: "agent" },
      }),
    ).toThrow('Invalid value for setting "vlmBehavior".');
  });

  it("rejects an invalid Guide prompt choice", () => {
    expect(() =>
      applySettingsFile({
        format: "gazeCOM-settings",
        schema: 2,
        settings: { vlmGuidePromptChoice: "weighted-select" },
      }),
    ).toThrow('Invalid value for setting "vlmGuidePromptChoice".');
  });

  it("rejects a non-boolean Rotate pool-context setting", () => {
    expect(() =>
      applySettingsFile({
        format: "gazeCOM-settings",
        schema: 2,
        settings: { vlmRotatePoolContext: "yes" },
      }),
    ).toThrow('Invalid value for setting "vlmRotatePoolContext".');
  });

  it("rejects an invalid Guide history limit", () => {
    expect(() =>
      applySettingsFile({
        format: "gazeCOM-settings",
        schema: 2,
        settings: { vlmGuideHistoryLimit: -1 },
      }),
    ).toThrow('Invalid value for setting "vlmGuideHistoryLimit".');
  });

  it("rejects an invalid Ollama thinking mode", () => {
    expect(() =>
      applySettingsFile({
        format: "gazeCOM-settings",
        schema: 2,
        settings: { vlmThinkingMode: "automatic" },
      }),
    ).toThrow('Invalid value for setting "vlmThinkingMode".');
  });

  it("rejects invalid muted workflow paths", () => {
    expect(() =>
      applySettingsFile({
        format: "gazeCOM-settings",
        schema: 2,
        settings: { mutedWorkflows: ["img/valid.json", 42] },
      }),
    ).toThrow('Invalid value for setting "mutedWorkflows".');
  });

  it("rejects unrelated and unsupported files", () => {
    expect(() => applySettingsFile({ settings: {} })).toThrow(
      "This is not a gazeCOM settings file.",
    );
    expect(() =>
      applySettingsFile({
        format: "gazeCOM-settings",
        schema: 1,
        settings: {},
      }),
    ).toThrow("Unsupported settings schema: 1.");
  });
});
