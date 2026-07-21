/**
 * Heatmap container — the right pane in the legacy layout.
 *
 * Displays the active base image as a CSS background, hosts the h337
 * heatmap overlay, and houses the hidden <video> element used by camera
 * trackers.
 *
 * The HeatmapInstance and active Tracker are owned here via the useHeatmap
 * and useTracker hooks. Phase 5 reads `heatmapInstanceRef` to capture data
 * for generation.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import type { HeatmapInstance } from "../canvas/HeatmapInstance";
import { useStore } from "../store";
import type { Tracker } from "../trackers";
import { useHeatmap } from "./hooks/useHeatmap";
import { useTracker } from "./hooks/useTracker";
import "./HeatmapView.css";

export interface HeatmapViewHandle {
  containerEl: HTMLElement | null;
  heatmapInstance: HeatmapInstance | null;
  tracker: Tracker | null;
}

export const HeatmapView = forwardRef<HeatmapViewHandle>(function HeatmapView(
  _,
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const vizCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const baseImageURL = useStore((s) => s.baseImageURL);
  const trackingMode = useStore((s) => s.trackingMode);
  const frameZoom = useStore((s) => s.frameZoom);

  const { instanceRef } = useHeatmap(overlayRef);

  // Frame zoom resizes the heatmap frame via CSS; rebuild h337 to the new
  // size so the tracker's points land correctly. Done here (not left to
  // HeatmapInstance's ResizeObserver) so it's deterministic and prompt.
  useEffect(() => {
    instanceRef.current?.resize();
  }, [frameZoom, instanceRef]);
  const { trackerRef } = useTracker({
    containerRef,
    videoRef,
    vizCanvasRef,
    heatmapInstanceRef: instanceRef,
  });

  // Use getter properties so the handle resolves the *current* ref value
  // every time the consumer reads, instead of capturing a snapshot at
  // creation time. useImperativeHandle's create callback fires synchronously
  // after commit, BEFORE useHeatmap's useEffect runs and populates
  // instanceRef.current — without getters, the handle would store null
  // forever and the Generate button would silently no-op.
  useImperativeHandle(
    ref,
    () => ({
      get containerEl() {
        return containerRef.current;
      },
      get heatmapInstance() {
        return instanceRef.current;
      },
      get tracker() {
        return trackerRef.current;
      },
    }),
    [instanceRef, trackerRef],
  );

  // Only the MediaPipe-based trackers (Handpose, MSI) draw into the app's
  // own <video>. WebGazer injects and positions its *own* preview element
  // (params.showVideoPreview), so showing the app <video> for it just adds a
  // black box while WebGazer's real feed sits elsewhere — matching legacy,
  // which had no app <video> for WebGazer.
  const showVideo =
    trackingMode === "handpose" || trackingMode === "msi";

  return (
    <div
      ref={containerRef}
      className="gz-heatmap-frame"
      style={
        baseImageURL
          ? { backgroundImage: `url('${baseImageURL}')` }
          : undefined
      }
    >
      <div ref={overlayRef} className="gz-heatmap-overlay" />
      <video
        ref={videoRef}
        className="gz-heatmap-video"
        style={{ display: showVideo ? "block" : "none" }}
        playsInline
        muted
      />
      <canvas
        ref={vizCanvasRef}
        className="gz-heatmap-viz"
        width={160}
        height={120}
        style={{ display: showVideo ? "block" : "none" }}
      />
    </div>
  );
});
