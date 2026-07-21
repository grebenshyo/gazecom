import { afterEach, describe, expect, it } from "vitest";
import {
  StorageKeys,
  applySettingsFile,
  clearAllGenGazeKeys,
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

describe("clearKey / clearAllGenGazeKeys", () => {
  it("clearKey removes a single key", () => {
    writeJSON(StorageKeys.steps, 7);
    clearKey(StorageKeys.steps);
    expect(localStorage.getItem(StorageKeys.steps)).toBeNull();
  });

  it("clearAllGenGazeKeys wipes only gengaze.* keys", () => {
    writeJSON(StorageKeys.steps, 7);
    writeJSON(StorageKeys.theme, "dark");
    localStorage.setItem("other-app-key", "keep-me");
    clearAllGenGazeKeys();
    expect(localStorage.getItem(StorageKeys.steps)).toBeNull();
    expect(localStorage.getItem(StorageKeys.theme)).toBeNull();
    expect(localStorage.getItem("other-app-key")).toBe("keep-me");
  });
});

describe("settings files", () => {
  it("exports current settings without legacy keys", () => {
    writeJSON(StorageKeys.steps, 42);
    writeJSON(StorageKeys.vlmModel, "gemma4:latest");
    writeJSON(StorageKeys.roamSpeed, 9);

    const file = createSettingsFile();

    expect(file).toMatchObject({
      format: "gazeCOM-settings",
      schema: 1,
      settings: { steps: 42, vlmModel: "gemma4:latest" },
    });
    expect(file.settings).not.toHaveProperty("roamSpeed");
  });

  it("imports recognized settings, ignores unknown fields, and replaces old values", () => {
    writeJSON(StorageKeys.steps, 77);
    writeJSON(StorageKeys.theme, "dark");
    localStorage.setItem("other-app-key", "keep-me");

    const count = applySettingsFile({
      format: "gazeCOM-settings",
      schema: 1,
      exportedAt: "2026-07-21T00:00:00.000Z",
      settings: { steps: 12, futureSetting: "ignored" },
    });

    expect(count).toBe(1);
    expect(readJSON(StorageKeys.steps, 0)).toBe(12);
    expect(localStorage.getItem(StorageKeys.theme)).toBeNull();
    expect(localStorage.getItem("other-app-key")).toBe("keep-me");
  });

  it("rejects invalid known values before changing current settings", () => {
    writeJSON(StorageKeys.steps, 77);

    expect(() =>
      applySettingsFile({
        format: "gazeCOM-settings",
        schema: 1,
        settings: { steps: "many" },
      }),
    ).toThrow('Invalid value for setting "steps".');
    expect(readJSON(StorageKeys.steps, 0)).toBe(77);
  });

  it("rejects unrelated and unsupported files", () => {
    expect(() => applySettingsFile({ settings: {} })).toThrow(
      "This is not a gazeCOM settings file.",
    );
    expect(() =>
      applySettingsFile({
        format: "gazeCOM-settings",
        schema: 2,
        settings: {},
      }),
    ).toThrow("Unsupported settings schema: 2.");
  });
});
