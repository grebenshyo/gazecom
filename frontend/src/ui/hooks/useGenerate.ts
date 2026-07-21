/**
 * React hooks that drive the generation pipeline + iterative mode.
 *
 * - `useGenerate(getCtx)` returns `{ generate, abort }`. `generate()`
 *   creates a fresh AbortController per call (any prior in-flight is
 *   aborted first), passes the signal to the pipeline, and exposes
 *   `abort()` to the caller. AbortError propagates silently (no popup)
 *   so the iterative loop can exit cleanly on user-initiated stop.
 * - `useIterativeLoop(generate)` watches `iterativeRunning` (NOT
 *   `iterativeMode`). The Generate/Stop button is the only thing that
 *   flips `iterativeRunning`; toggling the panel's iterative mode does
 *   not start or stop the loop.
 *
 * The `useEffect` deps array includes `iterativeDelay` so a delay change
 * mid-run restarts the timer cleanly — the legacy bug at
 * ui-controller.js:207-288 is fixed by construction.
 */

import { useCallback, useEffect, useRef } from "react";

import { generateOnce, type PipelineCtx } from "../../generation/pipeline";
import { useStore } from "../../store";

export interface GenerateHandle {
  generate: () => Promise<void>;
  abort: () => void;
}

export function useGenerate(getCtx: () => PipelineCtx | null): GenerateHandle {
  // Hold the latest accessor in a ref so the returned callback always
  // resolves the *current* heatmap + container at click time, not at
  // render time. Earlier we passed `buildCtx()` (a value computed during
  // render, when refs were null) instead of the function itself — that
  // made Generate a no-op until App.tsx re-rendered for some other reason.
  const getCtxRef = useRef(getCtx);
  getCtxRef.current = getCtx;

  // The single in-flight controller, if any. Cleared in finally only if
  // we're still the current one (a later `generate()` may have replaced us).
  const controllerRef = useRef<AbortController | null>(null);

  const generate = useCallback(async () => {
    const c = getCtxRef.current();
    if (!c) {
      console.warn("useGenerate: pipeline context unavailable");
      throw new Error("Pipeline context unavailable.");
    }

    // Abort any prior in-flight call before starting a new one.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      await generateOnce(c, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        // User-initiated cancel — stay silent. The error still propagates so
        // the iterative loop catches it and exits without scheduling another tick.
        throw err;
      }
      console.error("Generation failed:", err);
      // Surface to user as alert until we have a toast system, then
      // rethrow so callers (useIterativeLoop) can disable themselves
      // rather than trap the user in a popup spam.
      alert(`Generation failed: ${(err as Error).message}`);
      throw err;
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    }
  }, []);

  const abort = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return { generate, abort };
}

/**
 * Iterative loop: when `iterativeRunning` is true, run `generate`
 * repeatedly with `iterativeDelay` seconds of pause between runs.
 *
 * Pattern: a single recursive setTimeout. Cancelled cleanly on unmount or
 * when the deps change (running flips, delay updates). Recursive
 * setTimeout (rather than setInterval) ensures each run waits for the
 * previous to finish — no overlapping generations.
 *
 * Halt conditions: any throw from `generate()` flips `iterativeRunning`
 * off. That covers both real failures (where `useGenerate` already
 * alerted) and user-initiated abort via the Stop button (silent).
 */
export function useIterativeLoop(
  generate: () => Promise<void>,
  getCtx?: () => PipelineCtx | null,
): void {
  const iterativeRunning = useStore((s) => s.iterativeRunning);
  const iterativeDelay = useStore((s) => s.iterativeDelay);

  // Pin the latest accessors so cancellation is clean even if the caller
  // recreates them.
  const generateRef = useRef(generate);
  generateRef.current = generate;
  const getCtxRef = useRef(getCtx);
  getCtxRef.current = getCtx;

  useEffect(() => {
    if (!iterativeRunning) return;

    let cancelled = false;
    let timeoutId: number | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        await generateRef.current();
      } catch {
        // AbortError (user-initiated) or genuine failure — either way, halt.
        // useGenerate already alerted in the failure case; AbortError stays
        // silent. Flip the flag so the useEffect cleanup runs.
        useStore.getState().set("iterativeRunning", false);
        return;
      }
      if (cancelled) return;
      // Reset heatmap between iterations (legacy
      // generation-engine.js:687-705 → resetHeatmapForNextIter). For
      // additive trackers (WebGazer) this clears the accumulated mass;
      // trail-based trackers (including VLM's re-emitted single point)
      // refill on their next tick.
      getCtxRef.current?.()?.heatmap.clear();
      timeoutId = window.setTimeout(tick, Math.max(0, iterativeDelay) * 1000);
    };

    tick();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };
  }, [iterativeRunning, iterativeDelay]);
}
