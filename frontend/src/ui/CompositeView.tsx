/**
 * Composite view — the left pane in the legacy layout.
 *
 * Renders the master composite canvas inside a panzoom container. The fit
 * logic (whole composite vs. last patch) follows the legacy behavior at
 * image-processor.js:38-99.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import panzoom, { type PanZoom } from "panzoom";

import { compositeStore } from "../canvas/CompositeStore";
import { PullTool } from "../canvas/PullTool";
import { useStore } from "../store";
import "./CompositeView.css";

export function CompositeView() {
  const compositeHasCanvas = useStore((s) => s.compositeHasCanvas);
  const compositeRevision = useStore((s) => s.compositeRevision);
  const baseImgPosition = useStore((s) => s.baseImgPosition);
  const compositeFitEnabled = useStore((s) => s.compositeFitEnabled);
  const compositeFitTarget = useStore((s) => s.compositeFitTarget);
  const generationInProgress = useStore((s) => s.generationInProgress);
  const frameZoom = useStore((s) => s.frameZoom);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pzRef = useRef<PanZoom | null>(null);
  const [pz, setPz] = useState<PanZoom | null>(null);

  // Initialize panzoom once.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const inst = panzoom(canvas, {
      maxZoom: 5,
      minZoom: 0.1,
      smoothScroll: false,
    });
    pzRef.current = inst;
    setPz(inst);
    return () => {
      inst.dispose();
      pzRef.current = null;
      setPz(null);
    };
  }, []);

  // Copy the canonical offscreen composite canvas into the visible canvas.
  // This is deliberately a pixel copy, not a PNG encode/decode cycle.
  useEffect(() => {
    const visibleCanvas = canvasRef.current;
    if (!visibleCanvas) return;
    const sourceCanvas = compositeStore.getCanvas();
    if (!compositeHasCanvas || !sourceCanvas) {
      visibleCanvas.width = 0;
      visibleCanvas.height = 0;
      return;
    }

    if (
      visibleCanvas.width !== sourceCanvas.width ||
      visibleCanvas.height !== sourceCanvas.height
    ) {
      visibleCanvas.width = sourceCanvas.width;
      visibleCanvas.height = sourceCanvas.height;
    }
    const ctx = visibleCanvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, visibleCanvas.width, visibleCanvas.height);
    ctx.drawImage(sourceCanvas, 0, 0);
  }, [compositeHasCanvas, compositeRevision]);

  // Manual viewport mode (legacy ui-controller.js:332-357 +
  // image-processor.js:222-234): when fit is disabled, the user's pan/zoom
  // is preserved across composite updates. If the composite coordinate frame
  // shifts (growth or bounds clipping), we advance the translation so the
  // same image-space point stays visually under the camera.
  useEffect(() => {
    if (compositeFitEnabled) return;
    const onShift = (e: Event) => {
      const detail = (e as CustomEvent<{ coordinateShift: { x: number; y: number } }>)
        .detail;
      const shift = detail?.coordinateShift;
      if (!shift) return;
      const inst = pzRef.current;
      if (!inst) return;
      const t = inst.getTransform();
      inst.moveTo(t.x + shift.x * t.scale, t.y + shift.y * t.scale);
    };
    window.addEventListener("gz-composite-shift", onShift);
    return () => window.removeEventListener("gz-composite-shift", onShift);
  }, [compositeFitEnabled]);

  // Fit the composite into the (possibly zoomed) frame. Extracted so both the
  // trigger effect and the frame-resize observer share one implementation.
  const applyFit = useCallback(() => {
    const canvas = canvasRef.current;
    const cont = containerRef.current;
    const pz = pzRef.current;
    if (!canvas || !cont || !pz || !compositeHasCanvas) return;
    if (!compositeFitEnabled) return; // manual mode — keep the user's transform

    const cw = cont.clientWidth;
    const ch = cont.clientHeight;
    let scale: number;
    let tx: number;
    let ty: number;

    if (compositeFitTarget === "composite") {
      if (canvas.width === 0 || canvas.height === 0) return;
      scale = Math.min(cw / canvas.width, ch / canvas.height);
      tx = (cw - canvas.width * scale) / 2;
      ty = (ch - canvas.height * scale) / 2;
    } else {
      // Fit the last patch.
      const { x, y, width, height } = baseImgPosition;
      if (width === 0 || height === 0) return;
      scale = Math.min(cw / width, ch / height);
      const pcx = x + width / 2;
      const pcy = y + height / 2;
      tx = cw / 2 - pcx * scale;
      ty = ch / 2 - pcy * scale;
    }

    pz.zoomAbs(0, 0, scale);
    pz.moveTo(tx, ty);
  }, [compositeHasCanvas, compositeFitEnabled, compositeFitTarget, baseImgPosition]);

  // Re-fit on image source / fit-mode changes, every composite revision, and
  // on frame-zoom changes (which resize the container).
  useEffect(() => {
    applyFit();
  }, [applyFit, compositeRevision, frameZoom]);

  // Re-fit when the frame itself resizes — the Frame-zoom slider or a window
  // resize changes the container, and the composite should re-center to it.
  useEffect(() => {
    const cont = containerRef.current;
    if (!cont || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => applyFit());
    ro.observe(cont);
    return () => ro.disconnect();
  }, [applyFit]);

  return (
    <div ref={containerRef} className="gz-composite-frame">
      {generationInProgress && (
        <div className="gz-composite-spinner">
          <div className="gz-spinner" />
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="gz-composite-canvas"
        aria-label="Composite"
        role="img"
        style={{ visibility: compositeHasCanvas ? "visible" : "hidden" }}
      />
      <PullTool pz={pz} />
    </div>
  );
}
