import { describe, expect, it } from "vitest";

import {
  clampCOMToBounds,
  deriveCOMBounds,
  deriveCompositeMaxSize,
  deriveRoamConstraint,
} from "./CompositeBounds";

describe("deriveCompositeMaxSize", () => {
  it("returns the enabled positive size cap", () => {
    expect(
      deriveCompositeMaxSize({
        enabled: true,
        width: 2048,
        height: 1536,
      }),
    ).toEqual({ width: 2048, height: 1536 });
  });

  it("returns undefined when disabled or invalid", () => {
    expect(
      deriveCompositeMaxSize({
        enabled: false,
        width: 2048,
        height: 2048,
      }),
    ).toBeUndefined();
    expect(
      deriveCompositeMaxSize({ enabled: true, width: 0, height: 2048 }),
    ).toBeUndefined();
  });
});

describe("deriveCOMBounds", () => {
  const maxSize = { width: 2048, height: 2048 };

  it("allows growth beyond both edges while the canvas is below the cap", () => {
    expect(
      deriveCOMBounds(maxSize, { width: 1024, height: 1536 }),
    ).toEqual({
      x: -1024,
      y: -512,
      width: 3072,
      height: 2560,
    });
  });

  it("matches the canvas edges once the cap is reached", () => {
    expect(
      deriveCOMBounds(maxSize, { width: 2048, height: 2048 }),
    ).toEqual({
      x: 0,
      y: 0,
      width: 2048,
      height: 2048,
    });
  });
});

describe("deriveRoamConstraint", () => {
  const containerSize = { width: 1024, height: 1024 };

  it("keeps the full local range while the canvas can still grow", () => {
    const bounds = deriveCOMBounds(
      { width: 2048, height: 2048 },
      { width: 1536, height: 1536 },
    )!;
    expect(
      deriveRoamConstraint({
        bounds,
        basePosition: { x: 512, y: 512, width: 1024, height: 1024 },
        containerSize,
      }),
    ).toEqual({ minX: 0, maxX: 1024, minY: 0, maxY: 1024 });
  });

  it("narrows the local range after the canvas reaches its cap", () => {
    const bounds = deriveCOMBounds(
      { width: 2048, height: 2048 },
      { width: 2048, height: 2048 },
    )!;
    expect(
      deriveRoamConstraint({
        bounds,
        basePosition: { x: 1536, y: 0, width: 1024, height: 1024 },
        containerSize,
      }),
    ).toEqual({ minX: 0, maxX: 512, minY: 0, maxY: 1024 });
  });

  it("collapses to the nearest edge when recovering from outside bounds", () => {
    const bounds = deriveCOMBounds(
      { width: 2048, height: 2048 },
      { width: 2048, height: 2048 },
    )!;
    expect(
      deriveRoamConstraint({
        bounds,
        basePosition: { x: 2048, y: 0, width: 1024, height: 1024 },
        containerSize,
      }),
    ).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 1024 });
  });
});

describe("clampCOMToBounds", () => {
  it("allows the COM point to grow toward a not-yet-reached cap", () => {
    const bounds = deriveCOMBounds(
      { width: 2048, height: 2048 },
      { width: 1536, height: 1024 },
    );
    const basePosition = { x: 512, y: 0, width: 1024, height: 1024 };
    const com = clampCOMToBounds(
      { x: 1, y: 0.5 },
      bounds,
      basePosition,
    );
    expect(com).toEqual({ x: 1, y: 0.5 });
  });

  it("clamps an over-bound point after the cap is reached", () => {
    const bounds = deriveCOMBounds(
      { width: 2048, height: 2048 },
      { width: 2048, height: 2048 },
    );
    expect(
      clampCOMToBounds(
        { x: 1, y: 0.5 },
        bounds,
        { x: 1536, y: 0, width: 1024, height: 1024 },
      ),
    ).toEqual({ x: 0.5, y: 0.5 });
  });

  it("uses an out-of-range COM to recover a stranded base patch", () => {
    const bounds = deriveCOMBounds(
      { width: 2048, height: 2048 },
      { width: 2048, height: 2048 },
    );
    expect(
      clampCOMToBounds(
        { x: 1, y: 0.5 },
        bounds,
        { x: 2048, y: 0, width: 1024, height: 1024 },
      ),
    ).toEqual({ x: 0, y: 0.5 });
  });

  it("leaves COM unchanged when bounds are disabled", () => {
    expect(
      clampCOMToBounds(
        { x: 0.9, y: 0.1 },
        undefined,
        { x: 512, y: 0, width: 1024, height: 1024 },
      ),
    ).toEqual({ x: 0.9, y: 0.1 });
  });
});
