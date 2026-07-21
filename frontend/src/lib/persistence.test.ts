import { afterEach, describe, expect, it } from "vitest";
import {
  StorageKeys,
  clearAllGenGazeKeys,
  clearKey,
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
