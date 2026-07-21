/**
 * Top-level application shell.
 *
 * Holds the HeatmapView ref so the pipeline + calibration overlay have
 * access to the live HeatmapInstance, the container element, and the
 * active tracker.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import "./styles/global.css";
import { CalibrationOverlay } from "./ui/CalibrationOverlay";
import { CompositeView } from "./ui/CompositeView";
import { ControlPanel } from "./ui/ControlPanel";
import {
  HeatmapView,
  type HeatmapViewHandle,
} from "./ui/HeatmapView";
import { MainActions } from "./ui/MainActions";
import { WelcomeModal } from "./ui/WelcomeModal";
import { useGenerate, useIterativeLoop } from "./ui/hooks/useGenerate";
import { useStore } from "./store";
import type { PipelineCtx } from "./generation/pipeline";

export function App() {
  const theme = useStore((s) => s.theme);
  // Trigger the calibration overlay re-evaluation when these change so it
  // can resolve the live tracker / container element.
  const trackingMode = useStore((s) => s.trackingMode);
  const trackerCalibrated = useStore((s) => s.trackerCalibrated);
  // View-toggle visibility: when off, the frame is kept mounted but
  // shoved off-screen so the pipeline can still read its bounding rect
  // for COM math (heatmap especially — its tracker keeps feeding data
  // even while hidden, so we can't unmount or `display: none` the
  // container).
  const canvasVisible = useStore((s) => s.canvasVisible);
  const heatmapVisible = useStore((s) => s.heatmapVisible);
  const compositeMatteEnabled = useStore((s) => s.compositeMatteEnabled);
  const heatmapMatteEnabled = useStore((s) => s.heatmapMatteEnabled);
  const matteColor = useStore((s) => s.matteColor);
  const frameZoom = useStore((s) => s.frameZoom);
  const uiScale = useStore((s) => s.uiScale);

  // Apply theme class to <body>.
  useEffect(() => {
    document.body.classList.toggle("gz-theme-dark", theme === "dark");
  }, [theme]);

  // The HeatmapView exposes its container element + heatmap instance via
  // a forwarded handle. We construct a stable PipelineCtx from those.
  const heatmapHandleRef = useRef<HeatmapViewHandle | null>(null);

  // The CalibrationOverlay needs *render-cycle* refresh of containerEl /
  // tracker so the visual overlay shows up when WebGazer is selected.
  // Track them as state, refreshed on every relevant store change via
  // useEffect.
  const [calibContainer, setCalibContainer] = useState<HTMLElement | null>(null);
  const [calibTracker, setCalibTracker] = useState<unknown>(null);
  useEffect(() => {
    setCalibContainer(heatmapHandleRef.current?.containerEl ?? null);
    setCalibTracker(heatmapHandleRef.current?.tracker ?? null);
    // Re-resolve when tracker state changes so the freshly created tracker
    // is picked up. (Refs populate in the same commit phase as effects.)
  }, [trackingMode, trackerCalibrated]);

  const buildCtx = useCallback((): PipelineCtx | null => {
    const h = heatmapHandleRef.current;
    if (!h?.heatmapInstance || !h.containerEl) return null;
    return {
      heatmap: h.heatmapInstance,
      containerSize: () => {
        const el = h.containerEl!;
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height };
      },
    };
  }, []);

  // Pass the accessor (not its result) so the hook resolves the live
  // heatmap + container at click time. Calling buildCtx() during render
  // evaluates while refs are still null on first mount.
  const { generate, abort } = useGenerate(buildCtx);
  useIterativeLoop(generate, buildCtx);

  const clearHeatmap = useCallback(() => {
    const h = heatmapHandleRef.current;
    h?.tracker?.clearHeatmap?.();
    h?.heatmapInstance?.clear();
  }, []);

  const layoutStyle = {
    "--gz-matte-color": matteColor,
    "--gz-frame-scale": String(frameZoom / 100),
    "--gz-ui-scale": String(uiScale / 100),
  } as CSSProperties;

  return (
    <>
      <WelcomeModal />
      <div
        className={[
          "gz-layout",
          compositeMatteEnabled ? "gz-layout--composite-matte" : "",
          heatmapMatteEnabled ? "gz-layout--heatmap-matte" : "",
        ].filter(Boolean).join(" ")}
        style={layoutStyle}
      >
        <main className="gz-stage">
          <MainActions
            onGenerate={generate}
            onAbort={abort}
            onClearHeatmap={clearHeatmap}
          />
          <div className="gz-canvases">
            <div className={canvasVisible ? "gz-canvas-slot" : "gz-canvas-slot gz-canvas-slot--hidden"}>
              <CompositeView />
            </div>
            <div className={heatmapVisible ? "gz-canvas-slot" : "gz-canvas-slot gz-canvas-slot--hidden"}>
              <HeatmapView ref={heatmapHandleRef} />
            </div>
          </div>
        </main>
        <ControlPanel getPipelineCtx={buildCtx} />
      </div>
      <CalibrationOverlay
        containerEl={calibContainer}
        tracker={calibTracker}
      />
    </>
  );
}
