/**
 * Pull tool — the 1024×1024 crop box that lets users extract a region of
 * the composite as the next base patch.
 *
 * Ported from legacy js/pull.js (245 lines). Refactor:
 *   - Lives inside CompositeView's React tree instead of injecting itself
 *     into the DOM via setTimeout polling.
 *   - Uses panzoom's API (ref'd from the parent) instead of regex-parsing
 *     the live CSS transform string (legacy:48-58).
 *   - Coordinate-shift correction goes through the same store as
 *     everything else, not via a custom DOM event.
 *
 * Image-space coordinate system: the box position (`pos`) is the top-left
 * of the crop in the master-composite's pixel coordinate space. Render
 * applies the panzoom transform so the box visually tracks the image.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PanZoom } from "panzoom";
import { compositeStore } from "./CompositeStore";
import { pullHandle } from "./pullHandle";
import { useStore } from "../store";
import "./PullTool.css";

const PATCH = 1024;

interface PullToolProps {
  /** Live panzoom instance from the parent CompositeView. */
  pz: PanZoom | null;
}

export function PullTool({ pz }: PullToolProps) {
  const visible = useStore((s) => s.cropBoxVisible);
  const borderWidth = useStore((s) => s.cropBoxBorderWidth);
  const compositeHasCanvas = useStore((s) => s.compositeHasCanvas);
  const set = useStore((s) => s.set);

  // Crop box position in image-space (top-left).
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({
    dragging: false,
    lastX: 0,
    lastY: 0,
  });

  // Subscribe to panzoom transform changes.
  useEffect(() => {
    if (!pz) return;
    const update = () => {
      const t = pz.getTransform();
      setTransform({ x: t.x, y: t.y, scale: t.scale });
    };
    update();
    pz.on("pan", update);
    pz.on("zoom", update);
    pz.on("panzoomchange", update);
    return () => {
      pz.off("pan", update);
      pz.off("zoom", update);
      pz.off("panzoomchange", update);
    };
  }, [pz]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    dragRef.current.dragging = true;
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;
    setIsDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d.dragging || !pz) return;
      const t = pz.getTransform();
      const dx = (e.clientX - d.lastX) / t.scale;
      const dy = (e.clientY - d.lastY) / t.scale;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      setPos((p) => ({ x: p.x + dx, y: p.y + dy }));
      e.preventDefault();
      e.stopPropagation();
    },
    [pz],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current.dragging = false;
    setIsDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handlePull = useCallback(async () => {
    const sourceCanvas = compositeStore.getCanvas();
    if (!sourceCanvas) return;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = PATCH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, PATCH, PATCH);
    ctx.drawImage(sourceCanvas, -pos.x, -pos.y);
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, "image/png"),
    );
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    set("baseImageURL", url);
    set("baseImgPosition", {
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      width: PATCH,
      height: PATCH,
    });
    set("baseCOM", { x: 0.5, y: 0.5 });
    set("isComposited", true);
  }, [pos, set]);

  const handleHome = useCallback(() => {
    const { firstPatchPosition, baseImgPosition } = useStore.getState();
    const home =
      firstPatchPosition ??
      (baseImgPosition.width > 0 && baseImgPosition.height > 0
        ? baseImgPosition
        : null);
    const homeCenterX = (home?.x ?? 0) + (home?.width ?? PATCH) / 2;
    const homeCenterY = (home?.y ?? 0) + (home?.height ?? PATCH) / 2;
    setPos({
      x: Math.round(homeCenterX - PATCH / 2),
      y: Math.round(homeCenterY - PATCH / 2),
    });
  }, []);

  // Register the pull action with the bar (MainActions). The Pull button
  // lives there now; we keep `handlePull` close to its data (canvas, pos)
  // so dragging stays cheap.
  useEffect(() => {
    pullHandle.register(handlePull);
    return () => pullHandle.register(null);
  }, [handlePull]);

  useEffect(() => {
    pullHandle.registerHome(handleHome);
    return () => pullHandle.registerHome(null);
  }, [handleHome]);

  // Reset position when the composite is cleared.
  useEffect(() => {
    if (!compositeHasCanvas) {
      setPos({ x: 0, y: 0 });
    }
  }, [compositeHasCanvas]);

  useEffect(() => {
    const reset = () => setPos({ x: 0, y: 0 });
    window.addEventListener("gz-pull-reset", reset);
    return () => window.removeEventListener("gz-pull-reset", reset);
  }, []);

  // When the composite coordinate frame shifts (growth or bounds clipping),
  // the box's image-space anchor needs to follow. Pipeline dispatches
  // gz-composite-shift after each generation step.
  useEffect(() => {
    const onShift = (e: Event) => {
      const detail = (e as CustomEvent<{ coordinateShift: { x: number; y: number } }>)
        .detail;
      const shift = detail?.coordinateShift;
      if (!shift) return;
      setPos((p) => ({ x: p.x + shift.x, y: p.y + shift.y }));
    };
    window.addEventListener("gz-composite-shift", onShift);
    return () => window.removeEventListener("gz-composite-shift", onShift);
  }, []);

  // Show as soon as the toggle is on AND there's something on the canvas
  // to crop from. This includes the moment a base image is auto-seeded,
  // before any generation has happened.
  if (!visible || !compositeHasCanvas) return null;

  // Render: the box is positioned in image-space, then transformed by the
  // current panzoom transform so it tracks the image visually.
  const style: React.CSSProperties = {
    "--gz-crop-box-border-width": `${borderWidth}px`,
    transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale}) translate(${pos.x}px, ${pos.y}px)`,
    transformOrigin: "0 0",
    width: PATCH,
    height: PATCH,
  } as React.CSSProperties;

  return (
    <div
      className={`gz-crop-box${isDragging ? " active" : ""}`}
      style={style}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  );
}
