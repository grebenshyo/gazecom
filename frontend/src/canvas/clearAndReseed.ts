/**
 * Wipe the composite canvas and reseed from the user's currently-selected
 * reference image. Used by both the manual "Clear canvas" button
 * (MainActions) and the auto-clear cadence (pipeline.ts).
 *
 * Carved out as its own module so the two call sites stay in sync —
 * inlining identical 25-line blocks in two places was the previous shape
 * and meant any tweak (e.g. preserving a field across clear) had to land
 * twice or risk drift.
 *
 * Note on `generationInProgress`: callers decide. The manual button
 * forces it false because it's a user-initiated reset that should also
 * cancel any pipeline confusion. The auto-clear caller is *inside* the
 * pipeline's finally-block flow, so it leaves the field alone — the
 * outer try/finally already handles it.
 */

import { compositeStore } from "./CompositeStore";
import { processImageURLToBaseSquare } from "../lib/images";
import { useStore } from "../store";

export interface ClearAndReseedOptions {
  /**
   * When true, also resets `generationInProgress` to false. The manual
   * Clear button passes true (user-initiated reset). The auto-clear from
   * inside the pipeline passes false because the surrounding try/finally
   * is already managing that flag.
   */
  resetGenerationInProgress?: boolean;
}

export async function clearAndReseed(
  opts: ClearAndReseedOptions = {},
): Promise<void> {
  window.dispatchEvent(new Event("gz-pull-reset"));
  compositeStore.clear();
  useStore.getState().patch({
    baseImageURL: "",
    baseImgPosition: { x: 0, y: 0, width: 0, height: 0 },
    baseCOM: { x: 0.5, y: 0.5 },
    firstPatchPosition: null,
    isComposited: false,
    // Display counter ("patches since last clear") resets here so
    // both the manual button and the pipeline's auto-clear path
    // restart from 0 the same way.
    patchesSinceClear: 0,
    ...(opts.resetGenerationInProgress ? { generationInProgress: false } : {}),
  });

  // Reseed from the user's currently-selected reference image so the
  // next generation has a base to work from. Iterative mode would
  // otherwise hit an empty canvas on the next tick.
  const sel = useStore.getState().selectedImage;
  if (!sel) return;
  try {
    const dataURL = await processImageURLToBaseSquare(`/images/${sel}`);
    await compositeStore.setFromImageURL(dataURL);
    useStore.getState().patch({
      baseImageURL: dataURL,
      baseImgPosition: { x: 0, y: 0, width: 1024, height: 1024 },
    });
  } catch (err) {
    console.error("Failed to reseed image after clear:", err);
  }
}
