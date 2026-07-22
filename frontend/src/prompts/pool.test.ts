import { describe, expect, it } from "vitest";

import { seededRng } from "../trackers/_test-helpers";
import {
  addPromptSlot,
  nextPromptAutoEnhanceMode,
  pickPromptSlot,
  promptPoolHasActiveSlot,
  promptSlotAutoEnhanceMode,
  promptSlotMuted,
  promptSlotVisionEnabled,
  promptSlotsForPersistence,
  promptPoolIsValid,
  removePromptSlot,
  setPromptSlotAutoEnhanceMode,
  setPromptSlotDerivedHeight,
  setPromptSlotDerivedText,
  setPromptSlotHeight,
  setPromptSlotMuted,
  setPromptSlotText,
  setPromptSlotVisionEnabled,
  setPromptSlotWeight,
  type PromptSlots,
} from "./pool";

const baseOnly = (): PromptSlots => [
  {
    text: "",
    weight: 100,
    height: null,
    autoEnhanceMode: "off",
    visionEnabled: false,
    derivedText: "",
    derivedHeight: null,
  },
];

describe("addPromptSlot", () => {
  it("appends an empty slot at the end (weight 0, height null)", () => {
    const next = addPromptSlot(baseOnly());
    expect(next).toEqual([
      {
        text: "",
        weight: 100,
        height: null,
        autoEnhanceMode: "off",
        visionEnabled: false,
        derivedText: "",
        derivedHeight: null,
      },
      {
        text: "",
        weight: 0,
        muted: false,
        height: null,
        autoEnhanceMode: "off",
        visionEnabled: false,
        derivedText: "",
        derivedHeight: null,
      },
    ]);
  });

  it("preserves array order on repeated adds", () => {
    let s = baseOnly();
    s = addPromptSlot(s);
    s = addPromptSlot(s);
    expect(s.length).toBe(3);
    // Base stays first.
    expect(s[0].text).toBe("");
    expect(s[0].weight).toBe(100);
  });

  it("does not mutate the input", () => {
    const a = baseOnly();
    const b = addPromptSlot(a);
    expect(a.length).toBe(1);
    expect(b.length).toBe(2);
    expect(a).not.toBe(b);
  });
});

describe("removePromptSlot", () => {
  it("refuses to drop the base slot", () => {
    const slots: PromptSlots = [
      { text: "base", weight: 60, height: null },
      { text: "x", weight: 40, height: null },
    ];
    const next = removePromptSlot(slots, 0);
    expect(next).toEqual(slots);
    expect(next).not.toBe(slots);
  });

  it("drops non-base slots and shifts the array down", () => {
    const slots: PromptSlots = [
      { text: "base", weight: 50, height: null },
      { text: "a", weight: 20, height: null },
      { text: "b", weight: 30, height: null },
    ];
    expect(removePromptSlot(slots, 1)).toEqual([
      { text: "base", weight: 50, height: null },
      { text: "b", weight: 30, height: null },
    ]);
  });

  it("no-ops on out-of-range index", () => {
    const slots = baseOnly();
    expect(removePromptSlot(slots, 99)).toEqual(slots);
    expect(removePromptSlot(slots, -5)).toEqual(slots);
  });
});

describe("setPromptSlotText", () => {
  it("updates one slot's text and leaves the rest", () => {
    const slots: PromptSlots = [
      { text: "a", weight: 50, height: null },
      { text: "b", weight: 50, height: 120 },
    ];
    const next = setPromptSlotText(slots, 1, "B!");
    expect(next).toEqual([
      { text: "a", weight: 50, height: null },
      { text: "B!", weight: 50, height: 120 },
    ]);
  });

  it("no-ops on out-of-range index", () => {
    const slots = baseOnly();
    expect(setPromptSlotText(slots, 99, "x")).toEqual(slots);
  });
});

describe("setPromptSlotDerivedText", () => {
  it("updates one slot's derived text and leaves the instruction text alone", () => {
    const slots: PromptSlots = [
      { text: "describe", weight: 50, height: null },
      { text: "summarize", weight: 50, height: null },
    ];
    const next = setPromptSlotDerivedText(slots, 0, "a red cabin at dusk");
    expect(next).toEqual([
      {
        text: "describe",
        weight: 50,
        height: null,
        derivedText: "a red cabin at dusk",
      },
      { text: "summarize", weight: 50, height: null },
    ]);
  });

  it("does not mutate the input", () => {
    const slots: PromptSlots = [
      { text: "describe", weight: 100, height: null },
    ];
    const next = setPromptSlotDerivedText(slots, 0, "generated prompt");
    expect(next).not.toBe(slots);
    expect(slots[0].derivedText).toBeUndefined();
  });

  it("no-ops on out-of-range index", () => {
    const slots = baseOnly();
    expect(setPromptSlotDerivedText(slots, 99, "x")).toEqual(slots);
  });
});

describe("setPromptSlotDerivedHeight", () => {
  it("updates one slot's derived prompt height", () => {
    const slots: PromptSlots = [
      { text: "describe", weight: 100, height: null },
    ];
    expect(setPromptSlotDerivedHeight(slots, 0, 96)).toEqual([
      {
        text: "describe",
        weight: 100,
        height: null,
        derivedHeight: 96,
      },
    ]);
  });

  it("accepts null to reset the derived prompt height", () => {
    const slots: PromptSlots = [
      {
        text: "describe",
        weight: 100,
        height: null,
        derivedHeight: 120,
      },
    ];
    expect(setPromptSlotDerivedHeight(slots, 0, null)[0].derivedHeight)
      .toBeNull();
  });

  it("no-ops on out-of-range index", () => {
    const slots = baseOnly();
    expect(setPromptSlotDerivedHeight(slots, 99, 96)).toEqual(slots);
  });
});

describe("promptSlotsForPersistence", () => {
  it("strips live generated prompt text while preserving sizing/preferences", () => {
    const slots: PromptSlots = [
      {
        text: "describe",
        weight: 100,
        height: 80,
        visionEnabled: true,
        derivedText: "large generated prompt",
        derivedHeight: 140,
      },
    ];
    expect(promptSlotsForPersistence(slots)).toEqual([
      {
        text: "describe",
        weight: 100,
        height: 80,
        visionEnabled: true,
        derivedText: "",
        derivedHeight: 140,
      },
    ]);
  });
});

describe("setPromptSlotWeight", () => {
  it("keeps a single-slot pool weight editable", () => {
    const next = setPromptSlotWeight(baseOnly(), 0, 42);
    expect(next[0].weight).toBe(42);
  });

  it("sets relative weights as-is without rebalancing", () => {
    const slots: PromptSlots = [
      { text: "a", weight: 100, height: null },
      { text: "b", weight: 0, height: null },
    ];
    const next = setPromptSlotWeight(slots, 1, 40);
    expect(next).toEqual([
      { text: "a", weight: 100, height: null }, // unchanged — user's job to lower it
      { text: "b", weight: 40, height: null },
    ]);
  });

  it("clamps weight to [0, 100]", () => {
    const slots: PromptSlots = [
      { text: "a", weight: 50, height: null },
      { text: "b", weight: 50, height: null },
    ];
    expect(setPromptSlotWeight(slots, 1, 999)[1].weight).toBe(100);
    expect(setPromptSlotWeight(slots, 1, -5)[1].weight).toBe(0);
  });

  it("no-ops on out-of-range index", () => {
    const slots = baseOnly();
    expect(setPromptSlotWeight(slots, 99, 50)).toEqual(slots);
  });
});

describe("prompt slot muting", () => {
  it("normalizes missing mute state to active", () => {
    expect(promptSlotMuted(undefined)).toBe(false);
    expect(promptSlotMuted({ text: "x", weight: 100, height: null })).toBe(false);
    expect(
      promptSlotMuted({ text: "x", weight: 100, height: null, muted: true }),
    ).toBe(true);
  });

  it("toggles one slot without changing its authored weight", () => {
    const slots: PromptSlots = [
      { text: "a", weight: 60, height: null },
      { text: "b", weight: 40, height: null },
    ];
    const next = setPromptSlotMuted(slots, 1, true);
    expect(next).toEqual([
      { text: "a", weight: 60, height: null },
      { text: "b", weight: 40, height: null, muted: true },
    ]);
    expect(slots[1].muted).toBeUndefined();
  });
});

describe("setPromptSlotHeight", () => {
  it("updates one slot's height and leaves the rest", () => {
    const slots: PromptSlots = [
      { text: "a", weight: 50, height: null },
      { text: "b", weight: 50, height: null },
    ];
    expect(setPromptSlotHeight(slots, 1, 140)).toEqual([
      { text: "a", weight: 50, height: null },
      { text: "b", weight: 50, height: 140 },
    ]);
  });

  it("accepts null to reset the slot's height", () => {
    const slots: PromptSlots = [{ text: "x", weight: 100, height: 200 }];
    expect(setPromptSlotHeight(slots, 0, null)[0].height).toBeNull();
  });
});

describe("auto enhance mode helpers", () => {
  it("normalizes missing or invalid modes to off", () => {
    expect(promptSlotAutoEnhanceMode(undefined)).toBe("off");
    expect(promptSlotAutoEnhanceMode({ text: "x", weight: 100, height: null }))
      .toBe("off");
    expect(
      promptSlotAutoEnhanceMode({
        text: "x",
        weight: 100,
        height: null,
        autoEnhanceMode: "send",
      }),
    ).toBe("send");
  });

  it("cycles off -> send -> evolve -> off", () => {
    expect(nextPromptAutoEnhanceMode("off")).toBe("send");
    expect(nextPromptAutoEnhanceMode(undefined)).toBe("send");
    expect(nextPromptAutoEnhanceMode("send")).toBe("evolve");
    expect(nextPromptAutoEnhanceMode("evolve")).toBe("off");
  });

  it("updates one slot's auto enhance mode without mutating the input", () => {
    const slots: PromptSlots = [
      { text: "a", weight: 50, height: null },
      { text: "b", weight: 50, height: null },
    ];
    const next = setPromptSlotAutoEnhanceMode(slots, 1, "evolve");
    expect(next).toEqual([
      { text: "a", weight: 50, height: null },
      { text: "b", weight: 50, height: null, autoEnhanceMode: "evolve" },
    ]);
    expect(next).not.toBe(slots);
    expect(slots[1].autoEnhanceMode).toBeUndefined();
  });

  it("no-ops on out-of-range index", () => {
    const slots = baseOnly();
    expect(setPromptSlotAutoEnhanceMode(slots, 99, "send")).toEqual(slots);
  });
});

describe("vision helpers", () => {
  it("normalizes missing vision state to off", () => {
    expect(promptSlotVisionEnabled(undefined)).toBe(false);
    expect(promptSlotVisionEnabled({ text: "x", weight: 100, height: null }))
      .toBe(false);
    expect(
      promptSlotVisionEnabled({
        text: "x",
        weight: 100,
        height: null,
        visionEnabled: true,
      }),
    ).toBe(true);
  });

  it("updates one slot's vision state without mutating the input", () => {
    const slots: PromptSlots = [
      { text: "a", weight: 50, height: null },
      { text: "b", weight: 50, height: null },
    ];
    const next = setPromptSlotVisionEnabled(slots, 1, true);
    expect(next).toEqual([
      { text: "a", weight: 50, height: null },
      { text: "b", weight: 50, height: null, visionEnabled: true },
    ]);
    expect(next).not.toBe(slots);
    expect(slots[1].visionEnabled).toBeUndefined();
  });

  it("no-ops on out-of-range index", () => {
    const slots = baseOnly();
    expect(setPromptSlotVisionEnabled(slots, 99, true)).toEqual(slots);
  });
});

describe("promptPoolIsValid", () => {
  it("promptPoolIsValid: empty pool is invalid", () => {
    expect(promptPoolIsValid([])).toBe(false);
  });

  it("accepts any total with a positive, unmuted slot", () => {
    expect(promptPoolIsValid(baseOnly())).toBe(true);
    expect(
      promptPoolIsValid([
        { text: "", weight: 12, height: null },
        { text: "", weight: 3, height: null },
      ]),
    ).toBe(true);
    expect(
      promptPoolIsValid([{ text: "", weight: 1, height: null }]),
    ).toBe(true);
  });

  it("requires at least one positive, unmuted slot", () => {
    const slots: PromptSlots = [
      { text: "a", weight: 60, height: null },
      { text: "b", weight: 40, height: null, muted: true },
    ];
    expect(promptPoolHasActiveSlot(slots)).toBe(true);
    expect(promptPoolIsValid(slots)).toBe(true);

    const allMuted = setPromptSlotMuted(slots, 0, true);
    expect(promptPoolHasActiveSlot(allMuted)).toBe(false);
    expect(promptPoolIsValid(allMuted)).toBe(false);
    expect(
      promptPoolIsValid([
        { text: "a", weight: 0, height: null },
        { text: "b", weight: 0, height: null },
      ]),
    ).toBe(false);
  });
});

describe("pickPromptSlot", () => {
  it("returns null on empty pool", () => {
    expect(pickPromptSlot([])).toBeNull();
  });

  it("always returns the single slot when only one exists", () => {
    const slots = baseOnly();
    for (let i = 0; i < 50; i++) {
      expect(pickPromptSlot(slots, seededRng(i))).toEqual({
        text: "",
        index: 0,
      });
    }
  });

  it("respects weighted distribution roughly (large sample)", () => {
    const slots: PromptSlots = [
      { text: "a", weight: 70, height: null },
      { text: "b", weight: 20, height: null },
      { text: "c", weight: 10, height: null },
    ];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const pick = pickPromptSlot(slots);
      if (pick) counts[pick.text] += 1;
    }
    // Generous tolerance for sampling noise.
    expect(counts.a / N).toBeGreaterThan(0.6);
    expect(counts.a / N).toBeLessThan(0.8);
    expect(counts.b / N).toBeGreaterThan(0.13);
    expect(counts.b / N).toBeLessThan(0.27);
    expect(counts.c / N).toBeGreaterThan(0.05);
    expect(counts.c / N).toBeLessThan(0.15);
  });

  it("is deterministic with a seeded rng", () => {
    const slots: PromptSlots = [
      { text: "x", weight: 50, height: null },
      { text: "y", weight: 30, height: null },
      { text: "z", weight: 20, height: null },
    ];
    expect(pickPromptSlot(slots, seededRng(42))).toEqual(
      pickPromptSlot(slots, seededRng(42)),
    );
  });

  it("normalizes arbitrary relative totals during selection", () => {
    const slots: PromptSlots = [
      { text: "a", weight: 2, height: null },
      { text: "b", weight: 1, height: null },
    ];
    expect(pickPromptSlot(slots, () => 0.65)).toEqual({ text: "a", index: 0 });
    expect(pickPromptSlot(slots, () => 0.75)).toEqual({ text: "b", index: 1 });
  });

  it("returns null when all weights are 0", () => {
    const slots: PromptSlots = [
      { text: "a", weight: 0, height: null },
      { text: "b", weight: 0, height: null },
    ];
    expect(pickPromptSlot(slots, seededRng(7))).toBeNull();
  });

  it("skips muted slots while retaining original indices", () => {
    const slots: PromptSlots = [
      { text: "a", weight: 50, height: null, muted: true },
      { text: "b", weight: 30, height: null },
      { text: "c", weight: 20, height: null },
    ];
    expect(pickPromptSlot(slots, () => 0)).toEqual({ text: "b", index: 1 });
  });
});
