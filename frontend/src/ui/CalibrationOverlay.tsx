/**
 * 5-point WebGazer calibration overlay.
 *
 * Replaces legacy tracker-manager.js:157-286 (startCalibrationSequence /
 * completeCalibration). When the active tracker is WebGazer and it
 * declares itself uncalibrated, we show a moving target on the heatmap
 * pane: center, then the four corners (with 50px padding). The user
 * clicks each marker; we forward the screen-space coords to
 * `tracker.recordCalibrationClick`.
 *
 * On the 5th click the overlay closes, the tracker is marked calibrated,
 * and tracking is left running.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { WebGazerTracker } from "../trackers/WebGazerTracker";
import "./CalibrationOverlay.css";

interface CalibrationOverlayProps {
  /** The heatmap container element — points are placed inside its bbox. */
  containerEl: HTMLElement | null;
  /** Active tracker. Only WebGazerTracker drives a calibration sequence. */
  tracker: unknown;
}

interface Point {
  x: number;
  y: number;
}

const PADDING = 50;

export function CalibrationOverlay({
  containerEl,
  tracker,
}: CalibrationOverlayProps) {
  const trackerCalibrated = useStore((s) => s.trackerCalibrated);
  const trackingMode = useStore((s) => s.trackingMode);
  const trackingActive = useStore((s) => s.trackingActive);
  const set = useStore((s) => s.set);

  const [points, setPoints] = useState<Point[]>([]);
  const [index, setIndex] = useState(0);
  const startedFor = useRef<HTMLElement | null>(null);

  const isWebGazer = tracker instanceof WebGazerTracker;
  // Calibration must run *after* the camera is on. Tracking-active is what
  // triggers the tracker's start() → webgazer.begin() (camera). Gating on it
  // matches legacy startCalibrationSequence, which called begin() first and
  // only then showed the markers. Without this gate the overlay appeared on
  // mode-select — before any camera — so clicks recorded nothing.
  const needsCalibration =
    trackingMode === "webgazer" &&
    trackingActive &&
    !trackerCalibrated &&
    isWebGazer;

  // Build the 5 calibration points (center + 4 corners) when calibration
  // begins. Coordinates are in document/page space so the markers can
  // overlay anywhere — including over the heatmap container.
  useEffect(() => {
    if (!needsCalibration || !containerEl) {
      setPoints([]);
      startedFor.current = null;
      return;
    }
    if (startedFor.current === containerEl) return;
    startedFor.current = containerEl;

    const r = containerEl.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const minX = r.left + PADDING;
    const maxX = r.left + r.width - PADDING;
    const minY = r.top + PADDING;
    const maxY = r.top + r.height - PADDING;
    setPoints([
      { x: cx, y: cy },
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: minX, y: maxY },
      { x: maxX, y: maxY },
    ]);
    setIndex(0);
  }, [needsCalibration, containerEl]);

  const handleClick = useCallback(() => {
    if (!isWebGazer || !points[index]) return;
    const wg = tracker as WebGazerTracker;
    wg.recordCalibrationClick(points[index].x, points[index].y);
    if (index + 1 >= points.length) {
      // Sequence complete. Tracking is already active (it's the gate for
      // this overlay), so only flip the calibrated flag to dismiss it.
      set("trackerCalibrated", true);
      setPoints([]);
      setIndex(0);
      startedFor.current = null;
    } else {
      setIndex(index + 1);
    }
  }, [isWebGazer, points, index, tracker, set]);

  if (!needsCalibration || points.length === 0) return null;
  const p = points[index];

  return (
    <div className="gz-calib-backdrop">
      <div className="gz-calib-instruction">
        Look at the dot, then click it.
        <br />
        <small>{index + 1} / {points.length}</small>
      </div>
      <button
        className="gz-calib-marker"
        style={{ left: `${p.x - 12}px`, top: `${p.y - 12}px` }}
        onClick={handleClick}
        aria-label={`Calibration point ${index + 1} of ${points.length}`}
      />
    </div>
  );
}
