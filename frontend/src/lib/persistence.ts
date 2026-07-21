/**
 * Typed `localStorage` helpers and a tiny Zustand persistence helper.
 *
 * Replaces the ~15 scattered `localStorage.setItem` / `localStorage.getItem`
 * calls in legacy ui-controller.js. Centralizing the keys here means renaming
 * a key is a one-line change and stale keys can't accumulate.
 */

/** All localStorage keys used by gazeCOM. Legacy key names preserve settings. */
export const StorageKeys = {
  // tracking
  trackingMode: "gengaze.trackingMode",
  trackingProfiles: "gengaze.trackingProfiles",
  roamSpeed: "gengaze.roamSpeed",
  trailLength: "gengaze.trailLength",
  eventHistoryLength: "gengaze.eventHistoryLength",
  pointSize: "gengaze.pointSize",
  pointJitter: "gengaze.pointJitter",
  // modes
  feedbackMode: "gengaze.feedbackMode",
  iterativeMode: "gengaze.iterativeMode",
  iterativeDelay: "gengaze.iterativeDelay",
  comMode: "gengaze.comMode",
  compositeMode: "gengaze.compositeMode",
  compositeFitEnabled: "gengaze.compositeFitEnabled",
  compositeFitTarget: "gengaze.compositeFitTarget",
  canvasVisible: "gengaze.canvasVisible",
  heatmapVisible: "gengaze.heatmapVisible",
  frameZoom: "gengaze.frameZoom",
  boundsEnabled: "gengaze.boundsEnabled",
  boundsWidth: "gengaze.boundsWidth",
  boundsHeight: "gengaze.boundsHeight",
  skipProviderErrors: "gengaze.skipProviderErrors",
  autoDownloadEvery: "gengaze.autoDownloadEvery",
  autoClearEvery: "gengaze.autoClearEvery",
  matteEnabled: "gengaze.matteEnabled",
  compositeMatteEnabled: "gengaze.compositeMatteEnabled",
  heatmapMatteEnabled: "gengaze.heatmapMatteEnabled",
  matteColor: "gengaze.matteColor",
  // generation
  pinnedWorkflows: "gengaze.pinnedWorkflows",
  selectedImage: "gengaze.selectedImage",
  steps: "gengaze.steps",
  // prompts
  promptList: "gengaze.promptList",
  pinnedPrompts: "gengaze.pinnedPrompts",
  llmModel: "gengaze.llmModel",
  vlmModel: "gengaze.vlmModel",
  llmEnhancePrompt: "gengaze.llmEnhancePrompt",
  vlmPointPrompt: "gengaze.vlmPointPrompt",
  // ui
  theme: "gengaze.theme",
  panelPosition: "gengaze.panelPosition",
  panelMinimized: "gengaze.panelMinimized",
  uiScale: "gengaze.uiScale",
  showWelcome: "gengaze.showWelcome",
  heatmapStyle: "gengaze.heatmapStyle",
  cropBoxVisible: "gengaze.cropBoxVisible",
  cropBoxBorderWidth: "gengaze.cropBoxBorderWidth",
  calibCache: "gengaze.calibCache",
  sectionsExpanded: "gengaze.sectionsExpanded",
} as const;

export type StorageKey = (typeof StorageKeys)[keyof typeof StorageKeys];

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
export function clearAllGenGazeKeys(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("gengaze.")) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* non-fatal */
  }
}
