/**
 * React hook that drives the active tracker.
 *
 * Replaces legacy tracker-manager.js (558 lines). Logic flow:
 * - When `trackingMode` changes in the store, dispose the old tracker and
 *   create a new one for the new mode.
 * - When `trackingActive` becomes true, start the new tracker.
 * - When it becomes false, stop the tracker (kept alive so resume is fast).
 * - On unmount, dispose the tracker and release the camera/model.
 */

import { useEffect, useRef } from "react";

import {
  deriveCompositeBounds,
  deriveRoamConstraint,
} from "../../canvas/CompositeBounds";
import type { HeatmapInstance } from "../../canvas/HeatmapInstance";
import { useStore } from "../../store";
import {
  createTracker,
  type Tracker,
  type TrackerRefs,
  WebGazerTracker,
} from "../../trackers";

export interface UseTrackerArgs {
  /** Container that defines the heatmap canvas bounds. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Hidden <video> element used by camera-based trackers. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Overlay canvas drawn over the video for landmark/saliency dots. */
  vizCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** The heatmap instance the tracker writes to. */
  heatmapInstanceRef: React.RefObject<HeatmapInstance | null>;
}

export function useTracker({
  containerRef,
  videoRef,
  vizCanvasRef,
  heatmapInstanceRef,
}: UseTrackerArgs): { trackerRef: React.RefObject<Tracker | null> } {
  const trackingMode = useStore((s) => s.trackingMode);
  const trackingActive = useStore((s) => s.trackingActive);
  const roamSpeed = useStore((s) => s.roamSpeed);
  const trailLength = useStore((s) => s.trailLength);
  const calibCache = useStore((s) => s.calibCache);
  const trackerCalibrated = useStore((s) => s.trackerCalibrated);
  const setStore = useStore((s) => s.set);

  const trackerRef = useRef<Tracker | null>(null);
  const previousCalibratedRef = useRef(trackerCalibrated);

  // (Re)create tracker on mode change.
  useEffect(() => {
    let cancelled = false;

    const refs = (): TrackerRefs => ({
      container: containerRef.current,
      video: videoRef.current,
      vizCanvas: vizCanvasRef.current,
    });

    const sink = {
      addPoint: (p: { x: number; y: number; value: number }) =>
        heatmapInstanceRef.current?.addPoint(p),
      addHistoryPoint: (p: { x: number; y: number; value: number }) =>
        heatmapInstanceRef.current?.addHistoryPoint(p),
      setData: (pts: readonly { x: number; y: number; value: number }[]) =>
        heatmapInstanceRef.current?.setData(pts),
      clear: () => heatmapInstanceRef.current?.clear(),
    };

    const getContainerSize = () => {
      const el = containerRef.current;
      if (!el) return { width: 0, height: 0 };
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    };

    const getRoamConstraint = () => {
      const s = useStore.getState();
      if (!s.comMode || !s.compositeMode || !s.boundsEnabled) return null;

      const firstPatch = s.firstPatchPosition ?? s.baseImgPosition;
      const nextSize = {
        width: s.baseImgPosition.width,
        height: s.baseImgPosition.height,
      };
      const bounds = deriveCompositeBounds(
        {
          enabled: s.boundsEnabled,
          width: s.boundsWidth,
          height: s.boundsHeight,
        },
        firstPatch,
        nextSize,
      );
      if (!bounds) return null;

      return (
        deriveRoamConstraint({
          bounds,
          basePosition: s.baseImgPosition,
          nextSize,
          containerSize: getContainerSize(),
        }) ?? null
      );
    };

    const getVlmPoint = () => useStore.getState().vlmPoint;

    // Entering VLM mode starts fresh at the center (the pipeline repoints it
    // per generation; the tracker renders null as the center point).
    if (trackingMode === "vlm") {
      useStore.getState().set("vlmPoint", null);
    }

    const tracker = createTracker(
      trackingMode,
      { sink, getContainerSize, getRoamConstraint, getVlmPoint },
      refs,
    );
    trackerRef.current = tracker;
    // Seed live-adjustable params from the current store values (no-op for
    // trackers that don't implement the setter). The tracker's own
    // construction default is immediately overridden by the store value.
    const s = useStore.getState();
    tracker.setSpeed?.(s.roamSpeed);
    tracker.setTrailLength?.(s.trailLength);
    if (tracker instanceof WebGazerTracker) {
      tracker.setCacheMode(s.calibCache);
    }

    tracker.init().catch((err) => {
      if (!cancelled) console.error("Tracker init failed:", err);
    });

    return () => {
      cancelled = true;
      const t = trackerRef.current;
      trackerRef.current = null;
      // Kick off async dispose; don't await — React expects sync cleanup.
      t?.dispose().catch((err) => console.error("Tracker dispose failed:", err));
      // Reset transient state.
      setStore("trackingActive", false);
      setStore("trackerCalibrated", false);
    };
    // We intentionally do not depend on heatmapInstanceRef etc. — they're
    // refs, not state, and stay stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackingMode]);

  // Push live speed changes to the (roam) tracker without recreating it.
  useEffect(() => {
    trackerRef.current?.setSpeed?.(roamSpeed);
  }, [roamSpeed]);

  // Push live trail-length changes to any trail-based tracker.
  useEffect(() => {
    trackerRef.current?.setTrailLength?.(trailLength);
  }, [trailLength]);

  // WebGazer owns calibration persistence. This can change live for future
  // samples; the initial value is also applied before init()/begin().
  useEffect(() => {
    const tracker = trackerRef.current;
    if (tracker instanceof WebGazerTracker) {
      tracker.setCacheMode(calibCache);
    }
  }, [calibCache]);

  // A true -> false transition is the explicit Recalibrate action. Clear the
  // loaded/saved model then; the initial false state must not erase a cache.
  useEffect(() => {
    const wasCalibrated = previousCalibratedRef.current;
    previousCalibratedRef.current = trackerCalibrated;
    if (wasCalibrated && !trackerCalibrated) {
      const tracker = trackerRef.current;
      if (tracker instanceof WebGazerTracker) {
        tracker.clearCalibrationData();
      }
    }
  }, [trackerCalibrated]);

  // Start/stop on active toggle.
  useEffect(() => {
    const tracker = trackerRef.current;
    if (!tracker) return;

    if (trackingActive) {
      tracker.start().catch((err) => {
        console.error(`Tracker ${tracker.id} start failed:`, err);
        setStore("trackingActive", false);
      });
    } else {
      tracker.stop().catch((err) => {
        console.error(`Tracker ${tracker.id} stop failed:`, err);
      });
    }
  }, [trackingActive, setStore]);

  return { trackerRef };
}
