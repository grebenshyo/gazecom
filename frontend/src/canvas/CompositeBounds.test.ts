import { describe, expect, it } from "vitest";

import { planComposite } from "./Composite";
import {
  clampCOMToBounds,
  deriveCompositeBounds,
  deriveRoamConstraint,
} from "./CompositeBounds";

describe("deriveCompositeBounds", () => {
  it("centers the bounds window on the first patch", () => {
    expect(
      deriveCompositeBounds(
        { enabled: true, width: 2048, height: 2048 },
        { x: 0, y: 0, width: 1024, height: 1024 },
        { width: 1024, height: 1024 },
      ),
    ).toEqual({ x: -512, y: -512, width: 2048, height: 2048 });
  });

  it("fails open when the bounds cap cannot fit the next patch", () => {
    expect(
      deriveCompositeBounds(
        { enabled: true, width: 512, height: 2048 },
        { x: 0, y: 0, width: 1024, height: 1024 },
        { width: 1024, height: 1024 },
      ),
    ).toBeUndefined();
  });
});

describe("deriveRoamConstraint", () => {
  const bounds = { x: -512, y: -512, width: 2048, height: 2048 };
  const nextSize = { width: 1024, height: 1024 };
  const containerSize = { width: 1024, height: 1024 };

  it("maps a centered base patch to the full heatmap range", () => {
    expect(
      deriveRoamConstraint({
        bounds,
        basePosition: { x: 0, y: 0, width: 1024, height: 1024 },
        nextSize,
        containerSize,
      }),
    ).toEqual({ minX: 0, maxX: 1024, minY: 0, maxY: 1024 });
  });

  it("narrows COM range near a bounds edge", () => {
    expect(
      deriveRoamConstraint({
        bounds,
        basePosition: { x: 512, y: 0, width: 1024, height: 1024 },
        nextSize,
        containerSize,
      }),
    ).toEqual({ minX: 0, maxX: 512, minY: 0, maxY: 1024 });
  });

  it("collapses to the nearest edge when recovering from outside bounds", () => {
    expect(
      deriveRoamConstraint({
        bounds,
        basePosition: { x: 1536, y: 0, width: 1024, height: 1024 },
        nextSize,
        containerSize,
      }),
    ).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 1024 });
  });
});

describe("clampCOMToBounds", () => {
  const bounds = { x: -512, y: -512, width: 2048, height: 2048 };
  const nextSize = { width: 1024, height: 1024 };

  it("keeps an edge-seeking VLM patch fully inside the bounds", () => {
    const basePosition = { x: 512, y: 0, width: 1024, height: 1024 };
    const com = clampCOMToBounds(
      { x: 1, y: 0.5 },
      bounds,
      basePosition,
      nextSize,
    );
    expect(com).toEqual({ x: 0.5, y: 0.5 });

    const plan = planComposite({
      prevSize: { width: 2048, height: 1024 },
      prevPosition: basePosition,
      newSize: nextSize,
      newCOM: com,
      workflow: "edit",
      useCOM: true,
      bounds,
    });
    expect(plan.newPosition.x).toBeGreaterThanOrEqual(0);
    expect(plan.newPosition.y).toBeGreaterThanOrEqual(0);
    expect(plan.newPosition.x + plan.newPosition.width).toBeLessThanOrEqual(
      plan.canvasSize.width,
    );
    expect(plan.newPosition.y + plan.newPosition.height).toBeLessThanOrEqual(
      plan.canvasSize.height,
    );
  });

  it("uses an out-of-range COM to recover a stranded base patch", () => {
    expect(
      clampCOMToBounds(
        { x: 1, y: 0.5 },
        bounds,
        { x: 1536, y: 0, width: 1024, height: 1024 },
        nextSize,
      ),
    ).toEqual({ x: -0.5, y: 0.5 });
  });

  it("leaves COM unchanged when bounds are disabled", () => {
    expect(
      clampCOMToBounds(
        { x: 0.9, y: 0.1 },
        undefined,
        { x: 512, y: 0, width: 1024, height: 1024 },
        nextSize,
      ),
    ).toEqual({ x: 0.9, y: 0.1 });
  });
});
