import { describe, expect, it } from "vitest";
import { planComposite, type PlanInput } from "./Composite";

/**
 * The "first patch" baseline matches what legacy ImageProcessor sets up at
 * load time (image-processor.js:472-475): a 1024×1024 base image at (0,0).
 */
const baseInput = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  prevSize: { width: 1024, height: 1024 },
  prevPosition: { x: 0, y: 0, width: 1024, height: 1024 },
  newSize: { width: 1024, height: 1024 },
  newCOM: { x: 0.5, y: 0.5 },
  workflow: "standard",
  useCOM: false,
  ...overrides,
});

describe("planComposite — placement geometry", () => {
  it("standard non-COM at center: new patch lands exactly on previous", () => {
    const plan = planComposite(baseInput());
    expect(plan.canvasSize).toEqual({ width: 1024, height: 1024 });
    expect(plan.prevDrawAt).toEqual({ x: 0, y: 0 });
    expect(plan.newDrawAt).toEqual({ x: 0, y: 0 });
    expect(plan.coordinateShift).toEqual({ x: 0, y: 0 });
  });

  it("workflow type does not force COM — useCOM alone decides", () => {
    // COM in the bottom-right quadrant. Edit/in-/outpainting no longer imply COM.
    const com = { x: 1.0, y: 1.0 };
    const off = planComposite(
      baseInput({ workflow: "inpainting", useCOM: false, newCOM: com }),
    );
    const on = planComposite(
      baseInput({ workflow: "inpainting", useCOM: true, newCOM: com }),
    );
    // useCOM=false → geometric center → patch lands on prev, no growth.
    expect(off.canvasSize).toEqual({ width: 1024, height: 1024 });
    expect(off.newDrawAt).toEqual({ x: 0, y: 0 });
    expect(off.coordinateShift).toEqual({ x: 0, y: 0 });
    // useCOM=true → anchor=(1024,1024) → newDrawAt=(512,512), grows to 1536².
    expect(on.canvasSize).toEqual({ width: 1536, height: 1536 });
    expect(on.newDrawAt).toEqual({ x: 512, y: 512 });
  });

  it("standard with useCOM=true uses COM; without, uses geometric center", () => {
    const com = { x: 0.25, y: 0.25 };
    const withCOM = planComposite(
      baseInput({ workflow: "standard", useCOM: true, newCOM: com }),
    );
    const withoutCOM = planComposite(
      baseInput({ workflow: "standard", useCOM: false, newCOM: com }),
    );
    // useCOM=true: anchor=(256, 256) → newRaw=(-256, -256) → canvas grows
    expect(withCOM.coordinateShift).toEqual({ x: 256, y: 256 });
    // useCOM=false: anchor=center=(512, 512) → no growth, drawn over prev
    expect(withoutCOM.coordinateShift).toEqual({ x: 0, y: 0 });
    expect(withoutCOM.canvasSize).toEqual({ width: 1024, height: 1024 });
  });
});

describe("planComposite — canvas growth and coordinate shift", () => {
  it("growth to the right only: shift stays zero", () => {
    const plan = planComposite(
      baseInput({
        workflow: "inpainting",
        useCOM: true,
        newCOM: { x: 1.0, y: 0.5 },
      }),
    );
    // anchor = (1024, 512), new top-left = (512, 0), new bottom-right = (1536, 1024)
    expect(plan.canvasSize).toEqual({ width: 1536, height: 1024 });
    expect(plan.prevDrawAt).toEqual({ x: 0, y: 0 });
    expect(plan.newDrawAt).toEqual({ x: 512, y: 0 });
    expect(plan.coordinateShift).toEqual({ x: 0, y: 0 });
  });

  it("growth to the left only: shift is positive in x", () => {
    const plan = planComposite(
      baseInput({
        workflow: "inpainting",
        useCOM: true,
        newCOM: { x: 0.0, y: 0.5 },
      }),
    );
    // anchor = (0, 512), new top-left = (-512, 0), new bottom-right = (512, 1024)
    expect(plan.canvasSize).toEqual({ width: 1536, height: 1024 });
    expect(plan.prevDrawAt).toEqual({ x: 512, y: 0 });
    expect(plan.newDrawAt).toEqual({ x: 0, y: 0 });
    expect(plan.coordinateShift).toEqual({ x: 512, y: 0 });
  });

  it("growth in both directions: shift in x and y", () => {
    const plan = planComposite(
      baseInput({
        workflow: "inpainting",
        useCOM: true,
        newCOM: { x: 0.0, y: 0.0 },
      }),
    );
    // anchor = (0, 0), new top-left = (-512, -512), new bottom-right = (512, 512)
    expect(plan.canvasSize).toEqual({ width: 1536, height: 1536 });
    expect(plan.prevDrawAt).toEqual({ x: 512, y: 512 });
    expect(plan.newDrawAt).toEqual({ x: 0, y: 0 });
    expect(plan.coordinateShift).toEqual({ x: 512, y: 512 });
  });

  it("non-square new patch grows canvas correctly", () => {
    const plan = planComposite(
      baseInput({
        workflow: "inpainting",
        useCOM: true,
        newSize: { width: 512, height: 768 },
        newCOM: { x: 1.0, y: 1.0 },
      }),
    );
    // anchor = (1024, 1024), new top-left = (768, 640), new bottom-right = (1280, 1408)
    expect(plan.canvasSize).toEqual({ width: 1280, height: 1408 });
    expect(plan.newDrawAt).toEqual({ x: 768, y: 640 });
    expect(plan.coordinateShift).toEqual({ x: 0, y: 0 });
  });
});

describe("planComposite — draw order", () => {
  it("all workflow types paint old under new", () => {
    for (const workflow of ["standard", "inpainting", "edit"] as const) {
      const plan = planComposite(baseInput({ workflow }));
      expect(plan.drawOrder).toBe("old-then-new");
    }
  });
});

describe("planComposite — maximum canvas size", () => {
  it("does nothing when the natural placement already fits", () => {
    const plan = planComposite(
      baseInput({
        workflow: "inpainting",
        useCOM: true,
        newCOM: { x: 0.6, y: 0.6 },
        maxSize: { width: 2048, height: 2048 },
      }),
    );
    expect(plan.newDrawAt).toEqual({ x: 102, y: 102 });
    expect(plan.coordinateShift).toEqual({ x: 0, y: 0 });
  });

  it("reaches the cap through one-directional growth before clipping", () => {
    const first = planComposite(
      baseInput({
        workflow: "inpainting",
        useCOM: true,
        newCOM: { x: 1.0, y: 1.0 },
        maxSize: { width: 2048, height: 2048 },
      }),
    );
    expect(first.canvasSize).toEqual({ width: 1536, height: 1536 });

    const second = planComposite({
      prevSize: first.canvasSize,
      prevPosition: first.newPosition,
      newSize: { width: 1024, height: 1024 },
      newCOM: { x: 1, y: 1 },
      workflow: "inpainting",
      useCOM: true,
      maxSize: { width: 2048, height: 2048 },
    });
    expect(second.canvasSize).toEqual({ width: 2048, height: 2048 });
    expect(second.newDrawAt).toEqual({ x: 1024, y: 1024 });

    const third = planComposite({
      prevSize: second.canvasSize,
      prevPosition: second.newPosition,
      newSize: { width: 1024, height: 1024 },
      newCOM: { x: 1, y: 1 },
      workflow: "inpainting",
      useCOM: true,
      maxSize: { width: 2048, height: 2048 },
    });
    expect(third.canvasSize).toEqual({ width: 2048, height: 2048 });
    expect(third.newDrawAt).toEqual({ x: 1536, y: 1536 });
    expect(third.newPosition.x + third.newPosition.width).toBeGreaterThan(
      third.canvasSize.width,
    );
  });

  it("reaches the cap through left/up growth and then clips in place", () => {
    const first = planComposite(
      baseInput({
        workflow: "inpainting",
        useCOM: true,
        newCOM: { x: 0.0, y: 0.0 },
        maxSize: { width: 2048, height: 2048 },
      }),
    );
    expect(first.canvasSize).toEqual({ width: 1536, height: 1536 });
    expect(first.coordinateShift).toEqual({ x: 512, y: 512 });

    const second = planComposite({
      prevSize: first.canvasSize,
      prevPosition: first.newPosition,
      newSize: { width: 1024, height: 1024 },
      newCOM: { x: 0, y: 0 },
      workflow: "inpainting",
      useCOM: true,
      maxSize: { width: 2048, height: 2048 },
    });
    expect(second.canvasSize).toEqual({ width: 2048, height: 2048 });
    expect(second.coordinateShift).toEqual({ x: 512, y: 512 });

    const third = planComposite({
      prevSize: second.canvasSize,
      prevPosition: second.newPosition,
      newSize: { width: 1024, height: 1024 },
      newCOM: { x: 0, y: 0 },
      workflow: "inpainting",
      useCOM: true,
      maxSize: { width: 2048, height: 2048 },
    });
    expect(third.canvasSize).toEqual({ width: 2048, height: 2048 });
    expect(third.coordinateShift).toEqual({ x: 0, y: 0 });
    expect(third.newDrawAt).toEqual({ x: -512, y: -512 });
  });

  it("an off-canvas Pull below the cap expands to the cap immediately", () => {
    const plan = planComposite({
      prevSize: { width: 1280, height: 1280 },
      prevPosition: { x: 1800, y: 1800, width: 1024, height: 1024 },
      newSize: { width: 1024, height: 1024 },
      newCOM: { x: 0.5, y: 0.5 },
      workflow: "inpainting",
      useCOM: true,
      maxSize: { width: 2048, height: 2048 },
    });
    expect(plan.canvasSize).toEqual({ width: 2048, height: 2048 });
    expect(plan.newDrawAt).toEqual({ x: 1800, y: 1800 });
    expect(plan.coordinateShift).toEqual({ x: 0, y: 0 });
  });

  it("preserves the existing canvas and exact patch offset under the cap", () => {
    for (const previousSize of [1024, 1280, 1536, 2048]) {
      for (const patchStart of [-1536, -512, 0, 1024, 1800]) {
        const plan = planComposite({
          prevSize: { width: previousSize, height: previousSize },
          // With a centered COM and equal patch/base dimensions, this is also
          // the new patch's natural top-left.
          prevPosition: {
            x: patchStart,
            y: patchStart,
            width: 1024,
            height: 1024,
          },
          newSize: { width: 1024, height: 1024 },
          newCOM: { x: 0.5, y: 0.5 },
          workflow: "edit",
          useCOM: true,
          maxSize: { width: 2048, height: 2048 },
        });

        expect(plan.canvasSize.width).toBeLessThanOrEqual(2048);
        expect(plan.canvasSize.height).toBeLessThanOrEqual(2048);
        expect(plan.prevDrawAt.x).toBeGreaterThanOrEqual(0);
        expect(plan.prevDrawAt.y).toBeGreaterThanOrEqual(0);
        expect(plan.prevDrawAt.x + previousSize).toBeLessThanOrEqual(
          plan.canvasSize.width,
        );
        expect(plan.prevDrawAt.y + previousSize).toBeLessThanOrEqual(
          plan.canvasSize.height,
        );
        expect(plan.newDrawAt.x - plan.prevDrawAt.x).toBe(patchStart);
        expect(plan.newDrawAt.y - plan.prevDrawAt.y).toBe(patchStart);
      }
    }
  });

  it("crops an already-oversized canvas toward the active patch", () => {
    const plan = planComposite({
      prevSize: { width: 2500, height: 1024 },
      prevPosition: { x: 2000, y: 0, width: 1024, height: 1024 },
      newSize: { width: 1024, height: 1024 },
      newCOM: { x: 0.5, y: 0.5 },
      workflow: "edit",
      useCOM: true,
      maxSize: { width: 2048, height: 2048 },
    });
    expect(plan.canvasSize).toEqual({ width: 2048, height: 1024 });
    expect(plan.prevDrawAt).toEqual({ x: -452, y: 0 });
    expect(plan.newDrawAt).toEqual({ x: 1548, y: 0 });
    expect(plan.coordinateShift).toEqual({ x: -452, y: 0 });
  });

  it("does not interfere when the cap is omitted", () => {
    const withoutCap = planComposite(
      baseInput({
        workflow: "inpainting",
        useCOM: true,
        newCOM: { x: 0.75, y: 0.25 },
      }),
    );
    const withCap = planComposite(
      baseInput({
        workflow: "inpainting",
        useCOM: true,
        newCOM: { x: 0.75, y: 0.25 },
        maxSize: { width: 2048, height: 2048 },
      }),
    );
    expect(withoutCap.newDrawAt).toEqual(withCap.newDrawAt);
    expect(withoutCap.canvasSize).toEqual(withCap.canvasSize);
  });
});

describe("planComposite — edit workflow honours the COM flag", () => {
  it("edit anchors on COM only when useCOM is set", () => {
    const com = { x: 1.0, y: 1.0 };
    const planFlagOff = planComposite(
      baseInput({ workflow: "edit", useCOM: false, newCOM: com }),
    );
    const planFlagOn = planComposite(
      baseInput({ workflow: "edit", useCOM: true, newCOM: com }),
    );
    // useCOM=false → geometric center → lands on prev patch, no drift.
    expect(planFlagOff.newDrawAt).toEqual({ x: 0, y: 0 });
    // useCOM=true → COM at (1024, 1024) → newDrawAt=(512, 512).
    expect(planFlagOn.newDrawAt).toEqual({ x: 512, y: 512 });
  });
});

describe("planComposite — newPosition feeds the next iteration", () => {
  it("returned newPosition equals where the new patch was drawn", () => {
    const plan = planComposite(
      baseInput({
        workflow: "inpainting",
        useCOM: true,
        newCOM: { x: 0.0, y: 1.0 },
      }),
    );
    expect(plan.newPosition).toEqual({
      x: plan.newDrawAt.x,
      y: plan.newDrawAt.y,
      width: 1024,
      height: 1024,
    });
  });

  it("chained iterations: feeding newPosition back gives a consistent walk", () => {
    // Three in-/outpainting steps drifting toward bottom-right.
    let prevSize = { width: 1024, height: 1024 };
    let prevPosition = { x: 0, y: 0, width: 1024, height: 1024 };
    const totalShift = { x: 0, y: 0 };

    for (let i = 0; i < 3; i++) {
      const plan = planComposite({
        prevSize,
        prevPosition,
        newSize: { width: 1024, height: 1024 },
        newCOM: { x: 0.75, y: 0.75 },
        workflow: "inpainting",
        useCOM: true,
      });
      totalShift.x += plan.coordinateShift.x;
      totalShift.y += plan.coordinateShift.y;
      prevSize = plan.canvasSize;
      prevPosition = plan.newPosition;
    }

    // Drifting to bottom-right: no leftward/upward shift expected.
    expect(totalShift).toEqual({ x: 0, y: 0 });
    // Canvas has grown but stays sane.
    expect(prevSize.width).toBeGreaterThan(1024);
    expect(prevSize.height).toBeGreaterThan(1024);
  });
});

describe("planComposite — patch placed inside existing canvas (no growth)", () => {
  it("non-COM standard onto small previous patch in larger canvas", () => {
    // Previous canvas is 2048×2048 with the last patch at (1024, 1024).
    // A new standard patch (no COM) lands centered on that prev patch.
    const plan = planComposite({
      prevSize: { width: 2048, height: 2048 },
      prevPosition: { x: 1024, y: 1024, width: 1024, height: 1024 },
      newSize: { width: 1024, height: 1024 },
      newCOM: { x: 0.5, y: 0.5 },
      workflow: "standard",
      useCOM: false,
    });
    // anchor = (1536, 1536), new top-left = (1024, 1024) — fully inside prev.
    expect(plan.canvasSize).toEqual({ width: 2048, height: 2048 });
    expect(plan.prevDrawAt).toEqual({ x: 0, y: 0 });
    expect(plan.newDrawAt).toEqual({ x: 1024, y: 1024 });
    expect(plan.coordinateShift).toEqual({ x: 0, y: 0 });
  });
});
