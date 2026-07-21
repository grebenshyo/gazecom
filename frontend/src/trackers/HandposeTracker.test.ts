import { afterEach, describe, expect, it, vi } from "vitest";

import { HandposeTracker } from "./HandposeTracker";
import { MockSink } from "./_test-helpers";

const SIZE = { width: 1024, height: 1024 };
const originalMediaDevices = navigator.mediaDevices;

function installFakeMediaPipe() {
  const trackStop = vi.fn();
  const stream = new MediaStream();
  Object.defineProperty(stream, "getTracks", {
    configurable: true,
    value: vi.fn(() => [{ stop: trackStop } as unknown as MediaStreamTrack]),
  });
  const hands = {
    setOptions: vi.fn(),
    onResults: vi.fn(),
    send: vi.fn(async () => undefined),
    close: vi.fn(),
  };
  const camera = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
  };
  let onFrame: (() => Promise<void>) | null = null;

  window.Hands = vi.fn(function FakeHands() {
    return hands;
  }) as unknown as typeof window.Hands;
  window.Camera = vi.fn(function FakeCamera(
    _video,
    opts: { onFrame: () => Promise<void> },
  ) {
    onFrame = opts.onFrame;
    return camera;
  }) as unknown as typeof window.Camera;

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => []),
      getUserMedia: vi.fn(async () => stream),
    },
  });

  return { camera, hands, onFrame: () => onFrame?.(), stream, trackStop };
}

function makeTracker(): {
  tracker: HandposeTracker;
  sink: MockSink;
  video: HTMLVideoElement;
  vizCanvas: HTMLCanvasElement;
} {
  const sink = new MockSink();
  const video = document.createElement("video");
  const vizCanvas = document.createElement("canvas");
  const tracker = new HandposeTracker(
    { sink, getContainerSize: () => SIZE },
    () => ({ video, vizCanvas }),
  );
  return { tracker, sink, video, vizCanvas };
}

afterEach(() => {
  delete window.Hands;
  delete window.Camera;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: originalMediaDevices,
  });
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("HandposeTracker", () => {
  it("keeps webcam feedback live when tracking is stopped", async () => {
    const { camera, hands, onFrame, stream, trackStop } = installFakeMediaPipe();
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const { tracker, video } = makeTracker();
    await tracker.init();
    await tracker.start();

    await tracker.stop();
    await onFrame();

    expect(video.srcObject).toBe(stream);
    expect(camera.stop).not.toHaveBeenCalled();
    expect(hands.send).not.toHaveBeenCalled();
    expect(trackStop).not.toHaveBeenCalled();

    await tracker.dispose();

    expect(camera.stop).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("reuses the live webcam and camera when tracking restarts", async () => {
    const { camera } = installFakeMediaPipe();
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const { tracker } = makeTracker();
    await tracker.init();
    await tracker.start();
    await tracker.stop();
    await tracker.start();

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(window.Camera).toHaveBeenCalledTimes(1);
    expect(camera.start).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(2);

    await tracker.dispose();
  });
});
