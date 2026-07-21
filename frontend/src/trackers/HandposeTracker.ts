/**
 * MediaPipe Hands tracker — fingertip positions from the webcam.
 *
 * Ported from legacy js/trackers/handpose.js (261 lines). Same model
 * parameters: maxNumHands=1, modelComplexity=1, conf=0.5/0.5.
 *
 * Architectural changes vs. legacy:
 * - Camera enumeration / fallback loop preserved.
 * - The legacy code created its own video element fixed at top:0 left:0;
 *   here the React layer (Phase 4) hosts the <video> element and we
 *   receive a reference. Keeps DOM ownership in the React tree.
 */

import { loadScript } from "./_loadScript";
import { TrailBuffer, DEFAULT_POINT_VALUE } from "./_trail";
import type {
  HeatmapPoint,
  Tracker,
  TrackerCapabilities,
  TrackerContext,
} from "./Tracker";

const HANDS_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/hands.js";
const CAMERA_UTILS_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1640029074/camera_utils.js";

const FINGERTIP_LANDMARKS = [4, 8, 12, 16, 20] as const; // thumb..pinky tips

interface MediaPipeHands {
  setOptions(opts: {
    maxNumHands: number;
    modelComplexity: number;
    minDetectionConfidence: number;
    minTrackingConfidence: number;
  }): void;
  onResults(cb: (results: MediaPipeResults) => void): void;
  send(packet: { image: HTMLVideoElement | HTMLCanvasElement }): Promise<void>;
  close(): void;
}

interface MediaPipeResults {
  multiHandLandmarks?: ReadonlyArray<ReadonlyArray<{ x: number; y: number; z: number }>>;
}

interface MediaPipeCamera {
  start(): Promise<void>;
  stop(): void;
}

declare global {
  interface Window {
    Hands?: new (opts: {
      locateFile: (file: string) => string;
    }) => MediaPipeHands;
    Camera?: new (
      video: HTMLVideoElement,
      opts: {
        onFrame: () => Promise<void>;
        width: number;
        height: number;
      },
    ) => MediaPipeCamera;
  }
}

export interface HandposeViewRefs {
  /** Hidden video element fed by getUserMedia. */
  video: HTMLVideoElement;
  /** Optional overlay canvas for landmark visualization. */
  vizCanvas: HTMLCanvasElement | null;
}

export class HandposeTracker implements Tracker {
  readonly id = "handpose" as const;
  readonly capabilities: TrackerCapabilities = {
    needsCalibration: false,
    needsCamera: true,
    label: "Handpose",
  };

  private hands: MediaPipeHands | null = null;
  private camera: MediaPipeCamera | null = null;
  private stream: MediaStream | null = null;
  // Match legacy handpose.js:224 — 200 trail points, not 500.
  private trail = new TrailBuffer(200);
  private active = false;

  constructor(
    private readonly ctx: TrackerContext,
    private readonly resolveRefs: () => HandposeViewRefs | null,
  ) {}

  async init(): Promise<void> {
    if (!window.Hands) {
      await loadScript(HANDS_CDN);
    }
    if (!window.Camera) {
      await loadScript(CAMERA_UTILS_CDN);
    }
  }

  async start(): Promise<void> {
    const refs = this.resolveRefs();
    if (!refs) {
      throw new Error("HandposeTracker: video refs not available");
    }
    if (!window.Hands || !window.Camera) {
      throw new Error("HandposeTracker: MediaPipe not loaded");
    }

    if (!this.hands) {
      this.hands = new window.Hands({
        locateFile: (file) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/${file}`,
      });
      this.hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      this.hands.onResults((r) => this.onResults(r));
    }

    if (!this.stream) {
      this.stream = await this.acquireWebcam();
    }
    refs.video.srcObject = this.stream;
    await refs.video.play();

    this.trail.clear();
    this.active = true;

    if (!this.camera) {
      this.camera = new window.Camera(refs.video, {
        onFrame: async () => {
          if (this.hands && this.active) {
            await this.hands.send({ image: refs.video });
          }
        },
        width: 640,
        height: 480,
      });
      await this.camera.start();
    }
  }

  async stop(): Promise<void> {
    // Match WebGazer semantics: Stop tracking pauses heatmap updates, but
    // leaves the webcam feedback live until dispose() on mode change/unload.
    this.active = false;
    this.clearVizCanvas(this.resolveRefs()?.vizCanvas ?? null);
  }

  async dispose(): Promise<void> {
    await this.stop();
    if (this.camera) {
      this.camera.stop();
      this.camera = null;
    }
    if (this.hands) {
      this.hands.close();
      this.hands = null;
    }
    const refs = this.resolveRefs();
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      if (refs?.video.srcObject === this.stream) refs.video.srcObject = null;
      this.stream = null;
    }
    this.trail.clear();
  }

  /** Live trail window length (see Tracker.setTrailLength). */
  setTrailLength(length: number): void {
    this.trail.setCapacity(length);
  }

  clearHeatmap(): void {
    this.trail.clear();
    this.ctx.sink.clear();
    this.clearVizCanvas(this.resolveRefs()?.vizCanvas ?? null);
  }

  private async acquireWebcam(): Promise<MediaStream> {
    // Same fallback strategy as legacy handpose.js:50-100: try each device
    // until one yields a stream.
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput");
    let lastError: unknown = null;
    for (const cam of cams) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: cam.deviceId },
            width: { ideal: 640 },
            height: { ideal: 480 },
          },
        });
      } catch (e) {
        lastError = e;
      }
    }
    // Final fallback — let the browser pick.
    try {
      return await navigator.mediaDevices.getUserMedia({ video: true });
    } catch (e) {
      throw new Error(
        `No webcam available: ${(e as Error).message ?? lastError}`,
      );
    }
  }

  private onResults(results: MediaPipeResults): void {
    if (!this.active) return;
    const refs = this.resolveRefs();
    const hands = results.multiHandLandmarks;
    if (!hands || hands.length === 0) {
      // No hand → clear the viz canvas to avoid stale dots.
      this.clearVizCanvas(refs?.vizCanvas ?? null);
      return;
    }

    const size = this.ctx.getContainerSize();
    const hand = hands[0];
    for (const idx of FINGERTIP_LANDMARKS) {
      const lm = hand[idx];
      if (!lm) continue;
      // MediaPipe normalizes landmarks to [0, 1]. Mirror x because the video
      // shows a selfie view.
      const x = (1 - lm.x) * size.width;
      const y = lm.y * size.height;
      const point: HeatmapPoint = {
        x: Math.round(x),
        y: Math.round(y),
        value: DEFAULT_POINT_VALUE,
      };
      this.trail.push(point);
    }
    this.ctx.sink.setData(this.trail.snapshot());

    // Draw landmarks on the viz canvas if one is available (legacy
    // handpose.js:240-251 drawHandMediaPipe). Red dots for fingertips,
    // aqua for the rest, drawn over the mirrored video feed.
    this.drawLandmarks(refs?.vizCanvas ?? null, hand);
  }

  private clearVizCanvas(canvas: HTMLCanvasElement | null): void {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  }

  private drawLandmarks(
    canvas: HTMLCanvasElement | null,
    landmarks: ReadonlyArray<{ x: number; y: number; z: number }>,
  ): void {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const fingertipSet = new Set<number>(FINGERTIP_LANDMARKS);
    for (let i = 0; i < landmarks.length; i++) {
      const lm = landmarks[i];
      // Mirror X to match the video's CSS transform: scaleX(-1).
      const x = (1 - lm.x) * canvas.width;
      const y = lm.y * canvas.height;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = fingertipSet.has(i) ? "red" : "aqua";
      ctx.fill();
    }
  }
}
