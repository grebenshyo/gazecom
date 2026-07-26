/**
 * Typed `localStorage` helpers and a tiny Zustand persistence helper.
 *
 * Replaces the ~15 scattered `localStorage.setItem` / `localStorage.getItem`
 * calls in legacy ui-controller.js. Centralizing the keys here means renaming
 * a key is a one-line change and stale keys can't accumulate.
 */

/** All localStorage keys used by gazeCOM. */
export const StorageKeys = {
  // tracking
  trackingMode: "gazecom.trackingMode",
  trackingProfiles: "gazecom.trackingProfiles",
  eventHistoryLength: "gazecom.eventHistoryLength",
  // modes
  feedbackMode: "gazecom.feedbackMode",
  iterativeMode: "gazecom.iterativeMode",
  iterativeDelay: "gazecom.iterativeDelay",
  comMode: "gazecom.comMode",
  compositeMode: "gazecom.compositeMode",
  compositeFitEnabled: "gazecom.compositeFitEnabled",
  compositeFitTarget: "gazecom.compositeFitTarget",
  canvasVisible: "gazecom.canvasVisible",
  heatmapVisible: "gazecom.heatmapVisible",
  frameZoom: "gazecom.frameZoom",
  autoCollapsePanels: "gazecom.autoCollapsePanels",
  boundsEnabled: "gazecom.boundsEnabled",
  boundsWidth: "gazecom.boundsWidth",
  boundsHeight: "gazecom.boundsHeight",
  skipProviderErrors: "gazecom.skipProviderErrors",
  autoDownloadEvery: "gazecom.autoDownloadEvery",
  autoClearEvery: "gazecom.autoClearEvery",
  compositeMatteEnabled: "gazecom.compositeMatteEnabled",
  heatmapMatteEnabled: "gazecom.heatmapMatteEnabled",
  matteColor: "gazecom.matteColor",
  // generation
  pinnedWorkflows: "gazecom.pinnedWorkflows",
  mutedWorkflows: "gazecom.mutedWorkflows",
  selectedImage: "gazecom.selectedImage",
  steps: "gazecom.steps",
  // prompts
  promptList: "gazecom.promptList",
  pinnedPrompts: "gazecom.pinnedPrompts",
  llmModel: "gazecom.llmModel",
  llmThinkingMode: "gazecom.llmThinkingMode",
  vlmModel: "gazecom.vlmModel",
  vlmThinkingMode: "gazecom.vlmThinkingMode",
  vlmBehavior: "gazecom.vlmBehavior",
  vlmGuidePromptChoice: "gazecom.vlmGuidePromptChoice",
  vlmGuideHistoryLimit: "gazecom.vlmGuideHistoryLimit",
  vlmScope: "gazecom.vlmScope",
  llmEnhancePrompt: "gazecom.llmEnhancePrompt",
  vlmPointPrompt: "gazecom.vlmPointPrompt",
  vlmGuidePrompt: "gazecom.vlmGuidePrompt",
  vlmSelectPrompt: "gazecom.vlmSelectPrompt",
  vlmComposePrompt: "gazecom.vlmComposePrompt",
  vlmHybridPrompt: "gazecom.vlmHybridPrompt",
  vlmPointPromptHeight: "gazecom.vlmPointPromptHeight",
  vlmGuideActionHeight: "gazecom.vlmGuideActionHeight",
  // ui
  theme: "gazecom.theme",
  panelPosition: "gazecom.panelPosition",
  panelMinimized: "gazecom.panelMinimized",
  uiScale: "gazecom.uiScale",
  showWelcome: "gazecom.showWelcome",
  heatmapStyle: "gazecom.heatmapStyle",
  cropBoxVisible: "gazecom.cropBoxVisible",
  cropBoxBorderWidth: "gazecom.cropBoxBorderWidth",
  calibCache: "gazecom.calibCache",
  sectionsExpanded: "gazecom.sectionsExpanded",
} as const;

export type StorageKey = (typeof StorageKeys)[keyof typeof StorageKeys];

const SETTINGS_FILE_FORMAT = "gazeCOM-settings";
const SETTINGS_FILE_SCHEMA = 2;
const EXPORTABLE_SETTINGS = Object.entries(StorageKeys) as Array<
  [keyof typeof StorageKeys, StorageKey]
>;
const EXPORTABLE_SETTING_NAMES = new Map(EXPORTABLE_SETTINGS);

export interface SettingsFile {
  format: typeof SETTINGS_FILE_FORMAT;
  schema: typeof SETTINGS_FILE_SCHEMA;
  exportedAt: string;
  settings: Partial<Record<keyof typeof StorageKeys, unknown>>;
}

/** Read a typed JSON value, returning `fallback` on miss/error. */
export function readJSON<T>(key: StorageKey, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Write a JSON value. Errors (quota, private browsing) are swallowed. */
export function writeJSON(key: StorageKey, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

/** Remove a key. */
export function clearKey(key: StorageKey): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
}

/** Wipe all gazeCOM keys. Used by the "Reset All Settings" button. */
export function clearAllGazeComKeys(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("gazecom.")) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* non-fatal */
  }
}

/** Build a portable snapshot of browser-persisted app settings. */
export function createSettingsFile(): SettingsFile {
  const settings: SettingsFile["settings"] = {};
  for (const [name, key] of EXPORTABLE_SETTINGS) {
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    try {
      const value = JSON.parse(raw) as unknown;
      if (isValidSetting(name, value)) settings[name] = value;
    } catch {
      // Malformed local values already fall back at runtime; omit them so an
      // imported file likewise falls back to the fresh-install default.
    }
  }
  return {
    format: SETTINGS_FILE_FORMAT,
    schema: SETTINGS_FILE_SCHEMA,
    exportedAt: new Date().toISOString(),
    settings,
  };
}

/** Validate and replace all browser-persisted app settings from a JSON file. */
export function applySettingsFile(input: unknown): number {
  if (!isRecord(input) || input.format !== SETTINGS_FILE_FORMAT) {
    throw new Error("This is not a gazeCOM settings file.");
  }
  if (input.schema !== SETTINGS_FILE_SCHEMA) {
    throw new Error(`Unsupported settings schema: ${String(input.schema)}.`);
  }
  if (!isRecord(input.settings)) {
    throw new Error("The settings file has no valid settings object.");
  }

  const accepted: Array<[StorageKey, unknown]> = [];
  for (const [name, value] of Object.entries(input.settings)) {
    const key = EXPORTABLE_SETTING_NAMES.get(name as keyof typeof StorageKeys);
    if (!key) continue;
    if (!isValidSetting(name as keyof typeof StorageKeys, value)) {
      throw new Error(`Invalid value for setting "${name}".`);
    }
    accepted.push([key, value]);
  }

  // Missing values intentionally become fresh-install defaults. Clear only
  // gazeCOM's browser settings; service hosts live in the backend and remain
  // machine-local.
  clearAllGazeComKeys();
  for (const [key, value] of accepted) writeJSON(key, value);
  return accepted.length;
}

function isValidSetting(name: keyof typeof StorageKeys, value: unknown): boolean {
  switch (name) {
    case "trackingMode":
      return isOneOf(value, [
        "webgazer",
        "handpose",
        "roam",
        "roam2",
        "msi",
        "cursor",
        "vlm",
      ]);
    case "trackingProfiles":
      return (
        isRecord(value) &&
        Object.values(value).every(
          (profile) =>
            isRecord(profile) &&
            Object.entries(profile).every(
              ([field, fieldValue]) =>
                ["roamSpeed", "trailLength", "pointSize", "pointJitter"].includes(
                  field,
                ) && isFiniteNumber(fieldValue),
            ),
        )
      );
    case "feedbackMode":
    case "iterativeMode":
    case "comMode":
    case "compositeMode":
    case "compositeFitEnabled":
    case "autoCollapsePanels":
    case "canvasVisible":
    case "heatmapVisible":
    case "boundsEnabled":
    case "skipProviderErrors":
    case "compositeMatteEnabled":
    case "heatmapMatteEnabled":
    case "panelMinimized":
    case "showWelcome":
    case "cropBoxVisible":
    case "calibCache":
      return typeof value === "boolean";
    case "eventHistoryLength":
    case "iterativeDelay":
    case "frameZoom":
    case "boundsWidth":
    case "boundsHeight":
    case "cropBoxBorderWidth":
    case "vlmPointPromptHeight":
    case "vlmGuideActionHeight":
      return isFiniteNumber(value);
    case "steps":
      return value === null || isFiniteNumber(value);
    case "autoDownloadEvery":
    case "autoClearEvery":
      return value === null || isFiniteNumber(value);
    case "compositeFitTarget":
      return isOneOf(value, ["patch", "composite"]);
    case "pinnedWorkflows":
      return isNumberRecord(value);
    case "mutedWorkflows":
      return Array.isArray(value) && value.every((path) => typeof path === "string");
    case "selectedImage":
      return value === null || typeof value === "string";
    case "promptList":
    case "llmModel":
    case "vlmModel":
    case "llmEnhancePrompt":
    case "vlmPointPrompt":
    case "vlmGuidePrompt":
    case "vlmSelectPrompt":
    case "vlmComposePrompt":
    case "vlmHybridPrompt":
      return typeof value === "string";
    case "vlmBehavior":
      return isOneOf(value, ["point", "guide"]);
    case "vlmGuidePromptChoice":
      return isOneOf(value, ["rotate", "select", "compose", "hybrid"]);
    case "vlmGuideHistoryLimit":
      return (
        isFiniteNumber(value) &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 100
      );
    case "llmThinkingMode":
    case "vlmThinkingMode":
      return isOneOf(value, ["off", "on", "low", "medium", "high", "max"]);
    case "vlmScope":
      return isOneOf(value, ["frame", "canvas"]);
    case "pinnedPrompts":
      return isPromptSlots(value);
    case "theme":
      return isOneOf(value, ["light", "dark"]);
    case "panelPosition":
      return (
        value === null ||
        (isRecord(value) &&
          isFiniteNumber(value.left) &&
          isFiniteNumber(value.top))
      );
    case "uiScale":
      return value === 72 || value === 80 || value === 100;
    case "heatmapStyle":
      return isOneOf(value, ["moire", "classic", "grayscale", "spectral"]);
    case "matteColor":
      return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
    case "sectionsExpanded":
      return isBooleanRecord(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOneOf(value: unknown, options: readonly string[]): boolean {
  return typeof value === "string" && options.includes(value);
}

function isNumberRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isFiniteNumber);
}

function isBooleanRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "boolean");
}

function isPromptSlots(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (slot) =>
        isRecord(slot) &&
        typeof slot.text === "string" &&
        isFiniteNumber(slot.weight) &&
        (slot.muted === undefined || typeof slot.muted === "boolean") &&
        (slot.height === null || isFiniteNumber(slot.height)) &&
        (slot.autoEnhanceMode === undefined ||
          isOneOf(slot.autoEnhanceMode, ["off", "send", "evolve"])) &&
        (slot.visionEnabled === undefined ||
          typeof slot.visionEnabled === "boolean") &&
        (slot.derivedText === undefined || typeof slot.derivedText === "string") &&
        (slot.derivedHeight === undefined ||
          slot.derivedHeight === null ||
          isFiniteNumber(slot.derivedHeight)),
    )
  );
}
