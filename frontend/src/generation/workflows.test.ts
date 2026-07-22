import { describe, expect, it } from "vitest";

import { seededRng } from "../trackers/_test-helpers";
import {
  activePool,
  addToPool,
  determineWorkflowType,
  pickFromPool,
  reconcilePool,
  removeFromPool,
  setPoolWeight,
  type PinnedPool,
} from "./workflows";

describe("activePool", () => {
  it("excludes muted and zero-weight workflows without changing stored weights", () => {
    const pool: PinnedPool = {
      "img/A.json": 50,
      "edit/B.json": 50,
      "img/C.json": 0,
    };

    expect(activePool(pool, ["edit/B.json"])).toEqual({ "img/A.json": 50 });
    expect(pool).toEqual({
      "img/A.json": 50,
      "edit/B.json": 50,
      "img/C.json": 0,
    });
  });

  it("returns an empty pool when every non-zero workflow is muted", () => {
    expect(activePool({ "img/A.json": 100 }, ["img/A.json"])).toEqual({});
  });
});

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

  it("normalizes an arbitrary positive total", () => {
    const pool: PinnedPool = { "img/A.json": 30, "img/B.json": 20 };
    expect(pickFromPool(pool, () => 0.59)).toBe("img/A.json");
    expect(pickFromPool(pool, () => 0.61)).toBe("img/B.json");
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

  it("returns null when all weights are 0", () => {
    const pool: PinnedPool = { "default/A.json": 0, "default/B.json": 0 };
    expect(pickFromPool(pool, seededRng(7))).toBeNull();
  });
});

describe("addToPool", () => {
  it("seeds an empty pool with a single 100-weight entry", () => {
    const next = addToPool({}, "default/A.json");
    expect(next).toEqual({ "default/A.json": 100 });
  });

  it("adds a new pin at weight 0 when the pool is non-empty", () => {
    // Existing relative selection is left untouched until the user assigns
    // the new workflow a positive weight.
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
  it("removes stale pins without rewriting remaining relative weights", () => {
    expect(
      reconcilePool(
        { "img/A.json": 60, "edit/B.json": 30, "img/missing.json": 10 },
        new Set(["img/A.json", "edit/B.json"]),
      ),
    ).toEqual({ "img/A.json": 60, "edit/B.json": 30 });
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
