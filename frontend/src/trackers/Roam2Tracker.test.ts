import { describe, expect, it } from "vitest";
import { Roam2Tracker } from "./Roam2Tracker";
import { MockSink, seededRng } from "./_test-helpers";

const SIZE = { width: 1024, height: 1024 };

function makeTracker(seed = 1): { tracker: Roam2Tracker; sink: MockSink } {
  const sink = new MockSink();
  const tracker = new Roam2Tracker(
    { sink, getContainerSize: () => SIZE },
    seededRng(seed),
  );
  return { tracker, sink };
}

function makeConstrainedTracker(seed = 1): {
  tracker: Roam2Tracker;
  sink: MockSink;
} {
  const sink = new MockSink();
  const tracker = new Roam2Tracker(
    {
      sink,
      getContainerSize: () => SIZE,
      getRoamConstraint: () => ({
        minX: 128,
        maxX: 256,
        minY: 384,
        maxY: 512,
      }),
    },
    seededRng(seed),
  );
  return { tracker, sink };
}

describe("Roam2Tracker", () => {
  it("declares correct capabilities", () => {
    const { tracker } = makeTracker();
    expect(tracker.id).toBe("roam2");
    expect(tracker.capabilities.label).toBe("Adaptive Roam");
  });

  it("starts with one of the three behaviors", async () => {
    const { tracker } = makeTracker();
    await tracker.init();
    await tracker.start();
    await tracker.stop();
    expect(["explore", "focus", "scan"]).toContain(tracker.getBehavior());
  });

  it("eventually switches behaviors over time", async () => {
    const { tracker } = makeTracker(99);
    await tracker.init();
    await tracker.start();
    await tracker.stop();

    const seen = new Set<string>();
    for (let i = 0; i < 1500; i++) {
      tracker.step(SIZE);
      seen.add(tracker.getBehavior());
    }
    // With enough ticks, at least 2 distinct behaviors should have appeared.
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it("keeps points inside [20, size-20] bounds", async () => {
    const { tracker, sink } = makeTracker(7);
    await tracker.init();
    await tracker.start();
    await tracker.stop();

    for (let i = 0; i < 500; i++) {
      tracker.step(SIZE);
    }
    for (const p of sink.lastSetData) {
      expect(p.x).toBeGreaterThanOrEqual(20);
      expect(p.x).toBeLessThanOrEqual(SIZE.width - 20);
      expect(p.y).toBeGreaterThanOrEqual(20);
      expect(p.y).toBeLessThanOrEqual(SIZE.height - 20);
    }
  });

  it("honors a dynamic roam constraint", async () => {
    const { tracker, sink } = makeConstrainedTracker(7);
    await tracker.init();
    await tracker.start();
    await tracker.stop();

    for (let i = 0; i < 500; i++) {
      tracker.step(SIZE);
    }
    for (const p of sink.lastSetData) {
      expect(p.x).toBeGreaterThanOrEqual(128);
      expect(p.x).toBeLessThanOrEqual(256);
      expect(p.y).toBeGreaterThanOrEqual(384);
      expect(p.y).toBeLessThanOrEqual(512);
    }
  });

  it("never produces NaN", async () => {
    const { tracker, sink } = makeTracker(11);
    await tracker.init();
    await tracker.start();
    await tracker.stop();

    for (let i = 0; i < 500; i++) {
      tracker.step(SIZE);
    }
    for (const p of sink.lastSetData) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});
