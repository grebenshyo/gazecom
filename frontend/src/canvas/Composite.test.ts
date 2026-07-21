import { describe, expect, it } from "vitest";
import { planComposite, type PatchBox, type PlanInput } from "./Composite";

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

describe("planComposite — bounds clipping", () => {
  // Symmetric 2048×2048 cap centered on a first patch at (0,0). Box spans
  // x: -512..1536, y: -512..1536 in the previous-canvas coord frame.
  const sym2048: PatchBox = {
    x: -512,
    y: -512,
    width: 2048,
    height: 2048,
  };

  it("does nothing when the natural placement already fits", () => {
    const plan = planComposite(
      baseInput({
        workflow: "inpainting",
        useCOM: true,
        newCOM: { x: 0.6, y: 0.6 },
        bounds: sym2048,
      }),
    );
    // Anchor=(614, 614), newRaw=(102, 102) — well inside the cap.
    expect(plan.newDrawAt).toEqual({ x: 102, y: 102 });
    expect(plan.coordinateShift).toEqual({ x: 0, y: 0 });
  });

  it("keeps natural placement when COM reaches the bound", () => {
    const plan = planComposite(
      baseInput({
        workflow: "inpainting",
        useCOM: true,
        newCOM: { x: 1.0, y: 1.0 },
        bounds: sym2048,
      }),
    );
    // Without bounds: anchor=(1024,1024) → newRaw=(512,512), patch ends at
    // (1536,1536) which is on the bound's edge.
    expect(plan.newDrawAt).toEqual({ x: 512, y: 512 });
    expect(plan.coordinateShift).toEqual({ x: 0, y: 0 });
  });

  it("clips left/up growth at the bound without sliding the patch", () => {
    const plan = planComposite(
      baseInput({
        workflow: "inpainting",
        useCOM: true,
        newCOM: { x: 0.0, y: 0.0 },
        bounds: sym2048,
      }),
    );
    // Without bounds: anchor=(0,0) → newRaw=(-512,-512). Bound's left edge
    // is exactly -512, so clipping preserves the natural placement.
    expect(plan.newDrawAt).toEqual({ x: 0, y: 0 });
    expect(plan.coordinateShift).toEqual({ x: 512, y: 512 });
    expect(plan.canvasSize).toEqual({ width: 1536, height: 1536 });
  });

  it("clips a runaway COM at the boundary without moving the patch", () => {
    // Exaggerate the previous patch position to force a far placement.
    const plan = planComposite({
      prevSize: { width: 2048, height: 2048 },
      prevPosition: { x: 1024, y: 1024, width: 1024, height: 1024 },
      newSize: { width: 1024, height: 1024 },
      newCOM: { x: 1.0, y: 1.0 },
      workflow: "inpainting",
      useCOM: true,
      bounds: { x: -512, y: -512, width: 2048, height: 2048 },
    });
    // Natural placement: anchor=(2048,2048) → newRaw=(1536,1536), patch
    // would reach (2560,2560) — well past the cap's right edge at 1536.
    // Clipping keeps that natural top-left rather than sliding it back.
    expect(plan.newDrawAt).toEqual({ x: 1536, y: 1536 });
    expect(plan.canvasSize).toEqual({ width: 1536, height: 1536 });
    expect(plan.coordinateShift).toEqual({ x: 0, y: 0 });
  });

  it("supports negative coordinate shifts when bounds crop left/top", () => {
    const plan = planComposite({
      prevSize: { width: 2048, height: 1024 },
      prevPosition: { x: 1024, y: 0, width: 1024, height: 1024 },
      newSize: { width: 1024, height: 1024 },
      newCOM: { x: 0.0, y: 0.5 },
      workflow: "inpainting",
      useCOM: true,
      bounds: { x: 512, y: 0, width: 2048, height: 1024 },
    });
    // The bounded canvas starts at previous x=512, so both old content and
    // the naturally-placed new patch are drawn left by 512px.
    expect(plan.canvasSize).toEqual({ width: 1536, height: 1024 });
    expect(plan.prevDrawAt).toEqual({ x: -512, y: 0 });
    expect(plan.newDrawAt).toEqual({ x: 0, y: 0 });
    expect(plan.coordinateShift).toEqual({ x: -512, y: 0 });
  });

  it("does not interfere with non-bounds runs", () => {
    // Same input, bounds omitted — should match a baseline in-/outpainting plan.
    const withoutBounds = planComposite(
      baseInput({
        workflow: "inpainting",
        useCOM: true,
        newCOM: { x: 0.75, y: 0.25 },
      }),
    );
    const withBounds = planComposite(
      baseInput({
        workflow: "inpainting",
        useCOM: true,
        newCOM: { x: 0.75, y: 0.25 },
        bounds: sym2048,
      }),
    );
    // The natural placement fits, so the two plans must be identical.
    expect(withoutBounds.newDrawAt).toEqual(withBounds.newDrawAt);
    expect(withoutBounds.canvasSize).toEqual(withBounds.canvasSize);
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
