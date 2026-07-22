/**
 * Main actions bar — Track / Generate-or-Stop / Pull / Download.
 *
 * Generate is the only place generation starts and stops. While idle the
 * label is "Generate image"; while a single shot is in flight OR the
 * iterative loop is running, the same button becomes "Stop" and clicking
 * it aborts the in-flight request and clears the iterative flag. The
 * Iterative toggle in the panel is purely a config flag — it never starts
 * or stops the loop.
 *
 * Pull triggers the cropbox extraction registered by `PullTool` via the
 * `pullHandle` module. This keeps bbox drag state local to PullTool (no
 * Zustand re-render on every pointer move) while letting the bar own the
 * imperative action.
 */

import { Button } from "./components";
import { clearAndReseed } from "../canvas/clearAndReseed";
import { downloadComposite } from "../canvas/downloadComposite";
import { pullHandle } from "../canvas/pullHandle";
import { bumpEpoch } from "../generation/epoch";
import { activePool } from "../generation/workflows";
import { promptPoolIsValid } from "../prompts";
import { useStore } from "../store";
import "./MainActions.css";

interface MainActionsProps {
  onGenerate: () => Promise<void> | void;
  onAbort: () => void;
  onClearHeatmap: () => void;
}

export function MainActions({
  onGenerate,
  onAbort,
  onClearHeatmap,
}: MainActionsProps) {
  const trackingActive = useStore((s) => s.trackingActive);
  const generationInProgress = useStore((s) => s.generationInProgress);
  const compositeHasCanvas = useStore((s) => s.compositeHasCanvas);
  const iterativeMode = useStore((s) => s.iterativeMode);
  const iterativeRunning = useStore((s) => s.iterativeRunning);
  const cropBoxVisible = useStore((s) => s.cropBoxVisible);
  const pinnedWorkflows = useStore((s) => s.pinnedWorkflows);
  const mutedWorkflows = useStore((s) => s.mutedWorkflows);
  const pinnedPrompts = useStore((s) => s.pinnedPrompts);
  const set = useStore((s) => s.set);

  const isGenerating = generationInProgress || iterativeRunning;
  const poolEmpty = Object.keys(pinnedWorkflows).length === 0;
  const hasActiveWorkflow =
    Object.keys(activePool(pinnedWorkflows, mutedWorkflows)).length > 0;
  const promptPoolValid = promptPoolIsValid(pinnedPrompts);

  const handleGenerateClick = () => {
    if (isGenerating) {
      // Stop: abort any in-flight fetch and clear the loop flag. Either
      // alone isn't enough — abort handles the single-shot path; clearing
      // iterativeRunning prevents the loop from scheduling a next tick.
      onAbort();
      set("iterativeRunning", false);
      return;
    }
    if (iterativeMode) {
      // Kick the loop. useIterativeLoop's effect picks this up.
      set("iterativeRunning", true);
    } else {
      void Promise.resolve(onGenerate()).catch(() => {
        // useGenerate already logged + alerted; prevent a duplicate
        // "Uncaught (in promise)" for single-shot button clicks.
      });
    }
  };

  const handleDownload = () => void downloadComposite();

  /**
   * Tell the pipeline to discard whatever generation is currently in
   * flight, without aborting the network leg and without halting the
   * iterative loop. The in-flight `generateOnce` will run to
   * completion; at apply time it sees the bumped epoch and silently
   * drops the result before touching the canvas or store. Iterative
   * mode then schedules its next tick against the freshly-mutated
   * (post-Pull / post-Clear) state.
   *
   * This replaces the simpler "just abort" approach because Stop's
   * abort semantics also kill the iterative loop — and the user wants
   * Pull/Clear during a long iterative run to redirect the loop, not
   * stop it.
   *
   * Safe to call when nothing is running — bumpEpoch just increments
   * a counter no one is reading.
   */
  const invalidateInFlight = () => {
    if (!isGenerating) return;
    bumpEpoch();
  };

  /**
   * Wipe the persistent composite canvas and reseed from the user's
   * currently-selected reference image so they have something to track
   * on. Mirrors legacy ui-controller.js:676-744. (Was previously inside
   * the Composite-fit section as "Clear composite"; promoted to the
   * actions bar.)
   */
  const handleClearCanvas = async () => {
    invalidateInFlight();
    // User-initiated reset: force generationInProgress off too, in case
    // a stale in-flight pipeline call's finally block hasn't fired yet.
    await clearAndReseed({ resetGenerationInProgress: true });
  };

  // Pull is enabled whenever the bbox is visible and there's something on
  // the canvas — same gate as the bbox itself (PullTool render condition).
  // Working off a pre-generation base image is allowed: pulling crops a
  // 1024² region of the seeded reference and makes that the new
  // baseImageURL. `isGenerating` is intentionally NOT in this gate —
  // Pull bumps the generation epoch via invalidateInFlight() so the
  // in-flight result is dropped without aborting the network leg or
  // halting iterative mode, sidestepping the stale-apply copy-paste
  // bug.
  const pullDisabled = !cropBoxVisible || !compositeHasCanvas;

  return (
    <div className="gz-actions">
      <Button
        variant="primary"
        onClick={() => set("trackingActive", !trackingActive)}
      >
        {trackingActive ? "Stop tracking" : "Start tracking"}
      </Button>
      <Button
        variant="primary"
        onClick={handleGenerateClick}
        // Both pools use relative weights normalized during selection. The
        // only blocker is having no positive, unmuted entry to pick.
        // Stop remains clickable while a generation is running.
        disabled={!isGenerating && (!hasActiveWorkflow || !promptPoolValid)}
        title={
          isGenerating
            ? undefined
            : poolEmpty
              ? "Pin a workflow first"
              : !hasActiveWorkflow
                ? "Unmute a workflow or give one a weight above 0"
                : !promptPoolValid
                  ? "Unmute a prompt slot with a weight above 0"
                  : undefined
        }
      >
        {isGenerating ? "Stop" : "Generate image"}
      </Button>
      <Button
        variant="primary"
        onClick={() => {
          invalidateInFlight();
          void pullHandle.trigger();
        }}
        disabled={pullDisabled}
        title={
          pullDisabled && !cropBoxVisible
            ? "Enable the crop box first"
            : undefined
        }
      >
        Pull
      </Button>
      <Button
        variant="primary"
        onClick={() => void handleClearCanvas()}
      >
        Clear canvas
      </Button>
      <Button
        variant="primary"
        onClick={onClearHeatmap}
      >
        Clear heatmap
      </Button>
      <Button
        variant="primary"
        onClick={handleDownload}
        disabled={!compositeHasCanvas}
      >
        Download
      </Button>
    </div>
  );
}
