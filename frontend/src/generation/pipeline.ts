/**
 * Single generation entry point.
 *
 * Replaces the near-duplicate methods at legacy
 * generation-engine.js:303-493 (standard, masked, and COM-cropped paths).
 * Branches are now data-driven by `{ workflowType, useCOM }`.
 *
 * Pipeline:
 *   1. Resolve workflow (random-weighted or current selection).
 *   2. Resolve the prompt text selected by the weighted prompt pool.
 *   3. Build input image:
 *      - in-/outpainting w/ COM: crop + alpha mask
 *      - in-/outpainting w/o COM: base image + alpha mask
 *      - edit w/ COM: crop master composite around COM, flattened to bg
 *      - edit w/o COM: plain current base patch
 *      - standard w/ COM: crop master composite around COM (no mask)
 *      - standard w/o COM: capture base + heatmap onto canvas
 *   4. POST /api/generate
 *   5. Composite the result onto the canvas using planComposite()
 *      (canvas/Composite.ts).
 *   6. Update store: baseImageURL, composite revision, baseImgPosition,
 *      isComposited, baseCOM.
 */

import type { HeatmapInstance } from "../canvas/HeatmapInstance";
import { applyPlan, planComposite } from "../canvas/Composite";
import {
  clampCOMToBounds,
  deriveCompositeBounds,
} from "../canvas/CompositeBounds";
import { compositeStore } from "../canvas/CompositeStore";
import { clearAndReseed } from "../canvas/clearAndReseed";
import { downloadComposite } from "../canvas/downloadComposite";
import { gazeCOM } from "../canvas/Heatmap";
import {
  pickPromptSlot,
  promptSlotAutoEnhanceMode,
  promptSlotVisionEnabled,
  replaceAllPlaceholders,
  setPromptSlotDerivedText,
  setPromptSlotText,
} from "../prompts";
import { useStore, type TrackingMode } from "../store";
import { generateRequest, type VLMPoint } from "./api";
import {
  captureBasePatch,
  buildInpaintingMask,
  captureHeatmapOnBase,
  captureVisionFrame,
  captureVisionFrameFromCanvas,
  cropAroundCanvasPoint,
  cropAroundPoint,
  flattenAlphaOnBg,
} from "./captureHeatmap";
import { getEpoch } from "./epoch";
import { OllamaLLMProvider, OllamaVLMProvider } from "./llm";
import {
  determineWorkflowType,
  pickFromPool,
  type WorkflowType,
} from "./workflows";

export interface PipelineCtx {
  heatmap: HeatmapInstance;
  /** Current heatmap container size (matches the displayed coordinate space). */
  containerSize: () => { width: number; height: number };
}

/**
 * Run one generation. Throws on any backend / image error; the caller is
 * responsible for catching and presenting it (UI/handlers).
 *
 * If `signal` aborts mid-run the in-flight backend fetch rejects with
 * AbortError, which propagates out of this function. Callers (`useGenerate`)
 * suppress the alert in that case since it's user-initiated.
 */
export async function generateOnce(
  ctx: PipelineCtx,
  signal?: AbortSignal,
): Promise<void> {
  const state = useStore.getState();
  if (state.generationInProgress) return;
  if (
    state.trackingMode === "vlm" &&
    state.trackingActive &&
    !state.vlmModel.trim()
  ) {
    throw new Error("Select a Vision model under Advanced.");
  }

  // 1. Resolve workflow.
  const workflow = resolveWorkflow();
  if (!workflow) {
    throw new Error("No workflow selected.");
  }
  // Sync the Steps input to this workflow's declared default if the
  // rotation just picked a different workflow than the previous run.
  // Has to happen before we read `state.steps` below — but `state` is
  // a stale snapshot captured at function entry, so we read steps fresh
  // from the store inside the POST body.
  syncStepsOnWorkflowChange(workflow);
  const workflowType = determineWorkflowType(workflow);
  // The COM toggle is authoritative for every workflow. Edit and
  // in-/outpainting do not force COM implicitly; the flag alone decides.
  // This keeps placement and crop selection uniform across workflow types.
  const useCOM = state.comMode;

  // Capture the epoch at the start of this generation. If Pull or Clear
  // fires while we're awaiting the backend (or even after the response
  // resolves, before applyResult mutates the canvas), the epoch will
  // diverge — applyResult sees the mismatch and silently drops the
  // result, so the user's focus-shift action takes priority without
  // aborting the network leg or halting the iterative loop.
  const myEpoch = getEpoch();

  useStore.getState().set("generationInProgress", true);

  // Track the generated image's blob URL so the finally can free it. It's
  // only retained past this call in feedback mode (it becomes the new
  // baseImageURL, revoked later by the store's baseImageURL subscription);
  // in every other path — non-feedback, abort, epoch-discard — it's
  // orphaned and must be revoked here or it leaks (createObjectURL pins
  // the PNG in memory until revoked).
  let generatedURL: string | null = null;

  try {
    // 2. Resolve prompt.
    //   Pick a slot from the rotation pool, run its text through
    //   `replaceAllPlaceholders`, and use it. The Generate-button
    //   disabled gate already blocks invalid pools (sum !== 100), so
    //   pickPromptSlot here returns a valid slot. The picked index is
    //   pushed into the store so the panel can highlight that row.
    //   Per-slot vision can first turn the current visual frame into text.
    //   Per-slot auto enhancement may then run in "send" mode (use the
    //   enhanced text for this request only) or "evolve" mode (also write
    //   the enhanced text back into the picked slot).
    let prompt = "";
    const pickedPrompt = pickPromptSlot(state.pinnedPrompts);
    if (pickedPrompt) {
      const slot = useStore.getState().pinnedPrompts[pickedPrompt.index];
      const visionEnabled = promptSlotVisionEnabled(slot);
      prompt = replaceAllPlaceholders(pickedPrompt.text);
      useStore.getState().set("lastPickedPromptIndex", pickedPrompt.index);
      prompt = await maybeDescribeVisionPrompt(
        ctx,
        state,
        useCOM,
        prompt,
        pickedPrompt.index,
        signal,
      );
      if (!visionEnabled) {
        prompt = await maybeAutoEnhancePrompt(
          prompt,
          pickedPrompt.index,
          signal,
        );
      }
      syncDerivedPrompt(pickedPrompt.index, prompt, visionEnabled);
    } else {
      useStore.getState().set("lastPickedPromptIndex", null);
    }

    // 3. Build input image.
    const inputBlob = await buildInput(ctx, state, workflowType, useCOM);

    // 4. POST. `state.steps` would be stale here (snapshot taken before
    // syncStepsOnWorkflowChange may have updated it); re-read from the
    // live store.
    const response = await generateRequest(
      {
        image: inputBlob,
        imageName: imageNameFor(workflowType),
        workflow,
        prompt,
        steps: useStore.getState().steps,
        skipProviderErrors: state.skipProviderErrors,
      },
      signal,
    );
    // The backend swallowed a provider error (Gemini policy refusal etc.)
    // because the user enabled the "skip provider errors" toggle. Bail
    // cleanly — no result to apply, but no exception either, so iterative
    // mode schedules its next tick instead of halting.
    if (response.kind === "skipped") {
      return;
    }
    if (response.kind !== "image") {
      throw new Error("Image workflow returned non-image response.");
    }
    generatedURL = response.objectURL;

    // 5 + 6. Composite + state update. `signal` covers Stop-button
    // abort (genuine cancel, throws AbortError, halts iterative loop).
    // `myEpoch` covers Pull/Clear discard (no abort, no halt, just drop
    // this one result so the user's focus-shift action takes priority).
    await applyResult(
      ctx,
      response.objectURL,
      workflowType,
      useCOM,
      signal,
      myEpoch,
    );

    // 6b. VLM mode: the vision model drives tracking. Now that the freshly
    //     generated frame is on the canvas, ask the VLM for the single most
    //     salient point and store it. `VLMTracker` renders it and
    //     `buildInput` reads it for COM. No-op in every other tracking mode.
    await maybeUpdateVlmPoint(response.objectURL, signal, myEpoch);

    // 7. Auto-cadenced side effects: download then clear. The counter
    //    is `patchesSinceClear` in the store — increments only on a
    //    real apply (skipped / aborted / epoch-discarded runs don't
    //    count), resets to zero whenever the canvas clears (manual or
    //    auto). Download runs before clear so that when both fire on
    //    the same tick, the file saved is the about-to-be-cleared
    //    composite. Thresholds are read fresh from the store so the
    //    user can change the cadence mid-run.
    const newCount = useStore.getState().patchesSinceClear + 1;
    useStore.getState().set("patchesSinceClear", newCount);
    await maybeAutoDownload(newCount);
    await maybeAutoClear(newCount);
  } finally {
    useStore.getState().set("generationInProgress", false);
    // Free the generated blob URL unless it was retained as baseImageURL
    // (feedback mode) — that one is revoked by the store subscription when
    // it's next replaced. Covers non-feedback, abort, and epoch-discard
    // exits where the URL is otherwise orphaned.
    if (
      generatedURL &&
      generatedURL.startsWith("blob:") &&
      useStore.getState().baseImageURL !== generatedURL
    ) {
      const orphaned = generatedURL;
      setTimeout(() => URL.revokeObjectURL(orphaned), 1000);
    }
  }
}

async function maybeAutoDownload(count: number): Promise<void> {
  const every = useStore.getState().autoDownloadEvery;
  if (!every || every <= 0) return;
  if (count % every !== 0) return;
  // Same payload as MainActions's Download button, including optional
  // matte flattening when composite matte is enabled.
  await downloadComposite();
}

async function maybeAutoClear(count: number): Promise<void> {
  const every = useStore.getState().autoClearEvery;
  if (!every || every <= 0) return;
  if (count % every !== 0) return;
  // Pipeline-internal caller: don't touch generationInProgress, the
  // outer try/finally is already managing that flag for this run.
  // `clearAndReseed` resets `patchesSinceClear` itself.
  await clearAndReseed({ resetGenerationInProgress: false });
}

async function maybeAutoEnhancePrompt(
  prompt: string,
  slotIndex: number,
  signal?: AbortSignal,
  options: { writeEvolve?: boolean } = {},
): Promise<string> {
  if (!prompt.trim()) return prompt;

  const mode = promptSlotAutoEnhanceMode(
    useStore.getState().pinnedPrompts[slotIndex],
  );
  if (mode === "off") return prompt;

  const model = useStore.getState().llmModel;
  if (!model.trim()) {
    throw new Error("Select an Ollama model in the prompt settings.");
  }
  const template = useStore.getState().llmEnhancePrompt;
  const enhanced = await new OllamaLLMProvider(model).enhance(
    prompt,
    template,
    signal,
  );
  if (mode === "evolve" && options.writeEvolve !== false) {
    const live = useStore.getState();
    live.set(
      "pinnedPrompts",
      setPromptSlotText(live.pinnedPrompts, slotIndex, enhanced),
    );
  }
  return enhanced;
}

function syncDerivedPrompt(
  slotIndex: number,
  finalPrompt: string,
  visionEnabled: boolean,
): void {
  const live = useStore.getState();
  const mode = promptSlotAutoEnhanceMode(live.pinnedPrompts[slotIndex]);
  const shouldDisplayDerived = visionEnabled || mode === "send";
  const nextDerived = shouldDisplayDerived ? finalPrompt : "";
  const currentDerived = live.pinnedPrompts[slotIndex]?.derivedText ?? "";
  if (currentDerived === nextDerived) return;
  live.set(
    "pinnedPrompts",
    setPromptSlotDerivedText(
      live.pinnedPrompts,
      slotIndex,
      nextDerived,
    ),
  );
}

async function maybeDescribeVisionPrompt(
  ctx: PipelineCtx,
  state: ReturnType<typeof useStore.getState>,
  useCOM: boolean,
  prompt: string,
  slotIndex: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!promptSlotVisionEnabled(useStore.getState().pinnedPrompts[slotIndex])) {
    return prompt;
  }
  if (!prompt.trim()) {
    throw new Error("Vision prompt is empty. Type a VLM instruction such as \"describe\".");
  }

  const model = useStore.getState().vlmModel;
  if (!model.trim()) {
    throw new Error("Select a Vision model under Advanced.");
  }
  const image = await buildVisionInput(ctx, state, useCOM);
  const described = await new OllamaVLMProvider(model).describe(
    image,
    prompt,
    signal,
  );
  return described || prompt;
}

/**
 * Number of times the VLM is asked for a point per generation before giving
 * up: one initial call plus resubmits. Resubmitting helps because the model
 * is non-deterministic enough that a retry can turn an unparseable answer
 * into a clean point.
 */
const VLM_POINT_ATTEMPTS = 3;

/**
 * VLM-mode per-generation step. When the active tracker is VLM and tracking
 * is on, send the just-generated frame to the vision model, parse the single
 * salient point, and store it (normalized). `VLMTracker` renders it and
 * `buildInput` reads it for COM (only observable when the COM toggle is on;
 * VLM mode does not force it). No-op in every other mode.
 *
 * Writing to the store rather than the heatmap directly is deliberate: the
 * tracker re-emits the stored point every tick, so it survives the heatmap
 * clears/rebuilds that a generation triggers — a single direct write would be
 * wiped and, with a passive tracker, never restored.
 *
 * Robustness: bounded resubmit on unparseable responses. Exhausted attempts
 * throw so the UI reports the tracking failure and iterative generation stops.
 * Honors the same abort / epoch guards as `applyResult` so Stop halts and
 * Pull/Clear discards.
 */
async function maybeUpdateVlmPoint(
  outputURL: string,
  signal?: AbortSignal,
  myEpoch?: number,
): Promise<void> {
  const live = useStore.getState();
  if (live.trackingMode !== "vlm" || !live.trackingActive) return;
  if (signal?.aborted) {
    throw new DOMException("Generation aborted before VLM point", "AbortError");
  }
  if (typeof myEpoch === "number" && myEpoch !== getEpoch()) return;
  if (!live.vlmModel.trim()) {
    throw new Error("Select a Vision model under Advanced.");
  }

  // The frame the VLM looks at is the one just applied to the canvas.
  let frame: Blob;
  try {
    const resp = await fetch(outputURL, { signal });
    frame = await resp.blob();
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new Error("VLM tracking could not read the generated frame.");
  }

  const provider = new OllamaVLMProvider(live.vlmModel);
  const instruction = live.vlmPointPrompt;
  let point: VLMPoint | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < VLM_POINT_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      throw new DOMException("Generation aborted before VLM point", "AbortError");
    }
    try {
      point = await provider.point(frame, instruction, signal);
      if (point) break;
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
      console.warn(
        `VLM point attempt ${attempt + 1}/${VLM_POINT_ATTEMPTS} failed.`,
        err,
      );
    }
  }
  if (!point) {
    if (lastError instanceof Error) throw lastError;
    throw new Error(
      `VLM tracking could not parse a point after ${VLM_POINT_ATTEMPTS} attempts.`,
    );
  }

  // Re-check guards after the network round-trip(s).
  if (signal?.aborted) {
    throw new DOMException("Generation aborted before VLM point", "AbortError");
  }
  if (typeof myEpoch === "number" && myEpoch !== getEpoch()) return;

  // Store the normalized point. The tracker renders it (surviving heatmap
  // clears/rebuilds) and buildInput reads it for the next crop's COM.
  useStore.getState().set("vlmPoint", { x: point.x, y: point.y });
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    err.name === "AbortError"
  );
}

export async function buildVisionInput(
  ctx: PipelineCtx,
  state: ReturnType<typeof useStore.getState>,
  useCOM: boolean,
): Promise<Blob> {
  if (!useCOM) {
    return captureVisionFrame({ imageURL: state.baseImageURL });
  }

  const data = ctx.heatmap.getData();
  const com = gazeCOM(data, ctx.containerSize());
  const pos = state.baseImgPosition;
  const centerX = pos.x + com.x * pos.width;
  const centerY = pos.y + com.y * pos.height;
  const sourceCanvas = compositeStore.getCanvas();
  if (sourceCanvas) {
    return captureVisionFrameFromCanvas({
      source: sourceCanvas,
      centerX,
      centerY,
    });
  }
  return captureVisionFrame({ imageURL: state.baseImageURL, centerX, centerY });
}

// ── Steps ──────────────────────────────────────────────────────────────

/**
 * Filename hint sent to the backend with the multipart form. The backend
 * renames internally — this is informational only, but useful for
 * debugging and consistent with legacy. Edit keeps a distinct name because
 * its input is an image-conditioning patch; standard and in-/outpainting
 * use the normal image name.
 */
function imageNameFor(workflowType: WorkflowType): string {
  switch (workflowType) {
    case "edit":
      return "edit_input.png";
    default:
      return "input.png";
  }
}

/**
 * The most recently rotation-picked workflow. Used to decide whether to
 * sync the global Steps input in `syncStepsOnWorkflowChange`. Module-
 * level (sibling pattern to `epoch.ts`) — not UI-reactive, just a memo.
 */
let lastPickedWorkflow: string | null = null;

function resolveWorkflow(): string | null {
  return pickFromPool(useStore.getState().pinnedWorkflows);
}

/**
 * When the rotation picks a workflow different from the previous run,
 * snap Steps to the default declared inside that workflow's {steps:N}
 * placeholder. Same workflow N times in a row keeps the user's override.
 */
function syncStepsOnWorkflowChange(picked: string): void {
  // Always publish the pick to the store so the panel can bold the
  // matching workflow row, even when it doesn't change between runs.
  useStore.getState().set("lastPickedWorkflow", picked);
  if (picked === lastPickedWorkflow) return;
  const descriptor = useStore
    .getState()
    .availableWorkflows.find((workflow) => workflow.path === picked);
  if (descriptor?.default_steps != null) {
    useStore.getState().set("steps", descriptor.default_steps);
  }
  lastPickedWorkflow = picked;
}

export type InputKind =
  | "com-crop"
  | "inpaint-mask"
  | "plain-base"
  | "heatmap-base";

export function inputKindFor(
  workflowType: WorkflowType,
  useCOM: boolean,
): InputKind {
  if (useCOM) return "com-crop";
  if (workflowType === "inpainting") return "inpaint-mask";
  if (workflowType === "edit") return "plain-base";
  return "heatmap-base";
}

export function resolveInputCOM(params: {
  trackingMode: TrackingMode;
  vlmPoint: { x: number; y: number } | null;
  heatmapData: readonly { x: number; y: number; value: number }[];
  containerSize: { width: number; height: number };
}): { x: number; y: number } {
  if (params.trackingMode === "vlm") {
    return params.vlmPoint ?? { x: 0.5, y: 0.5 };
  }
  return gazeCOM(params.heatmapData, params.containerSize);
}

async function buildInput(
  ctx: PipelineCtx,
  state: ReturnType<typeof useStore.getState>,
  workflowType: WorkflowType,
  useCOM: boolean,
): Promise<Blob> {
  const { heatmap, containerSize } = ctx;
  const inputKind = inputKindFor(workflowType, useCOM);

  if (inputKind === "com-crop") {
    // Compute COM and crop the master composite around the corresponding
    // absolute pixel. VLM mode reads its point straight from the store (the
    // single source of truth the tracker also renders) rather than gazeCOM,
    // so COM never lags a heatmap clear/re-emit cycle.
    const pos = state.baseImgPosition;
    const nextSize = { width: pos.width, height: pos.height };
    const firstPatch = state.firstPatchPosition ?? pos;
    const bounds = deriveCompositeBounds(
      {
        enabled: state.compositeMode && state.boundsEnabled,
        width: state.boundsWidth,
        height: state.boundsHeight,
      },
      firstPatch,
      nextSize,
    );
    const rawCOM = resolveInputCOM({
      trackingMode: state.trackingMode,
      vlmPoint: useStore.getState().vlmPoint,
      heatmapData: heatmap.getData(),
      containerSize: containerSize(),
    });
    const com = clampCOMToBounds(rawCOM, bounds, pos, nextSize);
    useStore.getState().set("baseCOM", com);

    const centerX = pos.x + com.x * pos.width;
    const centerY = pos.y + com.y * pos.height;

    const sourceCanvas = compositeStore.getCanvas();
    let cropBlob = sourceCanvas
      ? await cropAroundCanvasPoint({
          source: sourceCanvas,
          centerX,
          centerY,
          applyHeatmapMask: workflowType === "inpainting",
          heatmap,
        })
      : await cropAroundPoint({
          imageURL: state.baseImageURL,
          centerX,
          centerY,
          applyHeatmapMask: workflowType === "inpainting",
          heatmap,
        });

    // Standard/edit pipelines are img2img/image-conditioning inputs, not
    // alpha-mask inputs. Flatten transparent crop edges onto the visible frame
    // background so Comfy doesn't interpret missing pixels as black.
    if (workflowType === "standard" || workflowType === "edit") {
      cropBlob = await flattenAlphaOnBg(cropBlob);
    }

    // Input preview (legacy image-processor.js:486-494): when feedback is
    // on, show the cropped 1024² region as the heatmap pane's background
    // so the user sees what the AI received. For edit, that's the flattened
    // (RGB) version — same blob we just sent.
    if (workflowType === "edit" && state.feedbackMode) {
      const previewURL = URL.createObjectURL(cropBlob);
      // The previous baseImageURL blob (if any) is freed by the
      // baseImageURL subscription in the store module.
      useStore.getState().set("baseImageURL", previewURL);
    }

    return cropBlob;
  }

  if (inputKind === "inpaint-mask") {
    return buildInpaintingMask({
      baseImageURL: state.baseImageURL,
      heatmap,
    });
  }

  if (inputKind === "plain-base") {
    return captureBasePatch({ baseImageURL: state.baseImageURL });
  }

  // Standard, non-COM: capture base + heatmap.
  return captureHeatmapOnBase({ baseImageURL: state.baseImageURL, heatmap });
}

async function applyResult(
  _ctx: PipelineCtx,
  newImageURL: string,
  workflowType: WorkflowType,
  useCOM: boolean,
  signal?: AbortSignal,
  myEpoch?: number,
): Promise<void> {
  // Two distinct bail-outs:
  //   - signal.aborted: Stop button was pressed. Throw AbortError so
  //     the iterative loop catches it and halts.
  //   - myEpoch !== getEpoch(): Pull or Clear bumped the epoch while
  //     this generation was in flight. Return silently — generation
  //     completes "successfully" from the loop's POV, so iterative
  //     continues against the now-mutated state, but the result is
  //     dropped before touching the canvas or store.
  if (signal?.aborted) {
    throw new DOMException("Generation aborted before apply", "AbortError");
  }
  if (typeof myEpoch === "number" && myEpoch !== getEpoch()) {
    return;
  }
  const state = useStore.getState();
  const newImg = await loadImageEl(newImageURL);
  // Re-check after the image-decode await — Pull/Clear could fire
  // during the decode, and we'd rather know now than after touching
  // compositeStore.
  if (signal?.aborted) {
    throw new DOMException("Generation aborted before apply", "AbortError");
  }
  if (typeof myEpoch === "number" && myEpoch !== getEpoch()) {
    return;
  }

  if (!state.compositeMode) {
    // Simple mode — the new patch IS the new master. Reset the canvas
    // backing store so subsequent composite-mode toggles start fresh.
    await compositeStore.setFromImageURL(newImageURL);
    const seedBox = {
      x: 0,
      y: 0,
      width: newImg.naturalWidth,
      height: newImg.naturalHeight,
    };
    const simplePatch: Partial<typeof state> = {
      baseImgPosition: seedBox,
      // Seed the bounds anchor too — if the user later toggles composite
      // mode on, the first growth iteration uses this as its reference.
      firstPatchPosition: seedBox,
      isComposited: false,
    };
    if (state.feedbackMode) simplePatch.baseImageURL = newImageURL;
    useStore.getState().patch(simplePatch);
    return;
  }

  // Composite mode: stitch onto the live backing canvas (no PNG round-trip).
  const prevCanvas = compositeStore.getCanvas();
  if (!prevCanvas) {
    // First-ever generation with empty canvas — seed from the new patch
    // and record its position as the canvas-bounds anchor (initial value;
    // every subsequent compositeShift translates this point so the bounds
    // box stays glued to where the user actually started).
    await compositeStore.setFromImageURL(newImageURL);
    const seedBox = {
      x: 0,
      y: 0,
      width: newImg.naturalWidth,
      height: newImg.naturalHeight,
    };
    const firstPatch: Partial<typeof state> = {
      baseImgPosition: seedBox,
      firstPatchPosition: seedBox,
      isComposited: false,
    };
    if (state.feedbackMode) firstPatch.baseImageURL = newImageURL;
    useStore.getState().patch(firstPatch);
    return;
  }

  // Lazy-init the bounds anchor: the pipeline's empty-canvas branch sets
  // `firstPatchPosition` only when generation runs into a literally empty
  // composite store. When the user seeds the canvas via a reference-image
  // selection (ControlPanel.tsx:144) or any other pre-population route,
  // we'd otherwise reach here with `firstPatchPosition === null` and
  // `deriveBounds` would silently no-op. Treating the current
  // `baseImgPosition` as the anchor at the moment of the first growth
  // covers every seed path uniformly without coupling each seed callsite
  // to the bounds concept.
  const firstPatch = state.firstPatchPosition ?? state.baseImgPosition;
  const nextSize = { width: newImg.naturalWidth, height: newImg.naturalHeight };
  const bounds = deriveCompositeBounds(
    {
      enabled: state.boundsEnabled,
      width: state.boundsWidth,
      height: state.boundsHeight,
    },
    firstPatch,
    nextSize,
  );
  // buildInput already clamps against the expected patch size so the crop and
  // placement share an anchor. Clamp once more with the actual output size to
  // keep unusual workflows from placing a differently-sized result outside.
  const placementCOM = useCOM
    ? clampCOMToBounds(state.baseCOM, bounds, state.baseImgPosition, nextSize)
    : state.baseCOM;
  if (
    placementCOM.x !== state.baseCOM.x ||
    placementCOM.y !== state.baseCOM.y
  ) {
    useStore.getState().set("baseCOM", placementCOM);
  }
  const plan = planComposite({
    prevSize: { width: prevCanvas.width, height: prevCanvas.height },
    prevPosition: state.baseImgPosition,
    newSize: nextSize,
    newCOM: placementCOM,
    workflow: workflowType,
    useCOM,
    bounds,
  });
  const newCanvas = applyPlan(plan, prevCanvas, newImg);
  await compositeStore.setCanvas(newCanvas);

  // Notify subscribers (PullTool) that the canvas coordinate frame moved.
  // Positive shift means left/up growth; negative shift means bounds clipped
  // pixels from the left/top. Anything anchored in image-space needs to move
  // by the same amount to stay attached.
  if (plan.coordinateShift.x !== 0 || plan.coordinateShift.y !== 0) {
    window.dispatchEvent(
      new CustomEvent("gz-composite-shift", {
        detail: { coordinateShift: plan.coordinateShift },
      }),
    );
  }

  // Feedback-mode semantics (legacy generation-engine.js:497-503): when ON
  // (the default), the next iteration tracks against the new generation.
  // When OFF, the next iteration keeps tracking against whatever baseImageURL
  // was — typically the user's chosen input.
  const patch: Partial<typeof state> = {
    baseImgPosition: plan.newPosition,
    isComposited: true,
  };
  if (state.feedbackMode) {
    patch.baseImageURL = newImageURL;
  }
  // The firstPatchPosition (bounds anchor) gets translated by every
  // coordinate-frame shift — same trick PullTool's bbox does, but committed
  // through the store since this is application state, not a local ref.
  // We also commit the lazy-init value here when applicable, so the
  // next iteration sees it set rather than re-deriving every time.
  const wasLazyInit = state.firstPatchPosition === null;
  if (
    wasLazyInit ||
    plan.coordinateShift.x !== 0 ||
    plan.coordinateShift.y !== 0
  ) {
    patch.firstPatchPosition = {
      x: firstPatch.x + plan.coordinateShift.x,
      y: firstPatch.y + plan.coordinateShift.y,
      width: firstPatch.width,
      height: firstPatch.height,
    };
  }
  useStore.getState().patch(patch);
}

function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith("data:") && !src.startsWith("blob:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src.slice(0, 80)}`));
    img.src = src;
  });
}
