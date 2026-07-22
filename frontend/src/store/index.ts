/**
 * gazeCOM application store (Zustand).
 *
 * One typed slice per concern, all flat in a single store. This replaces the
 * legacy state-manager.js + the ~30 `window.*` globals it mirrored to.
 *
 * Persistence: the slice files declare which fields are persistent. The store
 * subscribes once and writes them back via the typed `writeJSON` helper.
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import { type HeatmapStyleName } from "../canvas/Heatmap";
import {
  StorageKeys,
  clearKey,
  readJSON,
  writeJSON,
  type StorageKey,
} from "../lib/persistence";
import {
  EMPTY_SLOT,
  promptSlotsForPersistence,
  type PromptSlots,
} from "../prompts/pool";
import {
  TRACKING_MODE_DEFAULTS,
  type TrackingModeDefaults,
} from "../trackers/trackingDefaults";
import { DEFAULT_EVENT_HISTORY_LENGTH } from "../canvas/EventHistory";
import type { WorkflowDescriptor } from "../generation/workflows";

// ── Slice types ─────────────────────────────────────────────────────────

export type TrackingMode =
  | "webgazer"
  | "handpose"
  | "roam"
  | "roam2"
  | "msi"
  | "cursor"
  | "vlm";

export type CompositeFitTarget = "patch" | "composite";
export type UIScale = 72 | 80 | 100;

export type LLMModel = string;
export type ResettableSection =
  | "prompting"
  | "workflow"
  | "settings"
  | "advanced"
  | "view";

export const DEFAULT_LLM_ENHANCE_PROMPT =
  'Rewrite this into a stronger image-generation prompt:\n\n' +
  '"{prompt}"\n\n' +
  "Return only the rewritten prompt, no explanation.\n" +
  "Keep it concise.";

// VLM-mode point instruction. Mirrors the backend's POINT_SYSTEM_PROMPT
// (routes/llm.py) — sent verbatim on every /api/llm/point request so the two
// never drift. Editable in Advanced settings ("VLM prompt").
export const DEFAULT_VLM_POINT_PROMPT =
  "Look at this image and identify the single most visually salient point — " +
  "the one location a viewer's eye is drawn to first. Respond with ONLY that " +
  "point's coordinates as strict JSON on a 0-1000 grid, where (0,0) is the " +
  "top-left corner and (1000,1000) is the bottom-right corner: " +
  '{"x": <0-1000>, "y": <0-1000>}. No explanation, no other text.';

export interface PatchBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AppState {
  // ── Tracking ──────────────────────────────────────────────────────
  trackingMode: TrackingMode;
  /** Last user-adjusted speed/trail/dot profile for every tracking mode. */
  trackingProfiles: Record<TrackingMode, TrackingModeDefaults>;
  /** True only while the active tracker is feeding the heatmap. */
  trackingActive: boolean;
  /** WebGazer-only — calibration must complete before tracking can start. */
  trackerCalibrated: boolean;
  /**
   * VLM-mode salient point, normalized to [0, 1]. The single source of truth
   * for the machine-driven point: the pipeline writes it after each
   * generation, `VLMTracker` renders it every tick (so it survives heatmap
   * clears/rebuilds like any other tracker's re-emitted points), and
   * `buildInput` reads it for COM. `null` before the first point is set
   * (the tracker then shows the center). Transient — not persisted.
   */
  vlmPoint: { x: number; y: number } | null;
  /**
   * Travel-speed multiplier for the synthetic roamers (roam / roam2).
   * 0.2 = the tuned default; the panel exposes a slider (roam modes only)
   * and `useTracker` pushes changes to the live tracker via `setSpeed`.
   * Ignored by real-input trackers.
   */
  roamSpeed: number;
  /**
   * Trail window length — the count of recent points the heatmap keeps,
   * which shapes the smear. Stored in the active mode's persisted profile,
   * so switching away and back restores that mode's last adjustment.
   * `useTracker` pushes it live via `setTrailLength`.
   * Unused by WebGazer, which has its own discrete event-history limit.
   */
  trailLength: number;
  /**
   * WebGazer-only FIFO capacity. Unlike a spatial trail, this bounds how many
   * discrete gaze events contribute to both the rendered heatmap and COM.
   */
  eventHistoryLength: number;
  /**
   * Gaze-dot radius in canonical 1024px heatmap space. The renderer scales it
   * to the current frame, so every mode and frame zoom has the same geometry.
   * `useHeatmap` pushes it to the live HeatmapInstance.
   */
  pointSize: number;
  /**
   * Random ± canonical-px variation of the dot radius (0 = uniform). Derived
   * per point from its position so sizes are stable across frames.
   */
  pointJitter: number;

  // ── Modes ─────────────────────────────────────────────────────────
  feedbackMode: boolean;
  iterativeMode: boolean;
  iterativeDelay: number;
  /**
   * Runtime flag — true while the iterative loop is actively cycling.
   * Distinct from `iterativeMode` (the panel toggle, a config flag): only
   * the Generate/Stop button flips this. Toggling iterativeMode off does
   * NOT abort an active loop.
   */
  iterativeRunning: boolean;
  comMode: boolean;
  compositeMode: boolean;
  compositeFitEnabled: boolean;
  compositeFitTarget: CompositeFitTarget;

  // ── Generation ────────────────────────────────────────────────────
  /**
   * The workflow rotation pool: workflow path → relative weight (integer
   * 0–100). Any positive total is normalized at selection time. One pin =
   * single workflow per generation, many pins = weighted rotation. Zero pins
   * disables the Generate button.
   */
  pinnedWorkflows: Record<string, number>;
  /** Workflow paths temporarily excluded without changing their weights. */
  mutedWorkflows: string[];
  availableWorkflows: WorkflowDescriptor[];
  /** Currently selected reference image (filename only, e.g. "girl.jpg"). */
  selectedImage: string | null;
  /** List of filenames available under /images/. Refreshed on mount + upload. */
  availableImages: string[];
  /**
   * Step count for the next generation. A picked workflow can declare its
   * own default through {steps:N}; the user can override it between runs.
   */
  steps: number;
  /** True while a generation is in flight; blocks re-entrancy. */
  generationInProgress: boolean;
  /** True if the current composite is the result of one or more generations. */
  isComposited: boolean;

  // ── Images ────────────────────────────────────────────────────────
  baseImageURL: string;
  /** True when `CompositeStore` has a non-empty backing canvas. */
  compositeHasCanvas: boolean;
  /**
   * Incremented whenever the backing composite canvas is replaced or
   * cleared. React components subscribe to this instead of forcing a PNG
   * snapshot through state on every generation.
   */
  compositeRevision: number;
  baseImgPosition: PatchBox;
  baseCOM: { x: number; y: number };
  /**
   * Position of the very first patch in the *current* canvas's coordinate
   * system. Initialized on the first generation, then translated by every
   * `gz-composite-shift` event so it tracks the moving canvas origin —
   * same way `PullTool`'s bbox follows leftward/upward growth. Used to
   * derive the bounds box for `planComposite` when the user enables
   * `boundsEnabled`. `null` means "no generation has happened yet" or
   * "the composite was cleared".
   */
  firstPatchPosition: PatchBox | null;

  // ── Bounds (canvas size cap) ──────────────────────────────────────
  /** When true, clamp the canvas to a `boundsWidth × boundsHeight` window
   *  centered on the first patch. Off by default — preserves the legacy
   *  infinite-canvas behaviour. */
  boundsEnabled: boolean;
  boundsWidth: number;
  boundsHeight: number;

  /**
   * When true, the backend swallows execution errors from cloud-provider
   * nodes (currently `GeminiStudio`) instead of returning 500. The
   * frontend treats the resulting 204 as a silent no-op — handy under
   * iterative mode when Gemini's policy filter refuses sporadically.
   * Default off so real bugs stay loud.
   */
  skipProviderErrors: boolean;
  /**
   * Auto-download the master composite every N successful generations.
   * `null` (or any non-positive value) disables the auto-download.
   * Counter is module-local in `pipeline.ts`; this just controls
   * whether and how often the trigger fires.
   */
  autoDownloadEvery: number | null;
  /**
   * Auto-clear the canvas (and reseed from the selected reference
   * image) every N successful generations. Same cadence pattern as
   * `autoDownloadEvery`; when both fire on the same generation the
   * download runs first so the about-to-be-cleared composite is the
   * one saved to disk.
   */
  autoClearEvery: number | null;
  /**
   * Optional matte behind transparent/empty image regions. When disabled,
   * frame backgrounds follow the active UI theme exactly as before.
   */
  compositeMatteEnabled: boolean;
  heatmapMatteEnabled: boolean;
  /** Hex color used by the opt-in frame mattes. */
  matteColor: string;
  /**
   * Successful patches applied to the canvas since the last clear
   * (manual or auto). Transient — not persisted, since "since clear"
   * is inherently a runtime concept. Surfaced in the panel's bottom
   * utilities row as a small read-only count. Also drives the
   * download / clear cadence modulo checks in `pipeline.ts`.
   */
  patchesSinceClear: number;

  // ── Prompts ───────────────────────────────────────────────────────
  /**
   * Which prompt list is currently being browsed in the panel's List
   * dropdown. The Template dropdown shows templates from this list;
   * picking a template writes its text into the currently-active slot
   * in `pinnedPrompts`. Persisted so the panel reopens to the same
   * list on reload.
   */
  promptList: string;
  /**
   * Prompt rotation pool — an ordered array of editable slots. Each
   * carries its own text, weight (integer 0–100; sum must equal 100
   * for the pool to be valid), and persisted textarea height. Slot 0
   * is the un-removable "base" slot (replaces the legacy standalone
   * prompt textarea).
   */
  pinnedPrompts: PromptSlots;
  llmModel: LLMModel;
  vlmModel: LLMModel;
  llmEnhancePrompt: string;
  /** VLM-mode instruction for locating the salient point (Advanced). */
  vlmPointPrompt: string;
  /** User-resized VLM instruction textarea height in CSS pixels. */
  vlmPointPromptHeight: number;

  // ── Last-pick feedback (transient — not persisted) ───────────────
  /**
   * The workflow path picked by the most recent rotation. The UI
   * bolds the matching row in the workflow pool. Set by the pipeline
   * right after `resolveWorkflow()`. `null` before the first run.
   */
  lastPickedWorkflow: string | null;
  /**
   * The prompt-slot index picked by the most recent rotation. The UI
   * highlights the matching slot. Set by the pipeline right after
   * `pickPromptSlot()`. `null` before the first run / when the
   * picked slot has been removed.
   */
  lastPickedPromptIndex: number | null;

  // ── UI ────────────────────────────────────────────────────────────
  theme: "light" | "dark";
  panelMinimized: boolean;
  /** Pinned position of the control panel (null = default top-right). */
  panelPosition: { left: number; top: number } | null;
  /** Action-bar + control-panel scale percentage. */
  uiScale: UIScale;
  showWelcome: boolean;
  heatmapStyle: HeatmapStyleName;
  cropBoxVisible: boolean;
  /** Pull-box frame width in image-space pixels. */
  cropBoxBorderWidth: number;
  /**
   * Whether the composite canvas frame is visible. When false, the frame
   * is hidden off-screen (not unmounted) so the pipeline can still read
   * its `getBoundingClientRect()` for COM math. The visible sibling
   * centers naturally via `.gz-canvases`'s `justify-content: center`.
   */
  canvasVisible: boolean;
  /**
   * Whether the heatmap frame is visible. Same off-screen trick — the
   * tracker keeps feeding the heatmap as a background process even when
   * the user has hidden it (typical for `roam` mode where the heatmap
   * is just visual noise).
   */
  heatmapVisible: boolean;
  /**
   * Frame zoom as a percentage (40–100). Scales the composite + heatmap
   * frames uniformly via the `--gz-frame-scale` CSS var so they fit smaller
   * screens or a two-frame layout. It resizes the frames (not a CSS
   * transform), so tracker/COM coordinates — which read live container size
   * and are normalized — stay correct. 100 = full size.
   */
  frameZoom: number;
  /** When opening a top-level control section, close the other sections. */
  autoCollapsePanels: boolean;
  calibCache: boolean;
  /**
   * Per-section expanded/collapsed state for the control-panel's
   * collapsible sections. Keys match the `sectionKey` passed to each
   * `<Section>`. Missing keys fall back to the per-section default
   * (see `defaultSectionExpanded` in ControlPanel).
   */
  sectionsExpanded: Record<string, boolean>;
}

export type AppActions = {
  set: <K extends keyof AppState>(key: K, value: AppState[K]) => void;
  patch: (partial: Partial<AppState>) => void;
  resetGeneration: () => void;
  resetSection: (section: ResettableSection) => void;
};

const SECTION_STORAGE_KEYS: Record<ResettableSection, readonly StorageKey[]> = {
  prompting: [
    StorageKeys.promptList,
    StorageKeys.pinnedPrompts,
    StorageKeys.llmModel,
    StorageKeys.llmEnhancePrompt,
  ],
  workflow: [
    StorageKeys.pinnedWorkflows,
    StorageKeys.mutedWorkflows,
    StorageKeys.steps,
  ],
  settings: [
    StorageKeys.trackingMode,
    StorageKeys.trackingProfiles,
    StorageKeys.eventHistoryLength,
    StorageKeys.heatmapStyle,
    StorageKeys.selectedImage,
    StorageKeys.feedbackMode,
    StorageKeys.comMode,
    StorageKeys.compositeMode,
    StorageKeys.iterativeMode,
    StorageKeys.iterativeDelay,
  ],
  advanced: [
    StorageKeys.compositeMatteEnabled,
    StorageKeys.heatmapMatteEnabled,
    StorageKeys.matteEnabled,
    StorageKeys.matteColor,
    StorageKeys.autoDownloadEvery,
    StorageKeys.autoClearEvery,
    StorageKeys.boundsEnabled,
    StorageKeys.boundsWidth,
    StorageKeys.boundsHeight,
    StorageKeys.vlmModel,
    StorageKeys.vlmPointPrompt,
    StorageKeys.vlmPointPromptHeight,
    StorageKeys.calibCache,
  ],
  view: [
    StorageKeys.compositeFitEnabled,
    StorageKeys.compositeFitTarget,
    StorageKeys.cropBoxVisible,
    StorageKeys.cropBoxBorderWidth,
    StorageKeys.canvasVisible,
    StorageKeys.heatmapVisible,
  ],
};

// ── Initial state, hydrated from localStorage ───────────────────────────

function loadInitial(): AppState {
  const trackingMode = readJSON<TrackingMode>(StorageKeys.trackingMode, "roam");
  const trackingProfiles = loadTrackingProfiles();
  const trackingProfile = trackingProfiles[trackingMode];
  const pinnedWorkflows = readJSON<Record<string, number>>(
    StorageKeys.pinnedWorkflows,
    {},
  );
  const storedMutedWorkflows = readJSON<unknown>(StorageKeys.mutedWorkflows, []);
  const mutedWorkflows = Array.isArray(storedMutedWorkflows)
    ? [
        ...new Set(
          storedMutedWorkflows.filter(
            (path): path is string => typeof path === "string",
          ),
        ),
      ]
    : [];
  return {
    trackingMode,
    trackingProfiles,
    trackingActive: false,
    trackerCalibrated: false,
    vlmPoint: null,
    roamSpeed: trackingProfile.roamSpeed,
    trailLength: trackingProfile.trailLength,
    eventHistoryLength: readJSON<number>(
      StorageKeys.eventHistoryLength,
      DEFAULT_EVENT_HISTORY_LENGTH,
    ),
    pointSize: trackingProfile.pointSize,
    pointJitter: trackingProfile.pointJitter,

    feedbackMode: readJSON<boolean>(StorageKeys.feedbackMode, true),
    iterativeMode: readJSON<boolean>(StorageKeys.iterativeMode, false),
    iterativeDelay: readJSON<number>(StorageKeys.iterativeDelay, 0),
    iterativeRunning: false,
    comMode: readJSON<boolean>(StorageKeys.comMode, false),
    compositeMode: readJSON<boolean>(StorageKeys.compositeMode, true),
    compositeFitEnabled: readJSON<boolean>(StorageKeys.compositeFitEnabled, true),
    compositeFitTarget: readJSON<CompositeFitTarget>(
      StorageKeys.compositeFitTarget,
      "composite",
    ),
    boundsEnabled: readJSON<boolean>(StorageKeys.boundsEnabled, false),
    boundsWidth: readJSON<number>(StorageKeys.boundsWidth, 2048),
    boundsHeight: readJSON<number>(StorageKeys.boundsHeight, 2048),
    skipProviderErrors: readJSON<boolean>(StorageKeys.skipProviderErrors, false),
    autoDownloadEvery: readJSON<number | null>(StorageKeys.autoDownloadEvery, null),
    autoClearEvery: readJSON<number | null>(StorageKeys.autoClearEvery, null),
    compositeMatteEnabled: readJSON<boolean>(
      StorageKeys.compositeMatteEnabled,
      readJSON<boolean>(StorageKeys.matteEnabled, false),
    ),
    heatmapMatteEnabled: readJSON<boolean>(
      StorageKeys.heatmapMatteEnabled,
      readJSON<boolean>(StorageKeys.matteEnabled, false),
    ),
    matteColor: normalizeHexColor(
      readJSON<string>(StorageKeys.matteColor, "#808080"),
      "#808080",
    ),
    patchesSinceClear: 0,

    pinnedWorkflows,
    mutedWorkflows,
    availableWorkflows: [],
    selectedImage: readJSON<string | null>(StorageKeys.selectedImage, null),
    availableImages: [],
    steps: readJSON<number>(StorageKeys.steps, 10),
    generationInProgress: false,
    isComposited: false,

    baseImageURL: "",
    compositeHasCanvas: false,
    compositeRevision: 0,
    baseImgPosition: { x: 0, y: 0, width: 0, height: 0 },
    baseCOM: { x: 0.5, y: 0.5 },
    firstPatchPosition: null,

    promptList: readJSON<string>(StorageKeys.promptList, "Secession Trees Art"),
    // Fresh installs get a single base slot with weight 100 (sum=100,
    // valid out of the box). Reads any legacy persisted value via
    // readJSON; if the shape is the old Record<string, number> it'll
    // deserialize as an array-ish object that fails the array check
    // and we fall back to the default. Single-user project, no
    // explicit migration plumbing.
    pinnedPrompts: ((): PromptSlots => {
      const raw = readJSON<unknown>(StorageKeys.pinnedPrompts, null);
      if (Array.isArray(raw) && raw.length > 0) {
        return promptSlotsForPersistence(raw as PromptSlots);
      }
      return [{ ...EMPTY_SLOT, weight: 100 }];
    })(),
    llmModel: readJSON<LLMModel>(StorageKeys.llmModel, ""),
    vlmModel: readJSON<LLMModel>(StorageKeys.vlmModel, ""),
    llmEnhancePrompt: readJSON<string>(
      StorageKeys.llmEnhancePrompt,
      DEFAULT_LLM_ENHANCE_PROMPT,
    ),
    vlmPointPrompt: readJSON<string>(
      StorageKeys.vlmPointPrompt,
      DEFAULT_VLM_POINT_PROMPT,
    ),
    vlmPointPromptHeight: readJSON<number>(
      StorageKeys.vlmPointPromptHeight,
      60,
    ),

    lastPickedWorkflow: null,
    lastPickedPromptIndex: null,

    theme: readJSON<"light" | "dark">(StorageKeys.theme, "light"),
    panelMinimized: readJSON<boolean>(StorageKeys.panelMinimized, false),
    panelPosition: readJSON<{ left: number; top: number } | null>(
      StorageKeys.panelPosition,
      null,
    ),
    uiScale: readJSON<UIScale>(StorageKeys.uiScale, 80),
    showWelcome: readJSON<boolean>(StorageKeys.showWelcome, true),
    heatmapStyle: readJSON<HeatmapStyleName>(
      StorageKeys.heatmapStyle,
      "moire",
    ),
    cropBoxVisible: readJSON<boolean>(StorageKeys.cropBoxVisible, true),
    cropBoxBorderWidth: readJSON<number>(StorageKeys.cropBoxBorderWidth, 4),
    canvasVisible: readJSON<boolean>(StorageKeys.canvasVisible, true),
    heatmapVisible: readJSON<boolean>(StorageKeys.heatmapVisible, true),
    frameZoom: readJSON<number>(StorageKeys.frameZoom, 85),
    autoCollapsePanels: readJSON<boolean>(
      StorageKeys.autoCollapsePanels,
      false,
    ),
    calibCache: readJSON<boolean>(StorageKeys.calibCache, true),
    sectionsExpanded: readJSON<Record<string, boolean>>(
      StorageKeys.sectionsExpanded,
      {},
    ),
  };
}

function loadTrackingProfiles(): Record<TrackingMode, TrackingModeDefaults> {
  const stored = readJSON<
    Partial<Record<TrackingMode, Partial<TrackingModeDefaults>>>
  >(StorageKeys.trackingProfiles, {});
  return Object.fromEntries(
    (Object.keys(TRACKING_MODE_DEFAULTS) as TrackingMode[]).map((mode) => [
      mode,
      { ...TRACKING_MODE_DEFAULTS[mode], ...stored[mode] },
    ]),
  ) as Record<TrackingMode, TrackingModeDefaults>;
}

function isTrackingProfileField(
  key: keyof AppState,
): key is keyof TrackingModeDefaults {
  return (
    key === "roamSpeed" ||
    key === "trailLength" ||
    key === "pointSize" ||
    key === "pointJitter"
  );
}

function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

// ── Persistence map: which fields persist, and under which key ──────────

const PERSISTENT_FIELDS: ReadonlyArray<readonly [keyof AppState, StorageKey]> = [
  ["trackingMode", StorageKeys.trackingMode],
  ["trackingProfiles", StorageKeys.trackingProfiles],
  ["eventHistoryLength", StorageKeys.eventHistoryLength],
  ["feedbackMode", StorageKeys.feedbackMode],
  ["iterativeMode", StorageKeys.iterativeMode],
  ["iterativeDelay", StorageKeys.iterativeDelay],
  ["comMode", StorageKeys.comMode],
  ["compositeMode", StorageKeys.compositeMode],
  ["compositeFitEnabled", StorageKeys.compositeFitEnabled],
  ["compositeFitTarget", StorageKeys.compositeFitTarget],
  ["boundsEnabled", StorageKeys.boundsEnabled],
  ["boundsWidth", StorageKeys.boundsWidth],
  ["boundsHeight", StorageKeys.boundsHeight],
  ["skipProviderErrors", StorageKeys.skipProviderErrors],
  ["autoDownloadEvery", StorageKeys.autoDownloadEvery],
  ["autoClearEvery", StorageKeys.autoClearEvery],
  ["compositeMatteEnabled", StorageKeys.compositeMatteEnabled],
  ["heatmapMatteEnabled", StorageKeys.heatmapMatteEnabled],
  ["matteColor", StorageKeys.matteColor],
  ["pinnedWorkflows", StorageKeys.pinnedWorkflows],
  ["mutedWorkflows", StorageKeys.mutedWorkflows],
  ["selectedImage", StorageKeys.selectedImage],
  ["steps", StorageKeys.steps],
  ["promptList", StorageKeys.promptList],
  ["llmModel", StorageKeys.llmModel],
  ["vlmModel", StorageKeys.vlmModel],
  ["llmEnhancePrompt", StorageKeys.llmEnhancePrompt],
  ["vlmPointPrompt", StorageKeys.vlmPointPrompt],
  ["vlmPointPromptHeight", StorageKeys.vlmPointPromptHeight],
  ["theme", StorageKeys.theme],
  ["panelMinimized", StorageKeys.panelMinimized],
  ["panelPosition", StorageKeys.panelPosition],
  ["uiScale", StorageKeys.uiScale],
  ["showWelcome", StorageKeys.showWelcome],
  ["heatmapStyle", StorageKeys.heatmapStyle],
  ["cropBoxVisible", StorageKeys.cropBoxVisible],
  ["cropBoxBorderWidth", StorageKeys.cropBoxBorderWidth],
  ["canvasVisible", StorageKeys.canvasVisible],
  ["heatmapVisible", StorageKeys.heatmapVisible],
  ["frameZoom", StorageKeys.frameZoom],
  ["autoCollapsePanels", StorageKeys.autoCollapsePanels],
  ["calibCache", StorageKeys.calibCache],
  ["sectionsExpanded", StorageKeys.sectionsExpanded],
];

// ── Store ───────────────────────────────────────────────────────────────

export const useStore = create<AppState & AppActions>()(
  subscribeWithSelector((set) => ({
    ...loadInitial(),
    set: (key, value) => {
      if (key === "trackingMode") {
        const mode = value as TrackingMode;
        set((state) => ({
          trackingMode: mode,
          ...state.trackingProfiles[mode],
        }));
        return;
      }
      if (isTrackingProfileField(key)) {
        set((state) => ({
          [key]: value,
          trackingProfiles: {
            ...state.trackingProfiles,
            [state.trackingMode]: {
              ...state.trackingProfiles[state.trackingMode],
              [key]: value,
            },
          },
        }));
        return;
      }
      set({ [key]: value } as Partial<AppState>);
    },
    patch: (partial) => set(partial),
    resetGeneration: () =>
      set((state) => ({
        compositeHasCanvas: false,
        compositeRevision: state.compositeRevision + 1,
        baseImageURL: "",
        baseImgPosition: { x: 0, y: 0, width: 0, height: 0 },
        baseCOM: { x: 0.5, y: 0.5 },
        firstPatchPosition: null,
        isComposited: false,
        generationInProgress: false,
      })),
    resetSection: (section) => {
      for (const key of SECTION_STORAGE_KEYS[section]) clearKey(key);
      const defaults = loadInitial();

      switch (section) {
        case "prompting":
          set({
            promptList: defaults.promptList,
            pinnedPrompts: defaults.pinnedPrompts,
            llmModel: defaults.llmModel,
            llmEnhancePrompt: defaults.llmEnhancePrompt,
            lastPickedPromptIndex: null,
          });
          break;
        case "workflow":
          set({
            pinnedWorkflows: defaults.pinnedWorkflows,
            mutedWorkflows: defaults.mutedWorkflows,
            steps: defaults.steps,
            lastPickedWorkflow: null,
          });
          break;
        case "settings":
          set((state) => ({
            trackingMode: defaults.trackingMode,
            trackingProfiles: defaults.trackingProfiles,
            roamSpeed: defaults.roamSpeed,
            trailLength: defaults.trailLength,
            eventHistoryLength: defaults.eventHistoryLength,
            pointSize: defaults.pointSize,
            pointJitter: defaults.pointJitter,
            heatmapStyle: defaults.heatmapStyle,
            selectedImage: state.availableImages[0] ?? defaults.selectedImage,
            feedbackMode: defaults.feedbackMode,
            comMode: defaults.comMode,
            compositeMode: defaults.compositeMode,
            iterativeMode: defaults.iterativeMode,
            iterativeDelay: defaults.iterativeDelay,
            trackingActive: false,
            iterativeRunning: false,
            vlmPoint: null,
          }));
          break;
        case "advanced":
          set({
            compositeMatteEnabled: defaults.compositeMatteEnabled,
            heatmapMatteEnabled: defaults.heatmapMatteEnabled,
            matteColor: defaults.matteColor,
            autoDownloadEvery: defaults.autoDownloadEvery,
            autoClearEvery: defaults.autoClearEvery,
            boundsEnabled: defaults.boundsEnabled,
            boundsWidth: defaults.boundsWidth,
            boundsHeight: defaults.boundsHeight,
            vlmModel: defaults.vlmModel,
            vlmPointPrompt: defaults.vlmPointPrompt,
            vlmPointPromptHeight: defaults.vlmPointPromptHeight,
            calibCache: defaults.calibCache,
            vlmPoint: null,
          });
          break;
        case "view":
          set({
            compositeFitEnabled: defaults.compositeFitEnabled,
            compositeFitTarget: defaults.compositeFitTarget,
            cropBoxVisible: defaults.cropBoxVisible,
            cropBoxBorderWidth: defaults.cropBoxBorderWidth,
            canvasVisible: defaults.canvasVisible,
            heatmapVisible: defaults.heatmapVisible,
          });
          break;
      }
    },
  })),
);

// ── Wire persistence: one subscription per persistent field ─────────────

for (const [field, key] of PERSISTENT_FIELDS) {
  useStore.subscribe(
    (s) => s[field],
    (value) => writeJSON(key, value),
  );
}

useStore.subscribe(
  (s) => s.pinnedPrompts,
  (value) =>
    writeJSON(StorageKeys.pinnedPrompts, promptSlotsForPersistence(value)),
);

// Revoke replaced `baseImageURL` blob URLs so they don't accumulate in
// memory. `URL.createObjectURL` pins the underlying Blob (a full PNG,
// megabytes) until `revokeObjectURL` is called — GC can't reclaim it — so
// every generated / pulled / preview image that flows through
// `baseImageURL` would otherwise leak until a page reload. Whenever the
// value changes to a different one, the previous blob URL is freed (with a
// 1s defer so any consumer still rendering the old URL — e.g. the heatmap
// background — can swap first). Non-blob values (data:, "") are ignored.
let prevBaseImageURL = useStore.getState().baseImageURL;
useStore.subscribe(
  (s) => s.baseImageURL,
  (url) => {
    const old = prevBaseImageURL;
    prevBaseImageURL = url;
    if (old && old !== url && old.startsWith("blob:")) {
      setTimeout(() => URL.revokeObjectURL(old), 1000);
    }
  },
);
