/**
 * MSI-Net saliency tracker — predicts where humans naturally look in the
 * webcam feed and uses that as the heatmap point source.
 *
 * Ported from legacy js/trackers/saliency.js — restoring the model URL,
 * preprocessing, output processing, and multi-point sampling that an
 * earlier rewrite of this file got wrong.
 */

import { loadScript } from "./_loadScript";
import { TrailBuffer, DEFAULT_POINT_VALUE } from "./_trail";
import type {
  Tracker,
  TrackerCapabilities,
  TrackerContext,
} from "./Tracker";

const TFJS_CDN = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0";
// Public-hosted MSI-Net model the legacy app uses — same URL, no proxy.
const MSI_MODEL_URL =
  "https://storage.googleapis.com/msi-net/model/medium/model.json";

const MODEL_HEIGHT = 120;
const MODEL_WIDTH = 160;

// Saliency-to-points sampling (legacy saliency.js:246-279).
const PEAK_THRESHOLD = 0.75;
const MAX_POINTS_PER_FRAME = 12;
const SAMPLE_STRIDE = 8;
const TRAIL_LENGTH = 1000;

interface TfjsTensor {
  shape: number[];
  dispose(): void;
  arraySync(): number[][];
  dataSync(): Float32Array | Int32Array | Uint8Array;
}

interface TfjsModel {
  predict(input: TfjsTensor): TfjsTensor;
  dispose(): void;
}

interface Tfjs {
  loadGraphModel(url: string): Promise<TfjsModel>;
  zeros(shape: number[]): TfjsTensor;
  browser: {
    fromPixels(el: HTMLVideoElement | HTMLCanvasElement): TfjsTensor;
  };
  tidy<T>(fn: () => T): T;
  image: {
    resizeBilinear(t: TfjsTensor, size: [number, number], alignCorners?: boolean): TfjsTensor;
  };
  reverse(t: TfjsTensor, axis: number): TfjsTensor;
  clipByValue(t: TfjsTensor, lo: number, hi: number): TfjsTensor;
  expandDims(t: TfjsTensor, axis?: number): TfjsTensor;
  squeeze(t: TfjsTensor): TfjsTensor;
  version?: { tfjs: string };
}

declare global {
  interface Window {
    tf?: Tfjs;
  }
}

export interface SaliencyViewRefs {
  video: HTMLVideoElement;
  /** Optional overlay canvas for saliency-peak visualization. */
  vizCanvas: HTMLCanvasElement | null;
}

export class SaliencyTracker implements Tracker {
  readonly id = "msi" as const;
  readonly capabilities: TrackerCapabilities = {
    needsCalibration: false,
    needsCamera: true,
    label: "MSI",
  };

  private model: TfjsModel | null = null;
  private stream: MediaStream | null = null;
  private animationId: number | null = null;
  private trail = new TrailBuffer(TRAIL_LENGTH);
  private active = false;

  constructor(
    private readonly ctx: TrackerContext,
    private readonly resolveRefs: () => SaliencyViewRefs | null,
  ) {}

  async init(): Promise<void> {
    if (!window.tf?.browser?.fromPixels) {
      await loadScript(TFJS_CDN);
    }
    if (!this.model) {
      const tf = this.requireTf();
      this.model = await tf.loadGraphModel(MSI_MODEL_URL);
      // Warmup pass so the first user-facing prediction isn't slow.
      tf.tidy(() => {
        const dummy = tf.zeros([1, MODEL_HEIGHT, MODEL_WIDTH, 3]);
        this.model!.predict(dummy).dispose();
      });
    }
  }

  async start(): Promise<void> {
    const refs = this.resolveRefs();
    if (!refs) {
      throw new Error("SaliencyTracker: video refs not available");
    }
    if (!this.model) {
      throw new Error("SaliencyTracker: model not loaded — call init()");
    }

    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: "user",
        },
      });
      refs.video.srcObject = this.stream;
      await refs.video.play();
    }

    this.active = true;
    this.trail.clear();
    this.tick(refs.video);
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    // Keep the model + stream alive so resume is fast (legacy line 73-76).
  }

  async dispose(): Promise<void> {
    await this.stop();
    if (this.model) {
      this.model.dispose();
      this.model = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
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

  private tick(video: HTMLVideoElement): void {
    if (!this.active || !this.model) return;
    if (video.readyState < 4) {
      this.animationId = requestAnimationFrame(() => this.tick(video));
      return;
    }

    const tf = this.requireTf();
    const size = this.ctx.getContainerSize();

    try {
      const points: { x: number; y: number; value: number }[] = [];

      // Preprocessing matches the legacy demo (saliency.js:186-205):
      // float-cast, expand to batch, resize to model dims, clip 0-255,
      // reverse axis 2 (BGR↔RGB).
      const saliencyMap = tf.tidy(() => {
        const frame = tf.browser.fromPixels(video);
        const batched = tf.expandDims(frame);
        const resized = tf.image.resizeBilinear(batched, [
          MODEL_HEIGHT,
          MODEL_WIDTH,
        ], true);
        const clipped = tf.clipByValue(resized, 0, 255);
        const reversed = tf.reverse(clipped, 2);
        const out = this.model!.predict(reversed);
        return tf.squeeze(out);
      });

      const data = saliencyMap.dataSync() as Float32Array;
      const [height, width] = saliencyMap.shape;
      saliencyMap.dispose();

      // Sample-and-threshold: at SAMPLE_STRIDE pixel pitch, collect points
      // with saliency > PEAK_THRESHOLD, sort by strength, take the top
      // MAX_POINTS_PER_FRAME (legacy saliency.js:246-279).
      const candidates: { x: number; y: number; value: number }[] = [];
      for (let y = 0; y < height; y += SAMPLE_STRIDE) {
        for (let x = 0; x < width; x += SAMPLE_STRIDE) {
          const v = data[y * width + x];
          if (v > PEAK_THRESHOLD) {
            // Mirror X for selfie view, normalize to container dims.
            const px = (1 - x / width) * size.width;
            const py = (y / height) * size.height;
            candidates.push({ x: px, y: py, value: v });
          }
        }
      }
      candidates.sort((a, b) => b.value - a.value);
      for (const p of candidates.slice(0, MAX_POINTS_PER_FRAME)) {
        points.push(p);
      }

      // Push all points from this frame into the trail (legacy
      // saliency.js:281-306 addToHeatmap), then update the heatmap.
      for (const p of points) {
        this.trail.push({
          x: Math.round(p.x),
          y: Math.round(p.y),
          value: DEFAULT_POINT_VALUE,
        });
      }
      this.ctx.sink.setData(this.trail.snapshot());

      // Visualization (legacy saliency.js:308-329): draw red circles
      // sized by saliency strength on the overlay canvas. Container
      // coords → canvas coords (canvas is mirrored via CSS so we mirror
      // X back to match the un-mirrored video pixels).
      const refs = this.resolveRefs();
      this.drawCircles(refs?.vizCanvas ?? null, points, size);
    } catch (err) {
      console.error("SaliencyTracker: analysis error:", err);
    }

    this.animationId = requestAnimationFrame(() => this.tick(video));
  }

  private drawCircles(
    canvas: HTMLCanvasElement | null,
    points: { x: number; y: number; value: number }[],
    containerSize: { width: number; height: number },
  ): void {
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of points) {
      // p.x/y are in container space (already mirrored). Scale to canvas
      // space, then re-mirror because the canvas itself is CSS-mirrored.
      const cx =
        canvas.width - (p.x / containerSize.width) * canvas.width;
      const cy = (p.y / containerSize.height) * canvas.height;
      const radius = 8 * p.value;
      ctx2d.fillStyle = `rgba(255, 0, 0, ${p.value * 0.8})`;
      ctx2d.beginPath();
      ctx2d.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx2d.fill();
    }
  }

  private clearVizCanvas(canvas: HTMLCanvasElement | null): void {
    const ctx2d = canvas?.getContext("2d");
    if (!canvas || !ctx2d) return;
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  }

  private requireTf(): Tfjs {
    if (!window.tf) {
      throw new Error("TensorFlow.js not loaded — call init() first");
    }
    return window.tf;
  }
}
