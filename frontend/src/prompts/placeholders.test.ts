import { describe, expect, it } from "vitest";
import { seededRng } from "../trackers/_test-helpers";
import {
  artists,
  cartoonCharacters,
  colors,
  replaceAllPlaceholders,
  supports,
  treeParts,
} from "./placeholders";

describe("replaceAllPlaceholders", () => {
  it("leaves untokenized strings untouched", () => {
    expect(replaceAllPlaceholders("hello world")).toBe("hello world");
  });

  it("replaces each token with a value from its vocabulary", () => {
    const result = replaceAllPlaceholders(
      "{cartoon character} on {color} {support} by {artist} of {tree part}",
      seededRng(1),
    );
    // No tokens left in output.
    expect(result).not.toMatch(/\{[^}]+\}/);
    // Each part comes from the right vocabulary.
    expect(cartoonCharacters.some((v) => result.includes(v))).toBe(true);
    expect(colors.some((v) => result.includes(v))).toBe(true);
    expect(supports.some((v) => result.includes(v))).toBe(true);
    expect(artists.some((v) => result.includes(v))).toBe(true);
    expect(treeParts.some((v) => result.includes(v))).toBe(true);
  });

  it("each occurrence of the same token rolls independently", () => {
    // With 48 cartoon characters and a sequence of 8 substitutions, a
    // collision-free output is overwhelmingly likely.
    const out = replaceAllPlaceholders(
      "{cartoon character} {cartoon character} {cartoon character} {cartoon character} {cartoon character} {cartoon character} {cartoon character} {cartoon character}",
      seededRng(7),
    );
    const picks = out.split(" ");
    // At least 2 distinct picks (typically 5–8 for any reasonable seed).
    expect(new Set(picks).size).toBeGreaterThanOrEqual(2);
  });

  it("is deterministic with the same seed", () => {
    const a = replaceAllPlaceholders(
      "{cartoon character} of {color}",
      seededRng(42),
    );
    const b = replaceAllPlaceholders(
      "{cartoon character} of {color}",
      seededRng(42),
    );
    expect(a).toBe(b);
  });
});

