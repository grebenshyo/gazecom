import { describe, expect, it } from "vitest";

import { seededRng } from "../trackers/_test-helpers";
import {
  addToPool,
  determineWorkflowType,
  pickFromPool,
  poolIsValid,
  poolSum,
  reconcilePool,
  removeFromPool,
  setPoolWeight,
  type PinnedPool,
} from "./workflows";

describe("determineWorkflowType", () => {
  it("classifies inpainting", () => {
    expect(determineWorkflowType("inpainting/x.json")).toBe("inpainting");
  });

  it("classifies img as standard", () => {
    expect(determineWorkflowType("img/SDXL-TURBO.json")).toBe("standard");
  });

  it("classifies edit", () => {
    expect(determineWorkflowType("edit/x.json")).toBe("edit");
  });

  it("rejects paths outside the category contract", () => {
    expect(() => determineWorkflowType("default/Anything.json")).toThrow(
      /Unknown workflow category/,
    );
  });
});

describe("pickFromPool", () => {
  it("returns null on empty pool", () => {
    expect(pickFromPool({})).toBeNull();
  });

  it("always picks the only available workflow", () => {
    const pool: PinnedPool = { "img/SDXL-TURBO.json": 100 };
    for (let i = 0; i < 50; i++) {
      expect(pickFromPool(pool, seededRng(i))).toBe("img/SDXL-TURBO.json");
    }
  });

  it("respects weighted distribution roughly (large sample)", () => {
    const pool: PinnedPool = {
      "default/A.json": 70,
      "default/B.json": 20,
      "default/C.json": 10,
    };
    const counts: Record<string, number> = {};
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const pick = pickFromPool(pool, Math.random);
      if (pick) counts[pick] = (counts[pick] ?? 0) + 1;
    }
    // Generous tolerance for sampling noise.
    expect(counts["default/A.json"] / N).toBeGreaterThan(0.6);
    expect(counts["default/A.json"] / N).toBeLessThan(0.8);
    expect(counts["default/B.json"] / N).toBeGreaterThan(0.13);
    expect(counts["default/B.json"] / N).toBeLessThan(0.27);
    expect(counts["default/C.json"] / N).toBeGreaterThan(0.05);
    expect(counts["default/C.json"] / N).toBeLessThan(0.15);
  });

  it("is deterministic with a seeded rng", () => {
    const pool: PinnedPool = {
      "default/A.json": 50,
      "default/B.json": 30,
      "default/C.json": 20,
    };
    const a = pickFromPool(pool, seededRng(42));
    const b = pickFromPool(pool, seededRng(42));
    expect(a).toBe(b);
  });

  it("falls back to uniform when all weights are 0 (degenerate)", () => {
    const pool: PinnedPool = { "default/A.json": 0, "default/B.json": 0 };
    // Shouldn't infinite-loop or return null; just pick something.
    const pick = pickFromPool(pool, seededRng(7));
    expect(pick).toMatch(/^default\/[AB]\.json$/);
  });
});

describe("addToPool", () => {
  it("seeds an empty pool with a single 100-weight entry", () => {
    const next = addToPool({}, "default/A.json");
    expect(next).toEqual({ "default/A.json": 100 });
  });

  it("adds a new pin at weight 0 when the pool is non-empty", () => {
    // Existing pin's weight is left untouched; user manually rebalances.
    const next = addToPool({ "default/A.json": 100 }, "default/B.json");
    expect(next).toEqual({ "default/A.json": 100, "default/B.json": 0 });
  });

  it("appends new pins in insertion order", () => {
    const a = addToPool({}, "default/A.json");
    const ab = addToPool(a, "default/B.json");
    const abc = addToPool(ab, "default/C.json");
    expect(Object.keys(abc)).toEqual([
      "default/A.json",
      "default/B.json",
      "default/C.json",
    ]);
  });

  it("is a no-op (copy) if the workflow is already pinned", () => {
    const pool: PinnedPool = { "default/A.json": 70, "default/B.json": 30 };
    const next = addToPool(pool, "default/A.json");
    expect(next).toEqual(pool);
    expect(next).not.toBe(pool); // returns a copy, doesn't mutate
  });
});

describe("reconcilePool", () => {
  it("removes stale pins and proportionally restores 100%", () => {
    expect(
      reconcilePool(
        { "img/A.json": 60, "edit/B.json": 30, "img/missing.json": 10 },
        new Set(["img/A.json", "edit/B.json"]),
      ),
    ).toEqual({ "img/A.json": 67, "edit/B.json": 33 });
  });

  it("returns an empty pool when no pins remain", () => {
    expect(reconcilePool({ "img/missing.json": 100 }, new Set())).toEqual({});
  });
});

describe("removeFromPool", () => {
  it("yields an empty pool when removing the last entry", () => {
    const next = removeFromPool({ "default/A.json": 100 }, "default/A.json");
    expect(next).toEqual({});
  });

  it("leaves the remaining entries' weights untouched (no rescale)", () => {
    const pool: PinnedPool = {
      "default/A.json": 20,
      "default/B.json": 30,
      "default/C.json": 50,
    };
    const next = removeFromPool(pool, "default/A.json");
    expect(next).toEqual({ "default/B.json": 30, "default/C.json": 50 });
    // Sum is now 80 — the user has to fix that before generating.
    expect(poolSum(next)).toBe(80);
  });

  it("preserves Object.keys order", () => {
    const pool: PinnedPool = {
      "default/A.json": 30,
      "default/B.json": 40,
      "default/C.json": 30,
    };
    const next = removeFromPool(pool, "default/B.json");
    expect(Object.keys(next)).toEqual(["default/A.json", "default/C.json"]);
  });

  it("is a no-op (copy) if the workflow isn't pinned", () => {
    const pool: PinnedPool = { "default/A.json": 100 };
    const next = removeFromPool(pool, "default/X.json");
    expect(next).toEqual(pool);
    expect(next).not.toBe(pool);
  });
});

describe("setPoolWeight", () => {
  it("sets the specified weight, leaves others untouched", () => {
    const pool: PinnedPool = { "default/A.json": 100, "default/B.json": 0 };
    const next = setPoolWeight(pool, "default/B.json", 40);
    expect(next).toEqual({ "default/A.json": 100, "default/B.json": 40 });
    // Sum > 100 — invalid pool, user must lower A. That's deliberately
    // the user's job; the function doesn't auto-correct.
    expect(poolSum(next)).toBe(140);
  });

  it("clamps the new weight to [0, 100]", () => {
    const pool: PinnedPool = { "default/A.json": 50, "default/B.json": 50 };
    const tooHigh = setPoolWeight(pool, "default/A.json", 999);
    expect(tooHigh["default/A.json"]).toBe(100);
    const tooLow = setPoolWeight(pool, "default/A.json", -5);
    expect(tooLow["default/A.json"]).toBe(0);
  });

  it("preserves Object.keys order (regression — the rebalance bug)", () => {
    const pool: PinnedPool = {
      "default/A.json": 30,
      "default/B.json": 40,
      "default/C.json": 30,
    };
    const next = setPoolWeight(pool, "default/B.json", 70);
    expect(Object.keys(next)).toEqual([
      "default/A.json",
      "default/B.json",
      "default/C.json",
    ]);
  });

  it("is a no-op (copy) if the workflow isn't pinned", () => {
    const pool: PinnedPool = { "default/A.json": 100 };
    const next = setPoolWeight(pool, "default/X.json", 50);
    expect(next).toEqual(pool);
    expect(next).not.toBe(pool);
  });
});

describe("poolSum + poolIsValid", () => {
  it("poolSum returns 0 on empty pool", () => {
    expect(poolSum({})).toBe(0);
  });

  it("poolSum totals all weights", () => {
    expect(poolSum({ a: 25, b: 25, c: 50 })).toBe(100);
    expect(poolSum({ a: 20, b: 30, c: 50 })).toBe(100);
    expect(poolSum({ a: 60, b: 30 })).toBe(90);
    expect(poolSum({ a: 50, b: 70 })).toBe(120);
  });

  it("poolIsValid: empty pool is invalid", () => {
    expect(poolIsValid({})).toBe(false);
  });

  it("poolIsValid: sum === 100 is valid", () => {
    expect(poolIsValid({ a: 100 })).toBe(true);
    expect(poolIsValid({ a: 50, b: 50 })).toBe(true);
    expect(poolIsValid({ a: 70, b: 30 })).toBe(true);
  });

  it("poolIsValid: sum !== 100 is invalid", () => {
    expect(poolIsValid({ a: 50 })).toBe(false);
    expect(poolIsValid({ a: 60, b: 30 })).toBe(false);
    expect(poolIsValid({ a: 50, b: 70 })).toBe(false);
  });
});
