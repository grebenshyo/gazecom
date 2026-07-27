/** Help and runtime settings drawers. */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  guideHeaderHtml,
  guideHtml,
  guideSections,
} from "virtual:gazecom-guide";
import { useStore, type UIScale } from "../store";
import {
  applySettingsFile,
  clearAllGazeComKeys,
  createSettingsFile,
} from "../lib/persistence";
import {
  fetchConfig,
  resetConfig,
  setComfyHost as apiSetComfyHost,
  setOllamaHost as apiSetOllamaHost,
  setOllamaKeepModelLoaded as apiSetOllamaKeepModelLoaded,
} from "../generation/api";
import { Button, Toggle } from "./components";
import "./Drawers.css";

const UI_SCALE_OPTIONS: ReadonlyArray<{ value: UIScale; label: string }> = [
  { value: 72, label: "Compact" },
  { value: 80, label: "Medium" },
  { value: 100, label: "Large" },
];

export function Drawers() {
  const [open, setOpen] = useState<"help" | "settings" | null>(null);
  const uiScale = useStore((s) => s.uiScale);
  const scale = uiScale / 100;
  const drawerStyle = {
    "--gz-drawer-scale": String(scale),
    "--gz-drawer-top": `${56 / scale}px`,
    "--gz-drawer-right": `${16 / scale}px`,
    "--gz-drawer-max-height": `calc(${100 / scale}vh - ${80 / scale}px)`,
  } as CSSProperties;

  const drawer =
    open === "help" ? (
      <HelpPanel style={drawerStyle} onClose={() => setOpen(null)} />
    ) : open === "settings" ? (
      <SettingsPanel style={drawerStyle} onClose={() => setOpen(null)} />
    ) : null;

  return (
    <>
      <button
        className="gz-drawer-trigger"
        aria-label="Settings"
        title="Settings"
        onClick={() => setOpen(open === "settings" ? null : "settings")}
      >
        ⚙
      </button>
      <button
        className="gz-drawer-trigger"
        aria-label="Help"
        title="Help"
        onClick={() => setOpen(open === "help" ? null : "help")}
      >
        ?
      </button>
      {drawer ? createPortal(drawer, document.body) : null}
    </>
  );
}

function HelpPanel({
  onClose,
  style,
}: {
  onClose: () => void;
  style: CSSProperties;
}) {
  const jumpTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  return (
    <aside className="gz-drawer" style={style}>
      <button
        className="gz-drawer-close"
        aria-label="Close"
        onClick={onClose}
      >
        ×
      </button>
      <div className="gz-drawer-content gz-guide">
        <div
          className="gz-guide-header"
          // GUIDE.md is repository-owned and compiled by Vite at build time.
          dangerouslySetInnerHTML={{ __html: guideHeaderHtml }}
        />
        <nav className="gz-guide-nav" aria-label="Guide sections">
          <span>Jump to</span>
          <div>
            {guideSections.map(({ id, label }) => (
              <button key={id} type="button" onClick={() => jumpTo(id)}>
                {label}
              </button>
            ))}
          </div>
        </nav>

        <div
          className="gz-guide-markdown"
          dangerouslySetInnerHTML={{ __html: guideHtml }}
        />
      </div>
    </aside>
  );
}

function SettingsPanel({
  onClose,
  style,
}: {
  onClose: () => void;
  style: CSSProperties;
}) {
  const showWelcome = useStore((s) => s.showWelcome);
  const skipProviderErrors = useStore((s) => s.skipProviderErrors);
  const uiScale = useStore((s) => s.uiScale);
  const autoCollapsePanels = useStore((s) => s.autoCollapsePanels);
  const set = useStore((s) => s.set);

  // Runtime service hosts — server-side config persisted per-user by the
  // backend, so packaged builds can be pointed at local services without
  // editing any file. Loaded from the backend on open; saved on blur / Enter.
  const [comfyHost, setComfyHost] = useState("");
  const [comfyHostInput, setComfyHostInput] = useState("");
  const [ollamaHost, setOllamaHost] = useState("");
  const [ollamaHostInput, setOllamaHostInput] = useState("");
  const [serviceConfigLoaded, setServiceConfigLoaded] = useState(false);
  const [ollamaKeepModelLoaded, setOllamaKeepModelLoadedInput] =
    useState(false);
  const [comfyHostStatus, setComfyHostStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [ollamaHostStatus, setOllamaHostStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [ollamaKeepStatus, setOllamaKeepStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [comfyHostError, setComfyHostError] = useState("");
  const [ollamaHostError, setOllamaHostError] = useState("");
  const [ollamaKeepError, setOllamaKeepError] = useState("");
  const [settingsFileError, setSettingsFileError] = useState("");
  const settingsFileInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    let alive = true;
    fetchConfig()
      .then((c) => {
        if (!alive) return;
        setComfyHost(c.comfy_host);
        setComfyHostInput(c.comfy_host_override ?? "");
        setOllamaHost(c.ollama_host);
        setOllamaHostInput(c.ollama_host_override ?? "");
        setOllamaKeepModelLoadedInput(c.ollama_keep_model_loaded);
        setServiceConfigLoaded(true);
      })
      .catch(() => {
        if (alive) setServiceConfigLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  const saveComfyHost = async () => {
    const host = comfyHostInput.trim();
    if (!host) return;
    setComfyHostStatus("saving");
    setComfyHostError("");
    try {
      const c = await apiSetComfyHost(host);
      setComfyHost(c.comfy_host);
      setComfyHostInput(c.comfy_host_override ?? "");
      setComfyHostStatus("saved");
    } catch (err) {
      setComfyHostStatus("error");
      setComfyHostError((err as Error).message);
    }
  };
  const saveOllamaHost = async () => {
    const host = ollamaHostInput.trim();
    if (!host) return;
    setOllamaHostStatus("saving");
    setOllamaHostError("");
    try {
      const c = await apiSetOllamaHost(host);
      setOllamaHost(c.ollama_host);
      setOllamaHostInput(c.ollama_host_override ?? "");
      setOllamaHostStatus("saved");
    } catch (err) {
      setOllamaHostStatus("error");
      setOllamaHostError((err as Error).message);
    }
  };
  const saveOllamaKeepModelLoaded = async (keepLoaded: boolean) => {
    setOllamaKeepModelLoadedInput(keepLoaded);
    setOllamaKeepStatus("saving");
    setOllamaKeepError("");
    try {
      const c = await apiSetOllamaKeepModelLoaded(keepLoaded);
      setOllamaKeepModelLoadedInput(c.ollama_keep_model_loaded);
      setOllamaKeepStatus("saved");
    } catch (err) {
      setOllamaKeepStatus("error");
      setOllamaKeepError((err as Error).message);
    }
  };
  const exportSettings = () => {
    setSettingsFileError("");
    const contents = JSON.stringify(createSettingsFile(), null, 2);
    const url = URL.createObjectURL(
      new Blob([contents], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `gazecom-settings-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importSettings = async (file: File) => {
    setSettingsFileError("");
    try {
      applySettingsFile(JSON.parse(await file.text()) as unknown);
      window.location.reload();
    } catch (err) {
      const message = (err as Error).message;
      setSettingsFileError(message);
      window.alert(`Import failed: ${message}`);
    }
  };

  return (
    <aside className="gz-drawer" style={style}>
      <button
        className="gz-drawer-close"
        aria-label="Close"
        onClick={onClose}
      >
        ×
      </button>
      <h3>Settings</h3>
      <div className="gz-drawer-content">
        <section className="gz-settings-group">
          <strong>General</strong>
          <label className="gz-drawer-field">
            <span>ComfyUI host</span>
            <div className="gz-drawer-input">
              <span aria-hidden="true">http://</span>
              <input
                aria-label="ComfyUI host"
                type="text"
                value={comfyHostInput}
                placeholder={comfyHost || "127.0.0.1:8188"}
                disabled={!serviceConfigLoaded}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => {
                  setComfyHostInput(e.target.value);
                  setComfyHostStatus("idle");
                  setComfyHostError("");
                }}
                onBlur={() => void saveComfyHost()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </div>
            {comfyHostStatus !== "idle" && (
              <small>
                {comfyHostStatus === "saving"
                  ? "Saving…"
                  : comfyHostStatus === "saved"
                    ? "Saved ✓"
                    : `Save failed: ${comfyHostError || "unknown error"}`}
              </small>
            )}
          </label>
          <label className="gz-drawer-field">
            <span>Ollama host</span>
            <div className="gz-drawer-input">
              <span aria-hidden="true">http://</span>
              <input
                aria-label="Ollama host"
                type="text"
                value={ollamaHostInput}
                placeholder={ollamaHost || "127.0.0.1:11434"}
                disabled={!serviceConfigLoaded}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => {
                  setOllamaHostInput(e.target.value);
                  setOllamaHostStatus("idle");
                  setOllamaHostError("");
                }}
                onBlur={() => void saveOllamaHost()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </div>
            {ollamaHostStatus !== "idle" && (
              <small>
                {ollamaHostStatus === "saving"
                  ? "Saving…"
                  : ollamaHostStatus === "saved"
                    ? "Saved ✓"
                    : `Save failed: ${ollamaHostError || "unknown error"}`}
              </small>
            )}
          </label>
          <div className="gz-drawer-toggle-field">
            <Toggle
              label="Keep Ollama model loaded"
              checked={ollamaKeepModelLoaded}
              onChange={(v) => void saveOllamaKeepModelLoaded(v)}
            />
            <small>
              {ollamaKeepStatus === "saving"
                ? "Saving…"
                : ollamaKeepStatus === "saved"
                  ? ollamaKeepModelLoaded
                    ? "Saved ✓ Ollama keeps the LLM warm between enhancements."
                    : "Saved ✓ Ollama unloads the LLM after each enhancement."
                  : ollamaKeepStatus === "error"
                    ? `Save failed: ${ollamaKeepError || "unknown error"}`
                    : "On is best for a separate machine; off frees VRAM when Ollama shares the Flux GPU."}
            </small>
          </div>
          <Toggle
            label="Skip provider errors"
            checked={skipProviderErrors}
            onChange={(v) => set("skipProviderErrors", v)}
          />
          <Toggle
            label="Show welcome screen on startup"
            checked={showWelcome}
            onChange={(v) => set("showWelcome", v)}
          />
        </section>
        <section className="gz-settings-group">
          <strong>Interface</strong>
          <div className="gz-ui-scale-options" aria-label="Interface scale">
            {UI_SCALE_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant="secondary"
                className={uiScale === option.value ? "gz-btn--selected" : ""}
                aria-pressed={uiScale === option.value}
                onClick={() => set("uiScale", option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <Toggle
            label="Auto-collapse panels"
            checked={autoCollapsePanels}
            onChange={(v) => set("autoCollapsePanels", v)}
          />
        </section>
        <section className="gz-settings-transfer">
          <strong>Settings file</strong>
          <input
            ref={settingsFileInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void importSettings(file);
            }}
          />
          <div>
            <Button
              type="button"
              variant="secondary"
              onMouseDown={(e) => e.preventDefault()}
              onClick={exportSettings}
            >
              Export settings
            </Button>
            <Button
              type="button"
              variant="secondary"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => settingsFileInputRef.current?.click()}
            >
              Import settings
            </Button>
          </div>
          <small>
            App preferences only. Service addresses, workflow files, images and
            API keys remain local.
          </small>
          {settingsFileError && <small>{settingsFileError}</small>}
        </section>
        <div className="gz-settings-reset">
          <Button
            variant="secondary"
            onMouseDown={(e) => e.preventDefault()}
            onClick={async () => {
              if (
                !window.confirm(
                  "Reset all gazeCOM settings? This clears your saved preferences.",
                )
              )
                return;
              try {
                await resetConfig();
                clearAllGazeComKeys();
                window.location.reload();
              } catch (err) {
                window.alert(`Reset failed: ${(err as Error).message}`);
              }
            }}
          >
            Reset all settings
          </Button>
        </div>
      </div>
    </aside>
  );
}
