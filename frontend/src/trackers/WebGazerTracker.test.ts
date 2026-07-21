import { afterEach, describe, expect, it, vi } from "vitest";

import { WebGazerTracker } from "./WebGazerTracker";
import { MockSink } from "./_test-helpers";

type GazeListener = (data: { x: number; y: number } | null) => void;

const SIZE = { width: 1024, height: 1024 };

function installFakeWebGazer(): {
  emit: (x: number, y: number) => void;
} {
  let listener: GazeListener | null = null;
  window.webgazer = {
    begin: vi.fn(async () => undefined),
    pause: vi.fn(),
    end: vi.fn(),
    resume: vi.fn(),
    clearData: vi.fn(),
    showVideo: vi.fn(),
    showFaceOverlay: vi.fn(),
    showFaceFeedbackBox: vi.fn(),
    showPredictionPoints: vi.fn(),
    saveDataAcrossSessions: vi.fn(),
    setGazeListener: vi.fn((cb: GazeListener) => {
      listener = cb;
    }),
    recordScreenPosition: vi.fn(),
    params: {
      showVideoPreview: false,
      showFaceOverlay: false,
      showFaceFeedbackBox: false,
      faceMeshSolutionPath: "",
    },
  };
  return {
    emit: (x: number, y: number) => listener?.({ x, y }),
  };
}

function makeTracker(): {
  tracker: WebGazerTracker;
  sink: MockSink;
  el: HTMLElement;
} {
  const sink = new MockSink();
  const el = document.createElement("div");
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
  const tracker = new WebGazerTracker(
    { sink, getContainerSize: () => SIZE },
    () => el,
  );
  return { tracker, sink, el };
}

function setRect(
  el: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
): void {
  el.getBoundingClientRect = () =>
    ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON() {},
    }) as DOMRect;
}

afterEach(() => {
  delete window.webgazer;
  document.body.replaceChildren();
});

describe("WebGazerTracker", () => {
  it("routes gaze samples through the bounded event-history path", async () => {
    const wg = installFakeWebGazer();
    const { tracker, sink, el } = makeTracker();
    await tracker.init();
    await tracker.start();

    for (let i = 0; i < 3; i++) wg.emit(i, 100);

    expect(sink.history).toEqual([
      { x: 0, y: 100, value: 1 },
      { x: 1, y: 100, value: 1 },
      { x: 2, y: 100, value: 1 },
    ]);
    expect(sink.added).toEqual([]);
    expect(sink.lastSetData).toEqual([]);

    await tracker.dispose();
    el.remove();
  });

  it("does not expose trail length because WebGazer uses event history", () => {
    installFakeWebGazer();
    const { tracker, el } = makeTracker();

    expect("setTrailLength" in tracker).toBe(false);

    el.remove();
  });

  it("always records calibration clicks while cache controls persistence", async () => {
    installFakeWebGazer();
    const { tracker, el } = makeTracker();
    tracker.setCacheMode(true);
    await tracker.init();

    tracker.recordCalibrationClick(120, 240);

    expect(window.webgazer?.saveDataAcrossSessions).toHaveBeenLastCalledWith(
      true,
    );
    expect(window.webgazer?.recordScreenPosition).toHaveBeenCalledWith(
      120,
      240,
      "click",
    );

    el.remove();
  });

  it("retains cached calibration on dispose and clears only on request", async () => {
    installFakeWebGazer();
    const { tracker, el } = makeTracker();
    await tracker.init();
    await tracker.start();

    await tracker.dispose();
    expect(window.webgazer?.clearData).not.toHaveBeenCalled();

    tracker.clearCalibrationData();
    expect(window.webgazer?.clearData).toHaveBeenCalledTimes(1);

    el.remove();
  });

  it("clears the rendered heatmap without needing a tracker-owned trail", async () => {
    const wg = installFakeWebGazer();
    const { tracker, sink, el } = makeTracker();
    await tracker.init();
    await tracker.start();

    wg.emit(20, 100);
    tracker.clearHeatmap();

    expect(sink.history).toEqual([{ x: 20, y: 100, value: 1 }]);
    expect(sink.cleared).toBe(1);
    expect(window.webgazer?.showPredictionPoints).toHaveBeenLastCalledWith(
      false,
    );

    await tracker.dispose();
    el.remove();
  });

  it("keeps camera feedback visible when tracking is stopped", async () => {
    const wg = installFakeWebGazer();
    const { tracker, sink, el } = makeTracker();
    await tracker.init();
    await tracker.start();

    wg.emit(20, 100);
    await tracker.stop();
    wg.emit(30, 100);

    expect(sink.history).toEqual([{ x: 20, y: 100, value: 1 }]);
    expect(window.webgazer?.pause).not.toHaveBeenCalled();
    expect(window.webgazer?.showVideo).toHaveBeenLastCalledWith(true);
    expect(window.webgazer?.showFaceOverlay).toHaveBeenLastCalledWith(true);
    expect(window.webgazer?.showFaceFeedbackBox).toHaveBeenLastCalledWith(true);
    expect(window.webgazer?.showPredictionPoints).toHaveBeenLastCalledWith(
      true,
    );

    await tracker.dispose();
    el.remove();
  });

  it("tears down camera feedback on dispose", async () => {
    installFakeWebGazer();
    const { tracker, el } = makeTracker();
    await tracker.init();
    await tracker.start();

    await tracker.dispose();

    expect(window.webgazer?.pause).toHaveBeenCalledTimes(1);
    expect(window.webgazer?.showVideo).toHaveBeenLastCalledWith(false);
    expect(window.webgazer?.showFaceOverlay).toHaveBeenLastCalledWith(false);
    expect(window.webgazer?.showFaceFeedbackBox).toHaveBeenLastCalledWith(false);
    expect(window.webgazer?.end).toHaveBeenCalledTimes(1);

    el.remove();
  });

  it("places WebGazer's injected preview inside the heatmap frame", async () => {
    installFakeWebGazer();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1400,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 1200,
    });
    const ids = [
      "webgazerVideoContainer",
      "webgazerVideoFeed",
      "webgazerVideoCanvas",
      "webgazerFaceOverlay",
      "webgazerFaceFeedbackBox",
    ];
    for (const id of ids) {
      const el = document.createElement("div");
      el.id = id;
      if (id === "webgazerVideoContainer") {
        setRect(el, { left: 10, top: 20, width: 320, height: 240 });
      }
      if (id === "webgazerFaceFeedbackBox") {
        setRect(el, { left: 110, top: 90, width: 120, height: 100 });
      }
      document.body.appendChild(el);
    }
    const { tracker, el } = makeTracker();
    await tracker.init();
    await tracker.start();

    for (const id of ids.slice(0, 4)) {
      expect(document.getElementById(id)?.style.zIndex).toBe("30");
    }
    expect(document.getElementById("webgazerFaceFeedbackBox")?.style.zIndex)
      .toBe("32");
    for (const id of ids.slice(0, 4)) {
      const style = document.getElementById(id)?.style;
      expect(style?.position).toBe("fixed");
      expect(style?.left).toBe("776px");
      expect(style?.top).toBe("836px");
      expect(style?.width).toBe("240px");
      expect(style?.height).toBe("180px");
      expect(style?.borderRadius).toBe("8px");
      expect(style?.pointerEvents).toBe("none");
    }
    const feedbackStyle =
      document.getElementById("webgazerFaceFeedbackBox")?.style;
    expect(feedbackStyle?.position).toBe("fixed");
    expect(feedbackStyle?.left).toBe("851px");
    expect(feedbackStyle?.top).toBe("888.5px");
    expect(feedbackStyle?.width).toBe("90px");
    expect(feedbackStyle?.height).toBe("75px");
    expect(feedbackStyle?.borderRadius).toBe("");
    expect(feedbackStyle?.pointerEvents).toBe("none");

    await tracker.dispose();
    el.remove();
  });
});
