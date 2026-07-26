/**
 * Single generation entry point.
 *
 * Replaces the near-duplicate methods at legacy
 * generation-engine.js:303-493 (standard, masked, and COM-cropped paths).
 * Branches are now data-driven by `{ workflowType, useCOM }`.
 *
 * Pipeline:
 *   1. Resolve workflow (random-weighted or current selection).
 *   2. Resolve prompt text through Guide Rotate, Select, Compose, or Hybrid.
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
  deriveCOMBounds,
  deriveCompositeMaxSize,
} from "../canvas/CompositeBounds";
import { compositeStore } from "../canvas/CompositeStore";
import { PULL_PATCH_SIZE, pullHandle } from "../canvas/pullHandle";
import { clearAndReseed } from "../canvas/clearAndReseed";
import { downloadComposite } from "../canvas/downloadComposite";
import { gazeCOM } from "../canvas/Heatmap";
import {
  pickPromptSlot,
  promptSlotMuted,
  promptSlotAutoEnhanceMode,
  promptSlotVisionEnabled,
  replaceAllPlaceholders,
  selectablePromptSlots,
  setPromptSlotDerivedText,
  setPromptSlotText,
  type PromptSlots,
} from "../prompts";
import {
  useStore,
  type OllamaThinkingMode,
  type TrackingMode,
  type VLMCanvasAction,
  type VLMComposeAction,
  type VLMGuidePromptChoice,
  type VLMHybridSelectAction,
  type VLMHybridWriteAction,
  type VLMSelectAction,
} from "../store";
import {
  generateRequest,
  type OllamaThink,
  type VLMComposeDecision,
  type VLMGuideDecision,
  type VLMHybridHistoryItem,
  type VLMPoint,
  type VLMSelectHistoryItem,
} from "./api";
import {
  captureBasePatch,
  buildInpaintingMask,
  captureHeatmapOnBase,
  captureVisionFrame,
  captureVisionFrameFromCanvas,
  captureVisionCanvas,
  cropAroundCanvasPoint,
  cropAroundPoint,
  flattenAlphaOnBg,
} from "./captureHeatmap";
import { getEpoch } from "./epoch";
import { OllamaLLMProvider, OllamaVLMProvider } from "./llm";
import {
  activePool,
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
  const canvasVlmSelected =
    state.trackingMode === "vlm" && state.vlmBehavior === "guide";
  const canvasVlmActive =
    canvasVlmSelected && state.trackingActive;
  const composeActive =
    state.trackingMode === "vlm" &&
    state.vlmBehavior === "guide" &&
    state.vlmGuidePromptChoice === "compose" &&
    state.trackingActive;
  const selectActive =
    state.trackingMode === "vlm" &&
    state.vlmBehavior === "guide" &&
    state.vlmGuidePromptChoice === "select" &&
    state.trackingActive;
  if (canvasVlmSelected && !state.trackingActive) {
    throw new Error("Start VLM Guide tracking before generating.");
  }
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
  // Guide is a deliberate exception: its chosen coordinates are the COM input
  // and its output must be composited for the next decision.
  const useCOM = state.comMode || canvasVlmActive;

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
    // 2. Resolve canvas guidance, then the generation prompt.
    //   Guide chooses the next Pull location from the complete canvas. Rotate
    //   uses the weighted pool, Select carries an exact pool choice, Compose
    //   writes the prompt, and Hybrid chooses between the latter two.
    //   Resolve the location first so the prompt is selected from fresh state
    //   after the potentially slow VLM request.
    if (canvasVlmActive) {
      const ready = await ensureCanvasAction(signal, myEpoch);
      if (!ready) return;
    }

    //   Pick a slot from the rotation pool, run its text through
    //   `replaceAllPlaceholders`, and use it. The Generate-button
    //   disabled gate blocks pools without an eligible slot, while this
    //   defensive check also catches a pool changed during iterative mode.
    //   Relative weights are normalized implicitly during selection. The
    //   picked index is pushed into the store so the panel can highlight it.
    //   Per-slot auto enhancement runs first: "send" uses the enhanced text
    //   for this request, while "evolve" also writes it back into the slot.
    //   Vision then uses that resulting text as its image instruction and
    //   returns the final generation prompt without further LLM processing.
    let prompt: string;
    const promptChoice = useStore.getState().vlmGuidePromptChoice;
    const pendingAction = canvasVlmActive
      ? useStore.getState().vlmGuideAction
      : null;
    const authoredAction =
      pendingAction && isAuthoredAction(pendingAction)
        ? pendingAction
        : null;
    const usesAuthoredPrompt =
      composeActive ||
      (promptChoice === "hybrid" &&
        authoredAction !== null &&
        isHybridAction(authoredAction) &&
        authoredAction.hybridSource === "write");
    if (usesAuthoredPrompt) {
      useStore.getState().set("lastPickedPromptIndex", null);
      if (!authoredAction?.instruction.trim()) {
        throw new Error("VLM Compose did not provide an edit instruction.");
      }
      prompt = authoredAction.instruction.trim();
    } else {
      const promptState = useStore.getState();
      const selectedAction =
        selectActive ||
        (promptChoice === "hybrid" &&
          pendingAction !== null &&
          isHybridAction(pendingAction) &&
          pendingAction.hybridSource === "pool")
          ? promptState.vlmGuideAction
          : null;
      const selectedByVlm =
        selectedAction !== null && isSelectAction(selectedAction);
      const pickedPrompt = selectedByVlm
        ? selectedAction && isSelectAction(selectedAction)
          ? {
              text: selectedAction.promptText,
              index: selectedAction.promptSlotIndex,
            }
          : null
        : pickPromptSlot(promptState.pinnedPrompts);
      if (!pickedPrompt) {
        useStore.getState().set("lastPickedPromptIndex", null);
        throw new Error(
          promptChoice === "select"
            ? "Unmute at least one prompt slot for Guide Select."
            : promptChoice === "hybrid"
              ? "VLM Hybrid did not return a usable prompt."
              : "Unmute a prompt slot or give one a weight above 0.",
        );
      }
      const slot = useStore.getState().pinnedPrompts[pickedPrompt.index];
      const visionEnabled = promptSlotVisionEnabled(slot);
      const autoEnhanceMode = promptSlotAutoEnhanceMode(slot);
      // Select candidates are placeholder-resolved before the VLM evaluates
      // them, so generation must use that exact snapshot. Rotate resolves only
      // the slot it picked, preserving its existing behavior.
      prompt = selectedByVlm
        ? pickedPrompt.text
        : replaceAllPlaceholders(pickedPrompt.text);
      useStore.getState().set("lastPickedPromptIndex", pickedPrompt.index);
      prompt = await resolvePromptTransforms(
        prompt,
        visionEnabled,
        (text) => maybeAutoEnhancePrompt(text, pickedPrompt.index, signal),
        (text) =>
          maybeDescribeVisionPrompt(
            ctx,
            promptState,
            useCOM,
            text,
            pickedPrompt.index,
            signal,
          ),
        autoEnhanceMode === "off"
          ? undefined
          : (text) => syncDerivedPrompt(pickedPrompt.index, text, true),
      );
      syncDerivedPrompt(pickedPrompt.index, prompt, visionEnabled);
      if (selectedByVlm) {
        const pending = useStore.getState().vlmGuideAction;
        if (pending && isSelectAction(pending)) {
          useStore.getState().set("vlmGuideAction", {
            ...pending,
            appliedPromptText: prompt,
          });
        }
      }
    }

    // 3. Build input image.
    // Guide bootstrap may have created a bounded workspace and moved Pull,
    // so its image geometry must be read after that asynchronous decision.
    const generationState = useStore.getState();
    const inputBlob = await buildInput(
      ctx,
      generationState,
      workflowType,
      useCOM,
    );

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
        skipProviderErrors: generationState.skipProviderErrors,
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
    const completedCanvasAction = canvasVlmActive
      ? useStore.getState().vlmGuideAction
      : null;
    const applied = await applyResult(
      ctx,
      response.objectURL,
      workflowType,
      useCOM,
      signal,
      myEpoch,
    );
    if (!applied) return;
    if (completedCanvasAction) {
      const live = useStore.getState();
      const history =
        live.vlmGuideHistoryLimit === 0
          ? []
          : [...live.vlmGuideHistory, completedCanvasAction].slice(
              -live.vlmGuideHistoryLimit,
            );
      live.patch({
        vlmGuideAction: null,
        vlmGuideHistory: history,
      });
    }

    // 6b. VLM mode: ask for the next point after applying the result. Frame
    //     scope stores a local COM; Canvas scope centers Pull on the returned
    //     composite coordinate and makes that crop the next working frame.
    await maybeUpdateVlmTracking(response.objectURL, signal, myEpoch);

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

/** Apply automatic prompt transforms in their required semantic order. */
export async function resolvePromptTransforms(
  prompt: string,
  visionEnabled: boolean,
  enhance: (prompt: string) => Promise<string>,
  describe: (prompt: string) => Promise<string>,
  onEnhanced?: (prompt: string) => void,
): Promise<string> {
  const enhanced = await enhance(prompt);
  if (!visionEnabled) return enhanced;
  onEnhanced?.(enhanced);
  return describe(enhanced);
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
  const live = useStore.getState();
  const enhanced = await new OllamaLLMProvider(
    model,
    ollamaThinkFor(model, live.llmThinkingMode),
  ).enhance(
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
  const live = useStore.getState();
  const described = await new OllamaVLMProvider(
    model,
    ollamaThinkFor(model, live.vlmThinkingMode),
  ).describe(
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
const VLM_GUIDE_ATTEMPTS = 3;
const MAX_GUIDE_WORKSPACE_PIXELS = 4096 * 4096;

function ollamaThinkFor(
  model: string,
  mode: OllamaThinkingMode,
): OllamaThink | undefined {
  const modes = useStore.getState().ollamaModelThinkingModes[model] ?? [];
  if (!modes.includes(mode)) return undefined;
  if (mode === "off") return false;
  if (mode === "on") return true;
  return mode;
}

async function ensureCanvasAction(
  signal?: AbortSignal,
  myEpoch?: number,
  staleRetry = 0,
): Promise<boolean> {
  const pending = useStore.getState().vlmGuideAction;
  if (pending && pendingActionMatchesState(pending)) return true;
  if (pending) useStore.getState().set("vlmGuideAction", null);
  await prepareGuideWorkspace();
  if (signal?.aborted) {
    throw new DOMException(
      "Generation aborted before VLM canvas decision",
      "AbortError",
    );
  }
  if (typeof myEpoch === "number" && myEpoch !== getEpoch()) return false;

  const canvas = compositeStore.getCanvas();
  if (!canvas) {
    throw new Error("VLM Guide requires an active canvas.");
  }
  const behavior = useStore.getState().vlmBehavior;
  if (behavior === "point") return false;
  const guidePromptChoice = useStore.getState().vlmGuidePromptChoice;
  const action = await requestGuideDecision(canvas, guidePromptChoice, signal);
  if (signal?.aborted) {
    throw new DOMException(
      "Generation aborted before VLM canvas decision",
      "AbortError",
    );
  }
  if (typeof myEpoch === "number" && myEpoch !== getEpoch()) return false;
  const live = useStore.getState();
  if (
    live.trackingMode !== "vlm" ||
    live.vlmBehavior !== "guide" ||
    live.vlmGuidePromptChoice !== guidePromptChoice ||
    !live.trackingActive
  ) {
    return false;
  }
  if (!pendingActionMatchesState(action)) {
    if (staleRetry >= 1) {
      throw new Error(
        "Guide prompt pool changed repeatedly during its decision.",
      );
    }
    return ensureCanvasAction(signal, myEpoch, staleRetry + 1);
  }
  await applyGuideDecision(
    action,
    {
      width: canvas.width,
      height: canvas.height,
    },
  );
  return true;
}

async function prepareGuideWorkspace(): Promise<void> {
  const state = useStore.getState();
  const source = compositeStore.getCanvas();

  if (!state.boundsEnabled) {
    if (!source) {
      const blank = document.createElement("canvas");
      blank.width = blank.height = PULL_PATCH_SIZE;
      await compositeStore.setCanvas(blank);
      useStore.getState().patch({
        baseImgPosition: {
          x: 0,
          y: 0,
          width: PULL_PATCH_SIZE,
          height: PULL_PATCH_SIZE,
        },
      });
    }
    useStore.getState().patch({
      comMode: true,
      compositeMode: true,
      vlmGuideWorkspaceReady: true,
    });
    return;
  }

  const width = Math.max(PULL_PATCH_SIZE, Math.round(state.boundsWidth));
  const height = Math.max(PULL_PATCH_SIZE, Math.round(state.boundsHeight));
  if (width * height > MAX_GUIDE_WORKSPACE_PIXELS) {
    throw new Error(
      "VLM Guide workspace is too large to allocate safely. " +
        "Use canvas limits no larger than 4096 x 4096.",
    );
  }
  if (
    state.vlmGuideWorkspaceReady &&
    source?.width === width &&
    source.height === height
  ) {
    useStore.getState().patch({ comMode: true, compositeMode: true });
    return;
  }

  const workspace = document.createElement("canvas");
  workspace.width = width;
  workspace.height = height;
  const ctx = workspace.getContext("2d");
  if (!ctx) {
    throw new Error("VLM Guide could not create its bounded workspace.");
  }

  const offset = source
    ? {
        x: Math.round((width - source.width) / 2),
        y: Math.round((height - source.height) / 2),
      }
    : {
        x: Math.round((width - PULL_PATCH_SIZE) / 2),
        y: Math.round((height - PULL_PATCH_SIZE) / 2),
      };
  if (source) ctx.drawImage(source, offset.x, offset.y);
  await compositeStore.setCanvas(workspace);

  const shiftBox = (box: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => ({
    ...box,
    x: box.x + offset.x,
    y: box.y + offset.y,
  });
  const baseImgPosition =
    state.baseImgPosition.width > 0 && state.baseImgPosition.height > 0
      ? shiftBox(state.baseImgPosition)
      : {
          x: offset.x,
          y: offset.y,
          width: PULL_PATCH_SIZE,
          height: PULL_PATCH_SIZE,
        };
  useStore.getState().patch({
    baseImgPosition,
    firstPatchPosition: state.firstPatchPosition
      ? shiftBox(state.firstPatchPosition)
      : null,
    comMode: true,
    compositeMode: true,
    vlmGuideAction: null,
    vlmGuideWorkspaceReady: true,
  });
}

export function renderGuidePrompt(
  template: string,
  canvasSize: { width: number; height: number },
  bounds: { enabled: boolean; width: number; height: number },
): string {
  const canvasLimit = bounds.enabled
    ? `The workspace is limited to ${bounds.width} x ${bounds.height} pixels; ` +
      "content outside it is clipped."
    : "The canvas has no fixed outer boundary; choosing an edge lets the next " +
      "crop expand it.";
  return template
    .replaceAll("{crop_size}", String(PULL_PATCH_SIZE))
    .replaceAll("{canvas_width}", String(canvasSize.width))
    .replaceAll("{canvas_height}", String(canvasSize.height))
    .replaceAll("{max_width}", bounds.enabled ? String(bounds.width) : "unbounded")
    .replaceAll(
      "{max_height}",
      bounds.enabled ? String(bounds.height) : "unbounded",
    )
    .replaceAll("{canvas_limit}", canvasLimit);
}

export interface VLMRotatePromptContextEntry {
  probability: number;
  prompt: string;
}

export function buildRotatePromptContext(
  slots: PromptSlots,
): VLMRotatePromptContextEntry[] {
  const active = slots.filter(
    (slot) => !promptSlotMuted(slot) && slot.weight > 0,
  );
  const total = active.reduce((sum, slot) => sum + slot.weight, 0);
  if (total <= 0) return [];

  return active.map((slot) => ({
    probability: Math.round((slot.weight / total) * 1_000_000) / 1_000_000,
    prompt: slot.text,
  }));
}

export function renderRotatePrompt(
  template: string,
  slots: PromptSlots,
  includePoolContext: boolean,
  canvasSize: { width: number; height: number },
  bounds: { enabled: boolean; width: number; height: number },
): string {
  const prompt = renderGuidePrompt(template, canvasSize, bounds);
  if (!includePoolContext) return prompt;

  const context = JSON.stringify(buildRotatePromptContext(slots), null, 2);
  return (
    "The following active weighted prompts collectively shape the image. " +
    "You do not choose a prompt; another process selects one after you choose " +
    "the coordinate. Use this pool only as context for deciding which area is " +
    "most relevant to work on next.\n\nPrompt pool:\n" +
    context +
    "\n\n" +
    prompt
  );
}

export interface VLMSelectPromptCandidate {
  id: number;
  slotIndex: number;
  sourceText: string;
  slotSignature: string;
  prompt: string;
}

function selectPromptSlotSignature(
  slot: PromptSlots[number],
): string {
  return JSON.stringify([
    slot.text,
    promptSlotAutoEnhanceMode(slot),
    promptSlotVisionEnabled(slot),
  ]);
}

export function buildSelectPromptCandidates(
  slots: PromptSlots,
): VLMSelectPromptCandidate[] {
  return selectablePromptSlots(slots).map(({ text, index }) => {
    const slot = slots[index];
    return {
      id: index + 1,
      slotIndex: index,
      sourceText: text,
      slotSignature: selectPromptSlotSignature(slot),
      prompt: replaceAllPlaceholders(text),
    };
  });
}

export function renderPromptPoolTemplate(
  template: string,
  candidates: readonly VLMSelectPromptCandidate[],
  canvasSize: { width: number; height: number },
  bounds: { enabled: boolean; width: number; height: number },
): string {
  if (!template.includes("{prompt_pool}")) {
    throw new Error(
      'VLM prompt must include the "{prompt_pool}" placeholder.',
    );
  }
  const promptPool = JSON.stringify(
    candidates.map(({ id, prompt }) => ({ id, prompt })),
    null,
    2,
  );
  return renderGuidePrompt(template, canvasSize, bounds).replaceAll(
    "{prompt_pool}",
    promptPool,
  );
}

async function requestGuideDecision(
  canvas: HTMLCanvasElement,
  choice: VLMGuidePromptChoice,
  signal?: AbortSignal,
): Promise<VLMCanvasAction> {
  const live = useStore.getState();
  if (!live.vlmModel.trim()) {
    throw new Error("Select a Vision model under Advanced.");
  }
  const template = (
    choice === "select"
      ? live.vlmSelectPrompt
      : choice === "compose"
        ? live.vlmComposePrompt
        : choice === "hybrid"
          ? live.vlmHybridPrompt
          : live.vlmGuidePrompt
  ).trim();
  if (!template) {
    throw new Error(`VLM ${guideChoiceLabel(choice)} prompt is empty.`);
  }
  const canvasSize = { width: canvas.width, height: canvas.height };
  const bounds = {
    enabled: live.boundsEnabled,
    width: Math.max(PULL_PATCH_SIZE, Math.round(live.boundsWidth)),
    height: Math.max(PULL_PATCH_SIZE, Math.round(live.boundsHeight)),
  };
  const usesPromptPool = choice === "select" || choice === "hybrid";
  const candidates = usesPromptPool
    ? buildSelectPromptCandidates(live.pinnedPrompts)
    : [];
  if (choice === "select" && candidates.length === 0) {
    throw new Error("Unmute at least one prompt slot for Guide Select.");
  }
  const instruction =
    choice === "rotate"
      ? renderRotatePrompt(
          template,
          live.pinnedPrompts,
          live.vlmRotatePoolContext,
          canvasSize,
          bounds,
        )
      : usesPromptPool
        ? renderPromptPoolTemplate(template, candidates, canvasSize, bounds)
        : renderGuidePrompt(template, canvasSize, bounds);
  const frame = await captureVisionCanvas({ source: canvas });
  const provider = new OllamaVLMProvider(
    live.vlmModel,
    ollamaThinkFor(live.vlmModel, live.vlmThinkingMode),
  );
  let lastError: unknown = null;
  for (let attempt = 0; attempt < VLM_GUIDE_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      throw new DOMException(
        "Generation aborted before VLM Guide decision",
        "AbortError",
      );
    }
    try {
      const rawHistory =
        live.vlmGuideHistoryLimit === 0 ? [] : live.vlmGuideHistory;
      if (choice === "compose") {
        const decision = await provider.compose(
          frame,
          instruction,
          rawHistory
            .filter(isComposeAction)
            .map<VLMComposeDecision>(({ x, y, instruction }) => ({
              x,
              y,
              instruction,
            })),
          signal,
        );
        if (decision) {
          return {
            x: decision.x,
            y: decision.y,
            instruction: decision.instruction.trim(),
          };
        }
      } else if (choice === "select") {
        const decision = await provider.select(
          frame,
          instruction,
          candidates.map(({ id }) => id),
          rawHistory
            .filter(isPureSelectAction)
            .map<VLMSelectHistoryItem>((action) => ({
              x: action.x,
              y: action.y,
              prompt_id: action.promptId,
              prompt: action.appliedPromptText ?? action.promptText,
            })),
          signal,
        );
        if (decision) {
          const candidate = candidates.find(
            ({ id }) => id === decision.prompt_id,
          );
          if (!candidate) {
            throw new Error(
              `VLM Select returned unknown prompt ID ${decision.prompt_id}.`,
            );
          }
          return {
            x: decision.x,
            y: decision.y,
            promptId: candidate.id,
            promptSlotIndex: candidate.slotIndex,
            promptSourceText: candidate.sourceText,
            promptSlotSignature: candidate.slotSignature,
            promptText: candidate.prompt,
          };
        }
      } else if (choice === "hybrid") {
        const decision = await provider.hybrid(
          frame,
          instruction,
          candidates.map(({ id }) => id),
          rawHistory
            .filter(isHybridAction)
            .map<VLMHybridHistoryItem>((action) => ({
              x: action.x,
              y: action.y,
              source: action.hybridSource,
              prompt_id:
                action.hybridSource === "pool" ? action.promptId : 0,
              instruction:
                action.hybridSource === "write" ? action.instruction : "",
              prompt:
                action.hybridSource === "pool"
                  ? action.appliedPromptText ?? action.promptText
                  : action.instruction,
            })),
          signal,
        );
        if (decision?.source === "write") {
          return {
            x: decision.x,
            y: decision.y,
            hybridSource: "write",
            promptId: 0,
            instruction: decision.instruction.trim(),
          };
        }
        if (decision?.source === "pool") {
          const candidate = candidates.find(
            ({ id }) => id === decision.prompt_id,
          );
          if (!candidate) {
            throw new Error(
              `VLM Hybrid returned unknown prompt ID ${decision.prompt_id}.`,
            );
          }
          return {
            x: decision.x,
            y: decision.y,
            hybridSource: "pool",
            promptId: candidate.id,
            promptSlotIndex: candidate.slotIndex,
            promptSourceText: candidate.sourceText,
            promptSlotSignature: candidate.slotSignature,
            promptText: candidate.prompt,
          };
        }
      } else {
        const decision: VLMGuideDecision | null = await provider.guide(
          frame,
          instruction,
          rawHistory.map(({ x, y }) => ({ x, y })),
          signal,
        );
        if (decision) return { x: decision.x, y: decision.y };
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
      console.warn(
        `VLM ${guideChoiceLabel(choice)} attempt ${attempt + 1}/${VLM_GUIDE_ATTEMPTS} failed.`,
        err,
      );
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(
    `VLM ${guideChoiceLabel(choice)} returned no valid decision after ${VLM_GUIDE_ATTEMPTS} attempts.`,
  );
}

function guideChoiceLabel(choice: VLMGuidePromptChoice): string {
  return choice[0].toUpperCase() + choice.slice(1);
}

function isSelectAction(action: VLMCanvasAction): action is VLMSelectAction {
  return "promptSlotIndex" in action;
}

function isHybridAction(
  action: VLMCanvasAction,
): action is VLMHybridSelectAction | VLMHybridWriteAction {
  return "hybridSource" in action;
}

function isPureSelectAction(action: VLMCanvasAction): action is VLMSelectAction {
  return isSelectAction(action) && !isHybridAction(action);
}

function isComposeAction(action: VLMCanvasAction): action is VLMComposeAction {
  return isAuthoredAction(action) && !isHybridAction(action);
}

function isAuthoredAction(
  action: VLMCanvasAction,
): action is VLMComposeAction | VLMHybridWriteAction {
  return (
    "instruction" in action &&
    typeof action.instruction === "string"
  );
}

function selectedActionMatchesState(action: VLMSelectAction): boolean {
  const slot = useStore.getState().pinnedPrompts[action.promptSlotIndex];
  return (
    Boolean(slot) &&
    !promptSlotMuted(slot) &&
    slot.text === action.promptSourceText &&
    selectPromptSlotSignature(slot) === action.promptSlotSignature
  );
}

function pendingActionMatchesState(action: VLMCanvasAction): boolean {
  const live = useStore.getState();
  if (live.vlmBehavior !== "guide") return false;
  switch (live.vlmGuidePromptChoice) {
    case "rotate":
      return (
        !("instruction" in action) &&
        !isSelectAction(action) &&
        !isHybridAction(action)
      );
    case "select":
      return isPureSelectAction(action) && selectedActionMatchesState(action);
    case "compose":
      return isComposeAction(action) && Boolean(action.instruction.trim());
    case "hybrid":
      if (!isHybridAction(action)) return false;
      return action.hybridSource === "write"
        ? Boolean(action.instruction.trim())
        : selectedActionMatchesState(action);
  }
}

async function applyGuideDecision(
  action: VLMCanvasAction,
  canvasSize: { width: number; height: number },
): Promise<void> {
  const normalized = { ...action, x: clamp01(action.x), y: clamp01(action.y) };
  if ("instruction" in normalized && !normalized.instruction.trim()) {
    throw new Error("VLM Compose returned an empty edit instruction.");
  }
  await pullHandle.triggerAt(
    pullPositionForCanvasPoint(normalized, canvasSize),
  );
  useStore.getState().patch({
    vlmGuideAction: normalized,
    // Pull centers the selected canvas coordinate in the local generation frame.
    vlmPoint: { x: 0.5, y: 0.5 },
  });
}

/**
 * VLM-mode per-generation step. Point behavior keeps its existing frame/canvas
 * policies. Guide always reads the complete current canvas and chooses the Pull
 * location. Its prompt strategy may rotate, select, compose, or choose between
 * selecting and composing.
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
async function maybeUpdateVlmTracking(
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

  if (live.vlmBehavior !== "point") {
    const guidePromptChoice = live.vlmGuidePromptChoice;
    const canvas = compositeStore.getCanvas();
    if (!canvas) {
      throw new Error("VLM Guide requires an active composite.");
    }
    const canvasSize = { width: canvas.width, height: canvas.height };
    let nextAction = await requestGuideDecision(
      canvas,
      guidePromptChoice,
      signal,
    );
    if (signal?.aborted) {
      throw new DOMException(
        "Generation aborted before VLM canvas decision",
        "AbortError",
      );
    }
    if (typeof myEpoch === "number" && myEpoch !== getEpoch()) return;
    const current = useStore.getState();
    if (
      current.trackingMode !== "vlm" ||
      current.vlmBehavior !== "guide" ||
      current.vlmGuidePromptChoice !== guidePromptChoice ||
      !current.trackingActive
    ) {
      return;
    }
    if (!pendingActionMatchesState(nextAction)) {
      nextAction = await requestGuideDecision(
        canvas,
        guidePromptChoice,
        signal,
      );
      if (signal?.aborted) {
        throw new DOMException(
          "Generation aborted before refreshed VLM canvas decision",
          "AbortError",
        );
      }
      if (typeof myEpoch === "number" && myEpoch !== getEpoch()) return;
      const refreshed = useStore.getState();
      if (
        refreshed.trackingMode !== "vlm" ||
        refreshed.vlmBehavior !== "guide" ||
        refreshed.vlmGuidePromptChoice !== guidePromptChoice ||
        !refreshed.trackingActive
      ) {
        return;
      }
      if (!pendingActionMatchesState(nextAction)) {
        throw new Error(
          "Guide prompt pool changed repeatedly during its decision.",
        );
      }
    }
    await applyGuideDecision(nextAction, canvasSize);
    return;
  }

  const scope = live.vlmScope;
  const canvas = scope === "canvas" ? compositeStore.getCanvas() : null;
  const canvasSize = canvas
    ? { width: canvas.width, height: canvas.height }
    : null;

  // Frame scope reads the generated patch. Canvas scope reads an opaque,
  // downscaled overview with the same aspect ratio as the live composite.
  let frame: Blob;
  try {
    if (scope === "canvas") {
      if (!canvas) {
        throw new Error("VLM canvas tracking requires an active composite.");
      }
      frame = await captureVisionCanvas({ source: canvas });
    } else {
      const resp = await fetch(outputURL, { signal });
      frame = await resp.blob();
    }
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (err instanceof Error && err.message.startsWith("VLM canvas tracking")) {
      throw err;
    }
    throw new Error(
      `VLM tracking could not read the ${scope} image.`,
    );
  }

  const provider = new OllamaVLMProvider(
    live.vlmModel,
    ollamaThinkFor(live.vlmModel, live.vlmThinkingMode),
  );
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
  if (useStore.getState().vlmScope !== scope) return;

  if (scope === "canvas" && canvasSize) {
    const pullPosition = pullPositionForCanvasPoint(point, canvasSize);
    await pullHandle.triggerAt(pullPosition);
    // The selected canvas point is now the center of the local pulled frame.
    useStore.getState().set("vlmPoint", { x: 0.5, y: 0.5 });
    return;
  }

  // Frame scope keeps the returned normalized point as the next local COM.
  useStore.getState().set("vlmPoint", point);
}

export function pullPositionForCanvasPoint(
  point: VLMPoint,
  canvasSize: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.round(clamp01(point.x) * canvasSize.width - PULL_PATCH_SIZE / 2),
    y: Math.round(clamp01(point.y) * canvasSize.height - PULL_PATCH_SIZE / 2),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
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

function resolveWorkflow(): string | null {
  const state = useStore.getState();
  return pickFromPool(activePool(state.pinnedWorkflows, state.mutedWorkflows));
}

/**
 * When the rotation picks a workflow different from the previous run,
 * snap Steps to the default declared inside that workflow's {steps:N}
 * placeholder. Same workflow N times in a row keeps the user's override.
 */
function syncStepsOnWorkflowChange(picked: string): void {
  const state = useStore.getState();
  const changed = picked !== state.lastPickedWorkflow;
  state.set("lastPickedWorkflow", picked);
  if (!changed && state.steps != null) return;
  const descriptor = state.availableWorkflows.find(
    (workflow) => workflow.path === picked,
  );
  state.set("steps", descriptor?.default_steps ?? null);
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
    const sourceCanvas = compositeStore.getCanvas();
    const maxSize = deriveCompositeMaxSize({
      enabled: state.compositeMode && state.boundsEnabled,
      width: state.boundsWidth,
      height: state.boundsHeight,
    });
    const comBounds = deriveCOMBounds(
      maxSize,
      sourceCanvas
        ? { width: sourceCanvas.width, height: sourceCanvas.height }
        : { width: pos.width, height: pos.height },
    );
    const rawCOM = resolveInputCOM({
      trackingMode: state.trackingMode,
      vlmPoint: useStore.getState().vlmPoint,
      heatmapData: heatmap.getData(),
      containerSize: containerSize(),
    });
    const com = clampCOMToBounds(rawCOM, comBounds, pos);
    useStore.getState().set("baseCOM", com);

    const centerX = pos.x + com.x * pos.width;
    const centerY = pos.y + com.y * pos.height;

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
): Promise<boolean> {
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
    return false;
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
    return false;
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
    return true;
  }

  // Composite mode: stitch onto the live backing canvas (no PNG round-trip).
  const prevCanvas = compositeStore.getCanvas();
  if (!prevCanvas) {
    // First-ever generation with empty canvas — seed from the new patch
    // and record its position so Reset pos can return to that location.
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
    return true;
  }

  // Lazy-init the first-patch marker for seed paths that pre-populate the
  // composite before generation. It is retained solely for Reset pos.
  const firstPatch = state.firstPatchPosition ?? state.baseImgPosition;
  const nextSize = { width: newImg.naturalWidth, height: newImg.naturalHeight };
  const prevSize = { width: prevCanvas.width, height: prevCanvas.height };
  const maxSize = deriveCompositeMaxSize({
    enabled: state.boundsEnabled,
    width: state.boundsWidth,
    height: state.boundsHeight,
  });
  const comBounds = deriveCOMBounds(maxSize, prevSize);
  // Re-clamp the live COM in case the cap changed during generation. This
  // constrains only the anchor point; planComposite clips patch overflow.
  const placementCOM = useCOM
    ? clampCOMToBounds(state.baseCOM, comBounds, state.baseImgPosition)
    : state.baseCOM;
  if (
    placementCOM.x !== state.baseCOM.x ||
    placementCOM.y !== state.baseCOM.y
  ) {
    useStore.getState().set("baseCOM", placementCOM);
  }
  const plan = planComposite({
    prevSize,
    prevPosition: state.baseImgPosition,
    newSize: nextSize,
    newCOM: placementCOM,
    workflow: workflowType,
    useCOM,
    maxSize,
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
  // Keep Reset pos's first-patch marker aligned across coordinate shifts.
  // We also commit the lazy-init value here when applicable.
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
  return true;
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
