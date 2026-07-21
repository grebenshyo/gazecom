import { describe, expect, it } from "vitest";
import { CursorTracker } from "./CursorTracker";
import { MockSink } from "./_test-helpers";

const SIZE = { width: 1024, height: 1024 };

function makeTracker(): {
  tracker: CursorTracker;
  sink: MockSink;
  el: HTMLElement;
} {
  const sink = new MockSink();
  const el = document.createElement("div");
  // Pretend the container is 1024x1024 at viewport origin.
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: SIZE.width,
      bottom: SIZE.height,
      width: SIZE.width,
      height: SIZE.height,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
  document.body.appendChild(el);
  const tracker = new CursorTracker(
    { sink, getContainerSize: () => SIZE },
    () => el,
  );
  return { tracker, sink, el };
}

describe("CursorTracker", () => {
  it("declares correct capabilities", () => {
    const { tracker, el } = makeTracker();
    expect(tracker.id).toBe("cursor");
    expect(tracker.capabilities.label).toBe("Cursor");
    el.remove();
  });

  it("doesn't emit before any mouse move", async () => {
    const { tracker, sink, el } = makeTracker();
    await tracker.start();
    await tracker.stop();
    tracker.step();
    expect(sink.lastSetData.length).toBe(0);
    await tracker.dispose();
    el.remove();
  });

  it("emits points after the mouse position is set", async () => {
    const { tracker, sink, el } = makeTracker();
    await tracker.start();
    await tracker.stop();

    tracker.setMousePosition(512, 512);
    tracker.step();
    tracker.step();
    expect(sink.lastSetData.length).toBe(2);
    expect(sink.lastSetData[0]).toEqual({ x: 512, y: 512, value: 20 });

    await tracker.dispose();
    el.remove();
  });

  it("trail caps at 100 points", async () => {
    const { tracker, sink, el } = makeTracker();
    await tracker.start();
    await tracker.stop();
    tracker.setMousePosition(100, 100);
    for (let i = 0; i < 250; i++) tracker.step();
    expect(sink.lastSetData.length).toBe(100);
    await tracker.dispose();
    el.remove();
  });

  it("dispatching mousemove on the container updates position via listener", async () => {
    const { tracker, sink, el } = makeTracker();
    await tracker.start();
    // Synthetic mousemove
    el.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 256, clientY: 384 }),
    );
    tracker.step();
    expect(sink.lastSetData[0]).toEqual({ x: 256, y: 384, value: 20 });
    await tracker.dispose();
    el.remove();
  });
});
