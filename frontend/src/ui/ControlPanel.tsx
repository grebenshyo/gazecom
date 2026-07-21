/**
 * Control panel — all the user-facing toggles, dropdowns, and sliders.
 *
 * Replaces the ~1,500 lines of imperative DOM wiring in legacy
 * ui-controller.js. Every input here is bound directly to the Zustand store;
 * persistence to localStorage is handled by the store's subscription
 * middleware (src/store/index.ts) — no need for per-input `localStorage`
 * calls.
 *
 * Phase 4 scope: render every control with correct binding. Behavior beyond
 * "set the store" (e.g. workflow selection driving generation) lives in
 * Phase 5.
 */

import { useEffect, useRef, useState } from "react";

import {
  Button,
  Dropdown,
  NumberInput,
  Slider,
  Toggle,
  WorkflowPicker,
} from "./components";
import { Drawers } from "./Drawers";
import { ThemeToggle } from "./ThemeToggle";
import {
  useStore,
  type LLMModel,
  type TrackingMode,
  type UIScale,
} from "../store";
import { compositeStore } from "../canvas/CompositeStore";
import { pullHandle } from "../canvas/pullHandle";
import type { HeatmapStyleName } from "../canvas/Heatmap";
import {
  fetchImages,
  fetchLlmModels,
  fetchWorkflows,
  uploadImage,
} from "../generation/api";
import { OllamaLLMProvider, OllamaVLMProvider } from "../generation/llm";
import {
  buildVisionInput,
  type PipelineCtx,
} from "../generation/pipeline";
import {
  addToPool,
  poolIsValid,
  poolSum,
  reconcilePool,
  removeFromPool,
  setPoolWeight,
} from "../generation/workflows";
import { processImageURLToBaseSquare } from "../lib/images";
import {
  PROMPT_LIST_NAMES,
  addPromptSlot,
  nextPromptAutoEnhanceMode,
  promptSlotAutoEnhanceMode,
  promptSlotVisionEnabled,
  promptLists,
  promptPoolIsValid,
  promptPoolSum,
  replaceAllPlaceholders,
  removePromptSlot,
  setPromptSlotAutoEnhanceMode,
  setPromptSlotDerivedHeight,
  setPromptSlotDerivedText,
  setPromptSlotHeight,
  setPromptSlotText,
  setPromptSlotVisionEnabled,
  setPromptSlotWeight,
  type PromptAutoEnhanceMode,
  type PromptListName,
  type PromptSlot,
  type PromptSlots,
} from "../prompts";
import "./ControlPanel.css";

const TRACKING_MODE_OPTIONS: ReadonlyArray<{ value: TrackingMode; label: string }> = [
  { value: "webgazer", label: "WebGazer" },
  { value: "handpose", label: "Handpose" },
  { value: "roam", label: "Roam" },
  { value: "roam2", label: "Adaptive Roam" },
  { value: "msi", label: "MSI" },
  { value: "cursor", label: "Cursor" },
  { value: "vlm", label: "VLM" },
];

const HEATMAP_STYLE_OPTIONS: ReadonlyArray<{
  value: HeatmapStyleName;
  label: string;
}> = [
  { value: "moire", label: "Moiré" },
  { value: "classic", label: "Blackbody" },
  { value: "grayscale", label: "Grayscale" },
  { value: "spectral", label: "Spectral" },
];

const FALLBACK_LLM_MODELS = ["mistral", "deepseek-r1:8b"];

const UI_SCALE_OPTIONS: ReadonlyArray<{ value: UIScale; label: string }> = [
  { value: 72, label: "Compact" },
  { value: 80, label: "Medium" },
  { value: 100, label: "Large" },
];

const AUTO_ENHANCE_ICONS: Record<PromptAutoEnhanceMode, string> = {
  off: "○",
  send: "↗",
  evolve: "↻",
};

const AUTO_ENHANCE_TITLES: Record<PromptAutoEnhanceMode, string> = {
  off: "Auto-enhance off. Click for send.",
  send: "Auto-enhance send: enhance for generation without changing this slot.",
  evolve: "Auto-enhance evolve: enhance for generation and write back here.",
};

const VISION_BUTTON_TITLES = {
  off: "Vision off: use this slot as text.",
  on: "Vision on: use this slot as the VLM describe instruction.",
};

type EyeDropperResult = { sRGBHex: string };
type EyeDropperInstance = { open: () => Promise<EyeDropperResult> };
type WindowWithEyeDropper = Window & {
  EyeDropper?: new () => EyeDropperInstance;
};

function normalizeMatteColor(value: string): string | null {
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

function setPromptSlotInstructionText(
  slots: PromptSlots,
  index: number,
  text: string,
): PromptSlots {
  return setPromptSlotDerivedText(
    setPromptSlotText(slots, index, text),
    index,
    "",
  );
}

function clearPromptSlotDerived(
  slots: PromptSlots,
  index: number,
): PromptSlots {
  return setPromptSlotDerivedText(slots, index, "");
}

export function ControlPanel({
  getPipelineCtx,
}: {
  getPipelineCtx?: () => PipelineCtx | null;
}) {
  const s = useStore();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /**
   * Local UI state — which prompt slot the user last focused.
   * Template-dropdown picks write into this slot; defaults to slot 0
   * (the base) when nothing has been focused yet.
   */
  const [activeSlotIndex, setActiveSlotIndex] = useState(0);
  /**
   * Local UI state — which slot is currently being LLM-enhanced
   * (null = none). Serialized: only one ✨ in-flight at a time.
   */
  const [enhancingSlotIndex, setEnhancingSlotIndex] = useState<number | null>(
    null,
  );
  const [llmModels, setLlmModels] = useState<string[]>([]);
  const [llmModelsStatus, setLlmModelsStatus] = useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");
  const [matteColorDraft, setMatteColorDraft] = useState(s.matteColor);
  const selectedImageSeedRef = useRef<string | null>(null);

  /**
   * Whether the prompt controls (List / Template / LLM prompt / models) are shown
   * at the bottom of the Prompting section. Toggled by the ⚙ in the
   * Prompting header; reuses the persisted `prompting.settings` key so
   * the reveal survives reloads. Hidden by default.
   */
  const promptSettingsOpen = s.sectionsExpanded["prompting.settings"] ?? false;
  const togglePromptSettings = () =>
    s.set("sectionsExpanded", {
      ...s.sectionsExpanded,
      "prompting.settings": !promptSettingsOpen,
    });

  useEffect(() => {
    setMatteColorDraft(s.matteColor);
  }, [s.matteColor]);

  const setMatteColor = (value: string) => {
    const color = normalizeMatteColor(value);
    if (!color) return;
    setMatteColorDraft(color);
    s.set("matteColor", color);
  };

  const sampleMatteColor = async () => {
    const EyeDropperCtor = (window as WindowWithEyeDropper).EyeDropper;
    if (!EyeDropperCtor) return;
    try {
      const result = await new EyeDropperCtor().open();
      setMatteColor(result.sRGBHex);
    } catch {
      // User cancelled the picker; keep the current color.
    }
  };

  const applyFetchedLlmModels = (models: string[]): string[] => {
    const clean = [...new Set(models.map((m) => m.trim()).filter(Boolean))].sort(
      (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    setLlmModels(clean);
    setLlmModelsStatus("loaded");
    const current = useStore.getState().llmModel;
    if (clean.length > 0 && !clean.includes(current)) {
      useStore.getState().set("llmModel", clean[0]);
    }
    const currentVision = useStore.getState().vlmModel;
    if (clean.length > 0 && !clean.includes(currentVision)) {
      useStore.getState().set("vlmModel", clean[0]);
    }
    return clean;
  };

  const refreshLlmModels = async (): Promise<string[]> => {
    setLlmModelsStatus("loading");
    try {
      return applyFetchedLlmModels(await fetchLlmModels());
    } catch {
      setLlmModelsStatus("error");
      throw new Error(
        "Could not reach Ollama. Check the Ollama host in Settings.",
      );
    }
  };

  const ensureSelectedLlmModel = async (): Promise<string> => {
    let models = llmModels;
    if (llmModelsStatus !== "loaded" || models.length === 0) {
      models = await refreshLlmModels();
    }
    if (models.length === 0) {
      throw new Error(
        "No Ollama models found on the configured host. Pull a model on the Ollama machine, then reopen the prompt settings.",
      );
    }
    const current = useStore.getState().llmModel;
    if (models.includes(current)) return current;
    const next = models[0];
    useStore.getState().set("llmModel", next);
    return next;
  };

  const ensureSelectedVlmModel = async (): Promise<string> => {
    let models = llmModels;
    if (llmModelsStatus !== "loaded" || models.length === 0) {
      models = await refreshLlmModels();
    }
    if (models.length === 0) {
      throw new Error(
        "No Ollama models found on the configured host. Pull a vision-capable model on the Ollama machine, then reopen the prompt settings.",
      );
    }
    const current = useStore.getState().vlmModel;
    if (models.includes(current)) return current;
    const next = models[0];
    useStore.getState().set("vlmModel", next);
    return next;
  };

  useEffect(() => {
    if (!promptSettingsOpen) return;
    let alive = true;
    setLlmModelsStatus("loading");
    fetchLlmModels()
      .then((models) => {
        if (!alive) return;
        applyFetchedLlmModels(models);
      })
      .catch(() => {
        if (alive) setLlmModelsStatus("error");
      });
    return () => {
      alive = false;
    };
  }, [promptSettingsOpen]);

  // Load workflows + images on mount.
  useEffect(() => {
    let cancelled = false;
    fetchWorkflows()
      .then((list) => {
        if (cancelled) return;
        const live = useStore.getState();
        live.set("availableWorkflows", list);
        const validPaths = new Set(
          list.filter((workflow) => workflow.valid).map((workflow) => workflow.path),
        );
        const reconciled = reconcilePool(live.pinnedWorkflows, validPaths);
        if (!samePool(live.pinnedWorkflows, reconciled)) {
          live.set("pinnedWorkflows", reconciled);
        }
        if (live.lastPickedWorkflow && !validPaths.has(live.lastPickedWorkflow)) {
          live.set("lastPickedWorkflow", null);
        }
      })
      .catch((err) => {
        console.error("Failed to load workflows:", err);
        if (!cancelled) s.set("availableWorkflows", []);
      });
    fetchImages()
      .then((list) => {
        if (cancelled) return;
        s.set("availableImages", list);
        // Pick a sensible default if the user has no saved selection or the
        // saved one is no longer on disk.
        if (list.length === 0) return;
        const current = useStore.getState().selectedImage;
        if (!current || !list.includes(current)) {
          s.set("selectedImage", list[0]);
        }
      })
      .catch((err) => {
        console.error("Failed to load images:", err);
        if (!cancelled) s.set("availableImages", []);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whenever selectedImage changes (incl. initial pick above), fetch the
  // image, crop+resize to 1024² and seed baseImageURL + compositeStore
  // so the generation pipeline has something to work on. Replaces legacy
  // image-processor.js:438-507 (updateCanvasBackground).
  const selectedImage = s.selectedImage;
  useEffect(() => {
    if (!selectedImage) return;
    const live = useStore.getState();
    const hasLiveCanvas =
      compositeStore.hasCanvas() ||
      live.compositeHasCanvas ||
      Boolean(live.baseImageURL);
    if (selectedImageSeedRef.current === null && hasLiveCanvas) {
      selectedImageSeedRef.current = selectedImage;
      return;
    }
    let cancelled = false;
    selectedImageSeedRef.current = selectedImage;
    (async () => {
      try {
        const dataURL = await processImageURLToBaseSquare(
          `/images/${selectedImage}`,
        );
        if (cancelled) return;
        // Seed the persistent composite canvas, then update the adjacent
        // baseImageURL / position fields.
        await compositeStore.setFromImageURL(dataURL);
        if (cancelled) return;
        useStore.getState().patch({
          baseImageURL: dataURL,
          baseImgPosition: { x: 0, y: 0, width: 1024, height: 1024 },
          baseCOM: { x: 0.5, y: 0.5 },
          isComposited: false,
        });
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to process selected image:", err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedImage]);

  // Workflow pool helpers. The backend has already grouped, sorted, and
  // validated the descriptors; this layer only binds them to persisted pins.
  const pinnedEntries = Object.entries(s.pinnedWorkflows);
  const availableWorkflows = Array.isArray(s.availableWorkflows)
    ? s.availableWorkflows
    : [];
  const workflowByPath = new Map(
    availableWorkflows.map((workflow) => [workflow.path, workflow]),
  );
  const llmModelOptions = (() => {
    const values = new Set<string>();
    const models =
      llmModelsStatus === "loaded" && llmModels.length > 0
        ? llmModels
        : FALLBACK_LLM_MODELS;
    for (const model of models) values.add(model);
    if (llmModelsStatus !== "loaded" && s.llmModel) values.add(s.llmModel);
    if (values.size === 0 && s.llmModel) values.add(s.llmModel);
    return [...values]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      .map((model) => ({ value: model, label: model }));
  })();

  // Drag handle: when the user grabs the title bar, track pointer until
  // release. Position is committed to the store on each move so it
  // survives reloads (replaces legacy ui-controller.js:430-501).
  const panelRef = useRef<HTMLElement | null>(null);
  const dragStateRef = useRef<{ dx: number; dy: number } | null>(null);
  const onDragStart = (e: React.PointerEvent) => {
    const panel = panelRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    dragStateRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragStateRef.current;
    if (!d) return;
    useStore
      .getState()
      .set("panelPosition", { left: e.clientX - d.dx, top: e.clientY - d.dy });
  };
  const onDragEnd = (e: React.PointerEvent) => {
    dragStateRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  };

  const panelScale = s.uiScale / 100;
  const unscaledViewport = 100 / panelScale;
  const panelStyle: React.CSSProperties = {
    maxHeight: `calc(${unscaledViewport}vh - ${unscaledViewport}px)`,
    ...(s.panelPosition
      ? {
          left: s.panelPosition.left / panelScale,
          top: s.panelPosition.top / panelScale,
          right: "auto",
        }
      : {
          top: 80 / panelScale,
          right: 20 / panelScale,
        }),
  };

  return (
    <aside ref={panelRef} className="gz-control-panel" style={panelStyle}>
      <header
        className="gz-panel-header"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        {/* drag handle, intentionally no title — legacy parity */}
        <span className="gz-panel-grip" aria-hidden="true" />
        <button
          className="gz-panel-minimize"
          aria-label={s.panelMinimized ? "Expand panel" : "Collapse panel"}
          title={s.panelMinimized ? "Expand" : "Collapse"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => s.set("panelMinimized", !s.panelMinimized)}
        >
          {s.panelMinimized ? "+" : "−"}
        </button>
      </header>

      {s.panelMinimized ? null : (
        <>
      {/*
        Section layout:
          - Prompting / Workflow: primary creative controls, default expanded.
          - Settings / Advanced / View: configuration, default collapsed
            (declutters the panel until the user opts in). Settings holds
            tracking mode + heatmap/dot tuning + the generation toggles.
        Default expanded/collapsed states live in DEFAULT_SECTION_EXPANDED
        below; the user's per-section toggles are persisted via
        s.sectionsExpanded.
      */}

      <Section
        title="Prompting"
        sectionKey="prompting"
        collapsible
        headerAction={
          <span
            className="gz-section__cog"
            role="button"
            tabIndex={0}
            aria-label="Toggle prompt settings"
            aria-pressed={promptSettingsOpen}
            title="Prompt settings — list, template, LLM prompt, models"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              togglePromptSettings();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                togglePromptSettings();
              }
            }}
          >
            ⚙
          </span>
        }
      >
        {s.pinnedPrompts.map((slot, index) => (
          <PromptSlotRow
            key={index}
            index={index}
            slot={slot}
            isOnly={s.pinnedPrompts.length === 1}
            isActivePick={index === s.lastPickedPromptIndex}
            enhancing={enhancingSlotIndex === index}
            anyEnhancing={enhancingSlotIndex !== null}
            autoEnhanceMode={promptSlotAutoEnhanceMode(slot)}
            visionEnabled={promptSlotVisionEnabled(slot)}
            onFocus={() => setActiveSlotIndex(index)}
            onTextChange={(text) =>
              s.set(
                "pinnedPrompts",
                setPromptSlotInstructionText(s.pinnedPrompts, index, text),
              )
            }
            onWeightChange={(weight) =>
              s.set(
                "pinnedPrompts",
                setPromptSlotWeight(s.pinnedPrompts, index, weight),
              )
            }
            onHeightChange={(h) =>
              s.set(
                "pinnedPrompts",
                setPromptSlotHeight(s.pinnedPrompts, index, h),
              )
            }
            onDerivedHeightChange={(h) =>
              s.set(
                "pinnedPrompts",
                setPromptSlotDerivedHeight(s.pinnedPrompts, index, h),
              )
            }
            onRemove={() => {
              s.set(
                "pinnedPrompts",
                removePromptSlot(s.pinnedPrompts, index),
              );
              // If the active slot was removed, fall back to base.
              if (activeSlotIndex === index) setActiveSlotIndex(0);
              else if (activeSlotIndex > index)
                setActiveSlotIndex(activeSlotIndex - 1);
            }}
            onAutoEnhanceModeChange={(mode) =>
              s.set(
                "pinnedPrompts",
                setPromptSlotAutoEnhanceMode(s.pinnedPrompts, index, mode),
              )
            }
            onVisionEnabledChange={(enabled) =>
              s.set(
                "pinnedPrompts",
                clearPromptSlotDerived(
                  setPromptSlotVisionEnabled(
                    s.pinnedPrompts,
                    index,
                    enabled,
                  ),
                  index,
                ),
              )
            }
            onEnhance={async () => {
              if (enhancingSlotIndex !== null) return;
              const text = slot.text.trim();
              if (!text) return;
              setEnhancingSlotIndex(index);
              try {
                const instruction = replaceAllPlaceholders(text);
                if (promptSlotVisionEnabled(slot)) {
                  const ctx = getPipelineCtx?.();
                  if (!ctx) {
                    throw new Error(
                      "Vision frame unavailable. Wait for the heatmap frame to mount, then try again.",
                    );
                  }
                  const live = useStore.getState();
                  const image = await buildVisionInput(
                    ctx,
                    live,
                    live.comMode,
                  );
                  const vlmModel = await ensureSelectedVlmModel();
                  const described = await new OllamaVLMProvider(
                    vlmModel,
                  ).describe(image, instruction);
                  if (!described.trim()) {
                    throw new Error("VLM returned an empty prompt.");
                  }
                  const latest = useStore.getState();
                  latest.set(
                    "pinnedPrompts",
                    setPromptSlotDerivedText(
                      latest.pinnedPrompts,
                      index,
                      described,
                    ),
                  );
                  return;
                }

                const model = await ensureSelectedLlmModel();
                const template = useStore.getState().llmEnhancePrompt;
                const enhanced = await new OllamaLLMProvider(model).enhance(
                  instruction,
                  template,
                );
                const latest = useStore.getState();
                latest.set(
                  "pinnedPrompts",
                  setPromptSlotInstructionText(
                    latest.pinnedPrompts,
                    index,
                    enhanced,
                  ),
                );
              } catch (err) {
                alert(`Enhance failed: ${(err as Error).message}`);
              } finally {
                setEnhancingSlotIndex(null);
              }
            }}
          />
        ))}
        <Button
          variant="secondary"
          onClick={() =>
            s.set("pinnedPrompts", addPromptSlot(s.pinnedPrompts))
          }
        >
          + Add prompt slot
        </Button>
        {!promptPoolIsValid(s.pinnedPrompts) && (
          <p className="gz-pool-warning">
            ⚠ Weights must sum to 100% (currently
            {" "}
            {promptPoolSum(s.pinnedPrompts)}%). Generation is disabled
            until you fix this.
          </p>
        )}
        {/* List / Template / LLM controls — revealed by the ⚙ in
            the Prompting header (state reuses the persisted
            "prompting.settings" key). No sub-section wrapper: they just
            appear at the bottom when the cog is toggled on. */}
        {promptSettingsOpen && (
          <>
            <Dropdown<PromptListName>
              label="List"
              value={(s.promptList as PromptListName) ?? "Secession Trees Art"}
              options={PROMPT_LIST_NAMES.map((n) => ({ value: n, label: n }))}
              onChange={(v) => s.set("promptList", v)}
            />
            {(() => {
              // Template dropdown — action-only. Picking writes the
              // template text into whichever slot the user last focused
              // (replaces existing text), then resets the dropdown.
              const templates =
                promptLists[s.promptList as PromptListName] ?? [];
              const addOptions = [
                { value: "", label: "Fill active slot with template…" },
                ...templates.map((t) => ({
                  value: t,
                  label: t.length > 60 ? t.slice(0, 60).trim() + "…" : t,
                })),
              ];
              return (
                <Dropdown
                  label="Template"
                  value=""
                  options={addOptions}
                  onChange={(picked) => {
                    if (!picked) return;
                    const idx = Math.min(
                      activeSlotIndex,
                      s.pinnedPrompts.length - 1,
                    );
                    s.set(
                      "pinnedPrompts",
                      setPromptSlotInstructionText(
                        s.pinnedPrompts,
                        idx,
                        picked,
                      ),
                    );
                  }}
                />
              );
            })()}
            <Dropdown<LLMModel>
              label="Ollama model"
              value={s.llmModel}
              options={llmModelOptions}
              onChange={(v) => s.set("llmModel", v)}
              disabled={llmModelsStatus === "loaded" && llmModels.length === 0}
            />
            <Dropdown<LLMModel>
              label="Vision model"
              value={s.vlmModel}
              options={llmModelOptions}
              onChange={(v) => s.set("vlmModel", v)}
              disabled={llmModelsStatus === "loaded" && llmModels.length === 0}
            />
            <label className="gz-prompt-settings-textarea">
              <span className="gz-prompt-settings-textarea__label">
                LLM prompt
              </span>
              <textarea
                className="gz-prompt-settings-textarea__input"
                value={s.llmEnhancePrompt}
                spellCheck={false}
                rows={3}
                onChange={(e) =>
                  s.set("llmEnhancePrompt", e.target.value)
                }
              />
            </label>
            {!s.llmEnhancePrompt.includes("{prompt}") && (
              <p className="gz-empty">
                No {"{prompt}"} placeholder: the prompt text will be appended at
                the end.
              </p>
            )}
            {llmModelsStatus === "loading" && (
              <p className="gz-empty">Loading Ollama models…</p>
            )}
            {llmModelsStatus === "loaded" && llmModels.length === 0 && (
              <p className="gz-empty">
                No Ollama models found. Pull one on the Ollama machine, then
                reopen this panel.
              </p>
            )}
            {llmModelsStatus === "error" && (
              <p className="gz-empty">
                Could not reach Ollama; showing fallback names until it responds.
              </p>
            )}
          </>
        )}
      </Section>

      <Section title="Workflow" sectionKey="workflow" collapsible>
        {availableWorkflows.length === 0 ? (
          <p className="gz-empty">No workflows loaded.</p>
        ) : (
          <WorkflowPicker
            workflows={availableWorkflows}
            pinnedPaths={new Set(Object.keys(s.pinnedWorkflows))}
            onSelect={(picked) => {
              s.set("pinnedWorkflows", addToPool(s.pinnedWorkflows, picked));
            }}
          />
        )}
        {pinnedEntries.length === 0 ? (
          <p className="gz-empty">Pick a workflow to pin.</p>
        ) : (
          <>
            {pinnedEntries.map(([path, weight]) => (
              <div
                className={`gz-pool-row${path === s.lastPickedWorkflow ? " gz-pool-row--active" : ""}`}
                key={path}
              >
                <span className="gz-pool-row__label" title={path}>
                  {workflowByPath.get(path)?.label ?? workflowLabelFromPath(path)}
                </span>
                <input
                  className="gz-pool-row__weight-input"
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={weight}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") return;
                    const n = Number(raw);
                    if (!Number.isFinite(n)) return;
                    s.set(
                      "pinnedWorkflows",
                      setPoolWeight(s.pinnedWorkflows, path, n),
                    );
                  }}
                />
                <span className="gz-pool-row__pct">%</span>
                <button
                  className="gz-pool-row__remove"
                  type="button"
                  aria-label={`Remove ${path}`}
                  title="Remove from pool"
                  onClick={() =>
                    s.set(
                      "pinnedWorkflows",
                      removeFromPool(s.pinnedWorkflows, path),
                    )
                  }
                >
                  ×
                </button>
              </div>
            ))}
            {!poolIsValid(s.pinnedWorkflows) && (
              <p className="gz-pool-warning">
                ⚠ Weights must sum to 100% (currently
                {" "}
                {poolSum(s.pinnedWorkflows)}%). Generation is disabled
                until you fix this.
              </p>
            )}
          </>
        )}
        <label className="gz-workflow-steps">
          <span>Steps</span>
          <input
            type="number"
            aria-label="Steps"
            min={1}
            max={999}
            step={1}
            value={s.steps}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value)) s.set("steps", Math.max(1, value));
            }}
          />
        </label>
      </Section>

      <Section title="Settings" sectionKey="settings" collapsible>
        <Dropdown<TrackingMode>
          label="Mode"
          value={s.trackingMode}
          options={TRACKING_MODE_OPTIONS}
          onChange={(v) => s.set("trackingMode", v)}
        />
        {/* Speed only applies to the synthetic roamers (roam / roam2) —
            real-input trackers have no travel speed to scale. */}
        {(s.trackingMode === "roam" || s.trackingMode === "roam2") && (
          <Slider
            label="Roam speed"
            value={s.roamSpeed}
            min={0.1}
            max={3}
            step={0.1}
            onChange={(v) => s.set("roamSpeed", v)}
          />
        )}
        {s.trackingMode === "webgazer" && (
          <Slider
            label="Event history"
            value={s.eventHistoryLength}
            min={100}
            max={5000}
            step={100}
            onChange={(v) => s.set("eventHistoryLength", v)}
          />
        )}
        {/* Trail length shapes the heatmap smear; applies to every
            trail-based tracker except WebGazer's event history and the
            single-point VLM mode. */}
        {s.trackingMode !== "webgazer" && s.trackingMode !== "vlm" && (
          <Slider
            label="Trail length"
            value={s.trailLength}
            min={10}
            max={1000}
            step={10}
            onChange={(v) => s.set("trailLength", v)}
          />
        )}
        <Dropdown<HeatmapStyleName>
          label="Heatmap"
          value={s.heatmapStyle}
          options={HEATMAP_STYLE_OPTIONS}
          onChange={(v) => s.set("heatmapStyle", v)}
        />
        {/* Gaze-dot radius + its random variation. Mode-agnostic — every
            tracker's points render through the heatmap. */}
        <Slider
          label="Dot size"
          value={s.pointSize}
          min={5}
          max={200}
          step={5}
          onChange={(v) => s.set("pointSize", v)}
        />
        <Slider
          label="Dot size jitter"
          value={s.pointJitter}
          min={0}
          max={50}
          step={5}
          onChange={(v) => s.set("pointJitter", v)}
        />
        {s.availableImages.length > 0 ? (
          <Dropdown
            label="Image"
            value={s.selectedImage ?? s.availableImages[0]}
            options={s.availableImages.map((name) => ({
              value: name,
              label: name,
            }))}
            onChange={(v) => s.set("selectedImage", v)}
          />
        ) : (
          <p className="gz-empty">No images on the server.</p>
        )}
        {/* Upload — replaces legacy ui-controller.js:747-826. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (!file.type.startsWith("image/")) {
              alert("Please choose an image file.");
              return;
            }
            try {
              const { filename } = await uploadImage(file);
              const list = useStore.getState().availableImages;
              if (!list.includes(filename)) {
                useStore.getState().set("availableImages", [filename, ...list]);
              }
              useStore.getState().set("selectedImage", filename);
            } catch (err) {
              alert(`Upload failed: ${(err as Error).message}`);
            }
          }}
        />
        <Button
          variant="secondary"
          onClick={() => fileInputRef.current?.click()}
        >
          Upload image
        </Button>
        <div className="gz-row">
          <Toggle
            label="Feedback"
            checked={s.feedbackMode}
            onChange={(v) => s.set("feedbackMode", v)}
          />
          <Toggle
            label="COM"
            checked={s.comMode}
            onChange={(v) => s.set("comMode", v)}
          />
        </div>
        <Toggle
          label="Composite"
          checked={s.compositeMode}
          onChange={(v) => s.set("compositeMode", v)}
        />
        <Toggle
          label="Iterative"
          checked={s.iterativeMode}
          onChange={(v) => s.set("iterativeMode", v)}
        />
        <Slider
          label="Iterative delay (s)"
          value={s.iterativeDelay}
          min={0}
          max={60}
          onChange={(v) => s.set("iterativeDelay", v)}
          disabled={!s.iterativeMode}
        />
      </Section>

      <Section title="Advanced" sectionKey="advanced" collapsible>
        <div className="gz-row">
          <Toggle
            label="Comp matte"
            checked={s.compositeMatteEnabled}
            onChange={(v) => s.set("compositeMatteEnabled", v)}
          />
          <Toggle
            label="Heatmap matte"
            checked={s.heatmapMatteEnabled}
            onChange={(v) => s.set("heatmapMatteEnabled", v)}
          />
        </div>
        <div
          className="gz-matte-row"
          aria-disabled={!s.compositeMatteEnabled && !s.heatmapMatteEnabled}
        >
          <input
            className="gz-matte-row__color"
            type="color"
            value={s.matteColor}
            disabled={!s.compositeMatteEnabled && !s.heatmapMatteEnabled}
            aria-label="Matte color"
            title="Matte color"
            onChange={(e) => setMatteColor(e.target.value)}
          />
          <input
            className="gz-matte-row__hex"
            type="text"
            value={matteColorDraft}
            disabled={!s.compositeMatteEnabled && !s.heatmapMatteEnabled}
            spellCheck={false}
            aria-label="Matte color hex"
            title="Matte color hex"
            onChange={(e) => {
              const next = e.target.value;
              setMatteColorDraft(next);
              const color = normalizeMatteColor(next);
              if (color) s.set("matteColor", color);
            }}
            onBlur={() => setMatteColorDraft(s.matteColor)}
          />
          <button
            className="gz-matte-row__sample"
            type="button"
            disabled={
              (!s.compositeMatteEnabled && !s.heatmapMatteEnabled) ||
              !(window as WindowWithEyeDropper).EyeDropper
            }
            title={
              (window as WindowWithEyeDropper).EyeDropper
                ? "Sample matte color from the screen"
                : "Eyedropper is not supported in this browser"
            }
            onClick={() => void sampleMatteColor()}
          >
            sample
          </button>
        </div>
        {/* Auto-download / auto-clear every N applied generations.
            Empty = off (default — keeps generating indefinitely without
            saving / clearing). Inlined rather than using
            `<NumberInput>` because that component ignores empty input;
            we need the empty state as a first-class "disabled" value.
            When both fire on the same tick, download runs before clear
            so the file saved is the about-to-be-cleared composite. */}
        <label className="gz-numinput">
          <span className="gz-numinput__label">Download</span>
          <input
            className="gz-numinput__input"
            type="number"
            min={1}
            step={1}
            placeholder="off"
            value={s.autoDownloadEvery ?? ""}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") {
                s.set("autoDownloadEvery", null);
                return;
              }
              const n = Number(raw);
              if (Number.isFinite(n) && n > 0) {
                s.set("autoDownloadEvery", Math.floor(n));
              }
            }}
          />
        </label>
        <label className="gz-numinput">
          <span className="gz-numinput__label">Clear</span>
          <input
            className="gz-numinput__input"
            type="number"
            min={1}
            step={1}
            placeholder="off"
            value={s.autoClearEvery ?? ""}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") {
                s.set("autoClearEvery", null);
                return;
              }
              const n = Number(raw);
              if (Number.isFinite(n) && n > 0) {
                s.set("autoClearEvery", Math.floor(n));
              }
            }}
          />
        </label>
        <Toggle
          label="Limit canvas size"
          checked={s.boundsEnabled}
          onChange={(v) => s.set("boundsEnabled", v)}
        />
        <NumberInput
          label="Width (px)"
          value={s.boundsWidth}
          min={1024}
          step={256}
          // Don't clamp here — NumberInput already enforces `min` on
          // blur. Clamping in the parent's onChange runs on every
          // keystroke, which prevents the user from typing any value
          // smaller than the current one (each keystroke would snap up
          // to the floor before they finish typing). Transient
          // sub-min values are tolerated upstream: deriveBounds in the
          // pipeline fail-opens when boundsWidth < newSize.width.
          onChange={(v) => s.set("boundsWidth", v)}
          disabled={!s.boundsEnabled}
        />
        <NumberInput
          label="Height (px)"
          value={s.boundsHeight}
          min={1024}
          step={256}
          onChange={(v) => s.set("boundsHeight", v)}
          disabled={!s.boundsEnabled}
        />
        {/* VLM-mode instruction: the vision model returns the single salient
            point that drives COM in VLM tracking mode. Sent to /api/llm/point;
            empty falls back to the backend default. */}
        <label className="gz-prompt-settings-textarea">
          <span className="gz-prompt-settings-textarea__label">
            VLM prompt
          </span>
          <textarea
            className="gz-prompt-settings-textarea__input"
            value={s.vlmPointPrompt}
            spellCheck={false}
            rows={3}
            onChange={(e) => s.set("vlmPointPrompt", e.target.value)}
          />
        </label>
        <Toggle
          label="Calibration cache (reuse saved model between sessions)"
          checked={s.calibCache}
          disabled={s.trackingMode !== "webgazer"}
          onChange={(v) => s.set("calibCache", v)}
        />
        <Button
          variant="secondary"
          disabled={s.trackingMode !== "webgazer"}
          onClick={() => {
            // Clearing trackerCalibrated forces the calibration overlay to
            // reappear on next render.
            s.set("trackerCalibrated", false);
            s.set("trackingActive", false);
          }}
        >
          Recalibrate
        </Button>
      </Section>

      <Section title="View" sectionKey="view" collapsible>
        <div className="gz-ui-scale-options" aria-label="Interface scale">
          {UI_SCALE_OPTIONS.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant="secondary"
              className={s.uiScale === option.value ? "gz-btn--selected" : ""}
              aria-pressed={s.uiScale === option.value}
              onClick={() => s.set("uiScale", option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        {/* Frame zoom — scales the composite + heatmap frames together to
            fit smaller screens or a two-frame layout. Resizes the frames
            (not a CSS transform), so tracking coordinates stay correct. */}
        <Slider
          label="Frame zoom"
          value={s.frameZoom}
          min={40}
          max={100}
          step={5}
          onChange={(v) => s.set("frameZoom", v)}
        />
        <Toggle
          label="Fit to frame"
          checked={s.compositeFitEnabled}
          onChange={(v) => s.set("compositeFitEnabled", v)}
        />
        <Dropdown
          label="Target"
          value={s.compositeFitTarget}
          options={[
            { value: "composite", label: "Comp" },
            { value: "patch", label: "Patch" },
          ]}
          onChange={(v) => s.set("compositeFitTarget", v)}
          disabled={!s.compositeFitEnabled}
        />
        {/* Bbox visibility — Pull's crop region overlay on the composite. */}
        <div className="gz-bbox-controls">
          <Toggle
            label="Display bbox"
            checked={s.cropBoxVisible}
            onChange={(v) => s.set("cropBoxVisible", v)}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => pullHandle.triggerHome()}
            disabled={!s.compositeHasCanvas}
            title="Move bbox to the first patch position"
          >
            Reset pos
          </Button>
        </div>
        <Slider
          label="Pull box frame width"
          value={s.cropBoxBorderWidth}
          min={1}
          max={32}
          step={1}
          onChange={(v) => s.set("cropBoxBorderWidth", v)}
        />
        {/* Frame visibility — turning a toggle off hides the frame from
            the UI; the remaining frame centers naturally. The heatmap
            tracker keeps running while hidden so users can treat the
            heatmap as a background process. */}
        <Toggle
          label="Canvas"
          checked={s.canvasVisible}
          onChange={(v) => s.set("canvasVisible", v)}
        />
        <Toggle
          label="Heatmap"
          checked={s.heatmapVisible}
          onChange={(v) => s.set("heatmapVisible", v)}
        />
      </Section>

      {/* Theme + settings + help cluster — bottom of the panel body, just
          above the brand label. Replaces legacy `.help-container`
          (backup/v1 index.html:264-267) and absorbs the theme toggle into
          the same row of circle buttons. */}
      <div className="gz-panel-utilities">
        {/* Read-only live count of applied patches since the last
            canvas clear. `margin-right: auto` pushes it to the left
            edge while the button cluster stays right-aligned. */}
        <span
          className="gz-panel-counter"
          title="Patches generated since last clear"
        >
          it. {s.patchesSinceClear}
        </span>
        <ThemeToggle />
        <Drawers />
      </div>

      <div className="gz-panel-brand" aria-hidden="true">
        gazeCOM
      </div>
        </>
      )}
    </aside>
  );
}

/**
 * Default expanded/collapsed state per section, used when the user has
 * never interacted with that section's toggle. Decluttering goal:
 * show the primary creative controls and mode selection, while hiding the
 * less-frequent advanced + view configuration until the user opts in.
 */
const DEFAULT_SECTION_EXPANDED: Record<string, boolean> = {
  prompting: true,
  "prompting.settings": false,
  workflow: true,
  settings: true,
  advanced: false,
  view: false,
};

/**
 * One row of the prompt pool. Owns its own `ResizeObserver` for height
 * persistence (debounced 250 ms — same pattern the workflow section
 * uses for the panel-textarea height). Each row is independent so the
 * effect lifecycle scopes naturally per slot.
 */
function PromptSlotRow({
  index,
  slot,
  isOnly,
  isActivePick,
  enhancing,
  anyEnhancing,
  autoEnhanceMode,
  visionEnabled,
  onFocus,
  onTextChange,
  onWeightChange,
  onHeightChange,
  onDerivedHeightChange,
  onRemove,
  onAutoEnhanceModeChange,
  onVisionEnabledChange,
  onEnhance,
}: {
  index: number;
  slot: PromptSlot;
  isOnly: boolean;
  isActivePick: boolean;
  enhancing: boolean;
  anyEnhancing: boolean;
  autoEnhanceMode: PromptAutoEnhanceMode;
  visionEnabled: boolean;
  onFocus: () => void;
  onTextChange: (text: string) => void;
  onWeightChange: (weight: number) => void;
  onHeightChange: (height: number) => void;
  onDerivedHeightChange: (height: number) => void;
  onRemove: () => void;
  onAutoEnhanceModeChange: (mode: PromptAutoEnhanceMode) => void;
  onVisionEnabledChange: (enabled: boolean) => void;
  onEnhance: () => void | Promise<void>;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const derivedRef = useRef<HTMLTextAreaElement | null>(null);
  const showDerived =
    visionEnabled ||
    autoEnhanceMode === "send" ||
    Boolean(slot.derivedText?.trim());

  // Per-slot ResizeObserver: writes the user's resized height back to
  // the store after 250 ms of no further changes. Same idea as the
  // workflow-section ResizeObserver, just scoped to this single slot.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    let timer: number | null = null;
    const save = () => {
      const h = ta.offsetHeight;
      if (h <= 0) return;
      if (h !== slot.height) onHeightChange(h);
    };
    const ro = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(save, 250);
    });
    ro.observe(ta);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      ro.disconnect();
    };
    // `slot.height` is in deps so the comparator stays fresh; harmless
    // because re-observing the same node is a no-op until size changes.
  }, [slot.height, onHeightChange]);

  useEffect(() => {
    if (!showDerived) return;
    const ta = derivedRef.current;
    if (!ta) return;
    let timer: number | null = null;
    const save = () => {
      const h = ta.offsetHeight;
      if (h <= 0) return;
      if (h !== (slot.derivedHeight ?? null)) onDerivedHeightChange(h);
    };
    const ro = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(save, 250);
    });
    ro.observe(ta);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      ro.disconnect();
    };
  }, [showDerived, slot.derivedHeight, onDerivedHeightChange]);

  return (
    <div
      className={`gz-prompt-slot${isActivePick ? " gz-prompt-slot--active" : ""}`}
    >
      <div className="gz-prompt-slot__input-wrap">
        <textarea
          ref={taRef}
          className="gz-prompt-slot__textarea"
          rows={3}
          placeholder={
            index === 0 ? "Enter base prompt…" : "Additional prompt slot…"
          }
          value={slot.text}
          disabled={enhancing}
          onFocus={onFocus}
          onChange={(e) => onTextChange(e.target.value)}
          style={slot.height ? { height: slot.height } : undefined}
        />
        <div className="gz-prompt-slot__controls">
          <input
            className="gz-prompt-slot__weight"
            type="number"
            min={0}
            max={100}
            step={1}
            value={slot.weight}
            disabled={isOnly}
            title={
              isOnly
                ? "Weight is locked at 100% for a single-slot pool"
                : "Slot weight (must sum to 100% across all slots)"
            }
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") return;
              const n = Number(raw);
              if (Number.isFinite(n)) onWeightChange(n);
            }}
          />
          <button
            className="gz-prompt-slot__enhance"
            type="button"
            aria-label="Enhance with LLM"
            title={
              enhancing
                ? "Enhancing…"
                : slot.text.trim() === ""
                  ? "Type something first"
                  : "Enhance with LLM"
            }
            disabled={enhancing || anyEnhancing || slot.text.trim() === ""}
            onClick={() => void onEnhance()}
          >
            <span aria-hidden="true">{enhancing ? "⏳" : "✨"}</span>
          </button>
          <button
            className={`gz-prompt-slot__auto-enhance gz-prompt-slot__auto-enhance--${autoEnhanceMode}`}
            type="button"
            aria-label={`Auto-enhance mode: ${autoEnhanceMode}`}
            title={AUTO_ENHANCE_TITLES[autoEnhanceMode]}
            onClick={() =>
              onAutoEnhanceModeChange(
                nextPromptAutoEnhanceMode(autoEnhanceMode),
              )
            }
          >
            <span aria-hidden="true">
              {AUTO_ENHANCE_ICONS[autoEnhanceMode]}
            </span>
          </button>
          <button
            className={`gz-prompt-slot__vision gz-prompt-slot__vision--${visionEnabled ? "on" : "off"}`}
            type="button"
            aria-label={`Vision describe: ${visionEnabled ? "on" : "off"}`}
            title={
              visionEnabled ? VISION_BUTTON_TITLES.on : VISION_BUTTON_TITLES.off
            }
            onClick={() => onVisionEnabledChange(!visionEnabled)}
          >
            <span aria-hidden="true">◉</span>
          </button>
          {index > 0 && (
            <button
              className="gz-prompt-slot__remove"
              type="button"
              aria-label="Remove slot"
              title="Remove slot"
              onClick={onRemove}
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </div>
      </div>
      {showDerived ? (
        <textarea
          ref={derivedRef}
          className="gz-prompt-slot__derived"
          title="Last generated prompt sent from this slot"
          rows={3}
          readOnly
          placeholder="Generated prompt will appear here..."
          value={slot.derivedText ?? ""}
          style={
            slot.derivedHeight ? { height: slot.derivedHeight } : undefined
          }
        />
      ) : null}
    </div>
  );
}

function Section({
  title,
  sectionKey,
  collapsible,
  children,
  headerAction,
}: {
  title: string;
  /** Required when `collapsible` — keys the persisted expanded/collapsed state. */
  sectionKey?: string;
  collapsible?: boolean;
  children: React.ReactNode;
  /**
   * Optional control shown next to the title in a collapsible header
   * (e.g. a cog). It must `stopPropagation()` on click so it doesn't
   * toggle the section. Ignored for non-collapsible sections.
   */
  headerAction?: React.ReactNode;
}) {
  const sectionsExpanded = useStore((s) => s.sectionsExpanded);
  if (!collapsible || !sectionKey) {
    return (
      <section className="gz-section">
        <h3 className="gz-section__title">{title}</h3>
        <div className="gz-section__body">{children}</div>
      </section>
    );
  }
  const expanded =
    sectionsExpanded[sectionKey] ?? DEFAULT_SECTION_EXPANDED[sectionKey] ?? true;
  const toggle = () => {
    const current = useStore.getState().sectionsExpanded;
    useStore.getState().set("sectionsExpanded", {
      ...current,
      [sectionKey]: !expanded,
    });
  };
  return (
    <section
      className={`gz-section gz-section--collapsible gz-section--key-${sectionKey.replace(/\./g, "-")}${expanded ? "" : " gz-section--collapsed"}`}
    >
      <button
        type="button"
        className="gz-section__title"
        onClick={toggle}
        aria-expanded={expanded}
        // Don't bubble to the panel-header drag handler if the user
        // happens to click inside the section while the panel is being
        // dragged. (The panel header is separate, but defensive.)
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className="gz-section__title-label">
          <span>{title}</span>
          {headerAction}
        </span>
        <span className="gz-section__caret" aria-hidden="true">
          {expanded ? "−" : "+"}
        </span>
      </button>
      <div className="gz-section__body">{children}</div>
    </section>
  );
}

function workflowLabelFromPath(path: string): string {
  return path.split("/").pop()?.replace(/\.json$/, "") ?? path;
}

function samePool(
  left: Record<string, number>,
  right: Record<string, number>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([path, weight]) => right[path] === weight)
  );
}
