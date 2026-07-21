/**
 * React hook that owns the lifecycle of a HeatmapInstance bound to a
 * container ref. Re-creates the instance when the heatmap style changes.
 *
 * Returns the sink for trackers to write into, plus the live instance for
 * the generation pipeline (Phase 5) to read data + canvas from.
 */

import { useEffect, useRef } from "react";
import { HeatmapInstance } from "../../canvas/HeatmapInstance";
import { useStore } from "../../store";

export function useHeatmap(containerRef: React.RefObject<HTMLElement>): {
  instanceRef: React.RefObject<HeatmapInstance | null>;
} {
  const heatmapStyle = useStore((s) => s.heatmapStyle);
  const pointSize = useStore((s) => s.pointSize);
  const pointJitter = useStore((s) => s.pointJitter);
  const eventHistoryLength = useStore((s) => s.eventHistoryLength);
  const instanceRef = useRef<HeatmapInstance | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (!instanceRef.current) {
      instanceRef.current = new HeatmapInstance(container, heatmapStyle);
    } else {
      instanceRef.current.setStyle(heatmapStyle);
    }
  }, [containerRef, heatmapStyle]);

  // Seed + live-update dot size/jitter. Kept out of the style effect so a
  // slider tweak doesn't tear down and rebuild the h337 instance — these
  // fields live on HeatmapInstance and survive setStyle. Runs after the
  // create effect on mount, so it also seeds persisted values.
  useEffect(() => {
    instanceRef.current?.setPointSize(pointSize);
    instanceRef.current?.setPointJitter(pointJitter);
    instanceRef.current?.setEventHistoryLength(eventHistoryLength);
  }, [eventHistoryLength, pointSize, pointJitter]);

  // Cleanup on unmount: dispose tears down the ResizeObserver + h337
  // canvases (clear() alone would leave the observer connected).
  useEffect(() => {
    return () => {
      instanceRef.current?.dispose();
      instanceRef.current = null;
    };
  }, []);

  return { instanceRef };
}
