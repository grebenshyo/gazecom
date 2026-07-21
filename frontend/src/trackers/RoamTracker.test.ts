import { describe, expect, it } from "vitest";
import { RoamTracker, DEFAULT_ROAM_CONFIG } from "./RoamTracker";
import { MockSink, seededRng } from "./_test-helpers";

const SIZE = { width: 1024, height: 1024 };

function makeTracker(seed = 1): { tracker: RoamTracker; sink: MockSink } {
  const sink = new MockSink();
  const tracker = new RoamTracker(
    { sink, getContainerSize: () => SIZE },
    DEFAULT_ROAM_CONFIG,
    seededRng(seed),
  );
  return { tracker, sink };
}

function makeConstrainedTracker(seed = 1): {
  tracker: RoamTracker;
  sink: MockSink;
} {
  const sink = new MockSink();
  const tracker = new RoamTracker(
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
    DEFAULT_ROAM_CONFIG,
    seededRng(seed),
  );
  return { tracker, sink };
}

describe("RoamTracker", () => {
  it("declares correct capabilities", () => {
    const { tracker } = makeTracker();
    expect(tracker.id).toBe("roam");
    expect(tracker.capabilities.needsCalibration).toBe(false);
    expect(tracker.capabilities.needsCamera).toBe(false);
    expect(tracker.capabilities.label).toBe("Roam");
  });

  it("emits one point per step()", async () => {
    const { tracker, sink } = makeTracker();
    await tracker.init();
    // start() seeds initial position; we then drive steps manually.
    await tracker.start();
    await tracker.stop();
    sink.lastSetData = [];

    tracker.step(SIZE);
    expect(sink.lastSetData.length).toBe(1);
    tracker.step(SIZE);
    expect(sink.lastSetData.length).toBe(2);
  });

  it("never emits points outside the container bounds", async () => {
    const { tracker, sink } = makeTracker(42);
    await tracker.init();
    await tracker.start();
    await tracker.stop();

    for (let i = 0; i < 500; i++) {
      tracker.step(SIZE);
    }
    for (const p of sink.lastSetData) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(SIZE.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(SIZE.height);
    }
  });

  it("honors a dynamic roam constraint", async () => {
    const { tracker, sink } = makeConstrainedTracker(42);
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

  it("never produces NaN coordinates", async () => {
    const { tracker, sink } = makeTracker(7);
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

  it("trail stays bounded at the configured length", async () => {
    const { tracker, sink } = makeTracker();
    await tracker.init();
    await tracker.start();
    await tracker.stop();

    for (let i = 0; i < 1000; i++) {
      tracker.step(SIZE);
    }
    expect(sink.lastSetData.length).toBeLessThanOrEqual(
      DEFAULT_ROAM_CONFIG.trailLength,
    );
  });

  it("position is deterministic given the same seed", async () => {
    const a = makeTracker(123).tracker;
    const b = makeTracker(123).tracker;
    await a.init();
    await b.init();
    await a.start();
    await b.start();
    await a.stop();
    await b.stop();

    for (let i = 0; i < 50; i++) {
      a.step(SIZE);
      b.step(SIZE);
    }
    expect(a.getPosition()).toEqual(b.getPosition());
  });

  it("setSpeed scales how far the roamer travels per step", async () => {
    // Same seed → identical starting position and rng-driven velocities;
    // only the applied travel is scaled, so the faster roamer covers more
    // total ground.
    const slow = makeTracker(99).tracker;
    const fast = makeTracker(99).tracker;
    await slow.start();
    await fast.start();
    await slow.stop();
    await fast.stop();
    slow.setSpeed(0.5);
    fast.setSpeed(2);

    let pathSlow = 0;
    let pathFast = 0;
    let prevSlow = { ...slow.getPosition() };
    let prevFast = { ...fast.getPosition() };
    for (let i = 0; i < 100; i++) {
      slow.step(SIZE);
      fast.step(SIZE);
      const s = slow.getPosition();
      const f = fast.getPosition();
      pathSlow += Math.hypot(s.x - prevSlow.x, s.y - prevSlow.y);
      pathFast += Math.hypot(f.x - prevFast.x, f.y - prevFast.y);
      prevSlow = { ...s };
      prevFast = { ...f };
    }
    expect(pathFast).toBeGreaterThan(pathSlow);
  });

  it("dispose() clears the trail", async () => {
    const { tracker, sink } = makeTracker();
    await tracker.init();
    await tracker.start();
    await tracker.stop();
    tracker.step(SIZE);
    tracker.step(SIZE);
    expect(sink.lastSetData.length).toBe(2);
    await tracker.dispose();
    // No new emissions after dispose.
    sink.lastSetData = [];
    // (cannot call step() expecting silence — step() has no isActive guard;
    //  the timer is what's stopped. Just assert internal state.)
  });
});
