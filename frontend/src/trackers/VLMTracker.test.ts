import { describe, expect, it } from "vitest";

import { MockSink } from "./_test-helpers";
import { VLMTracker } from "./VLMTracker";

const SIZE = { width: 800, height: 600 };

function makeTracker(point: { x: number; y: number } | null = null) {
  const sink = new MockSink();
  let currentPoint = point;
  const tracker = new VLMTracker({
    sink,
    getContainerSize: () => SIZE,
    getVlmPoint: () => currentPoint,
  });
  return {
    tracker,
    sink,
    setPoint: (next: { x: number; y: number } | null) => {
      currentPoint = next;
    },
  };
}

describe("VLMTracker", () => {
  it("declares the expected capabilities", () => {
    const { tracker } = makeTracker();
    expect(tracker.id).toBe("vlm");
    expect(tracker.capabilities).toEqual({
      needsCalibration: false,
      needsCamera: false,
      label: "VLM",
    });
  });

  it("emits the center before the first VLM response", async () => {
    const { tracker, sink } = makeTracker();
    await tracker.start();
    await tracker.stop();
    expect(sink.lastSetData).toEqual([{ x: 400, y: 300, value: 1 }]);
  });

  it("maps a normalized VLM point into heatmap pixels", async () => {
    const { tracker, sink } = makeTracker({ x: 0.25, y: 0.75 });
    await tracker.start();
    await tracker.stop();
    expect(sink.lastSetData).toEqual([{ x: 200, y: 450, value: 1 }]);
  });

  it("re-emits the latest point after a heatmap clear", async () => {
    const { tracker, sink, setPoint } = makeTracker({ x: 0.25, y: 0.75 });
    await tracker.start();
    await tracker.stop();
    tracker.clearHeatmap();
    setPoint({ x: 0.9, y: 0.1 });
    await tracker.start();
    await tracker.stop();
    expect(sink.cleared).toBe(1);
    expect(sink.lastSetData).toEqual([{ x: 720, y: 60, value: 1 }]);
  });
});
