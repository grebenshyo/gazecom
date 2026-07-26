/** Help and runtime settings drawers. */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
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
      <h3>gazeCOM Guide</h3>
      <div className="gz-drawer-content gz-guide">
        <p className="gz-guide-intro">
          gazeCOM converts saliency patterns into spatial instructions for image
          generation. Every source produces the same heatmap; its center of mass
          (COM) determines what the model sees and, when COM is enabled, where
          the result is placed.
        </p>

        <nav className="gz-guide-nav" aria-label="Guide sections">
          <span>Jump to</span>
          <div>
            {[
              ["guide-start", "Start"],
              ["guide-sources", "Sources"],
              ["guide-prompting", "Prompting"],
              ["guide-workflows", "Workflows"],
              ["guide-generation", "Generation"],
              ["guide-canvas", "Canvas"],
              ["guide-advanced", "Advanced"],
              ["guide-resources", "Global settings"],
            ].map(([id, label]) => (
              <button key={id} type="button" onClick={() => jumpTo(id)}>
                {label}
              </button>
            ))}
          </div>
        </nav>

        <section id="guide-start" className="gz-guide-section">
          <h4>Start here</h4>
          <ol>
            <li>
              Open the settings drawer and enter your ComfyUI host. Add an
              Ollama host only for LLM, vision prompting, or VLM tracking. Host
              fields do not need the <code>http://</code> prefix.
            </li>
            <li>
              Under Workflow, pin at least one workflow. Multiple selections
              form a relative weighted pool; new pins start at weight 1 and
              values do not need to total 100. The first pin fills Steps from
              its declared <code>{"{steps:N}"}</code> default when available.
            </li>
            <li>
              Choose an image and tracking mode under Tracking, then start
              tracking to build a heatmap.
            </li>
            <li>
              Enter a prompt and generate, or let Guide Compose supply the prompt.
              Enable Iterative to repeat the cycle automatically.
            </li>
          </ol>
        </section>

        <section id="guide-sources" className="gz-guide-section">
          <h4>Saliency sources</h4>
          <ul>
            <li>
              <strong>WebGazer</strong> follows gaze movements after five-point
              calibration. Event history limits accumulated samples while
              preserving the additive heatmap.
            </li>
            <li>
              <strong>Handpose</strong> follows the index fingertip through the
              camera; <strong>Cursor</strong> follows the pointer.
            </li>
            <li>
              <strong>MSI</strong> derives computer-vision saliency from the
              camera feed.
            </li>
            <li>
              <strong>Roam</strong> provides smooth autonomous movement;
              <strong> Adaptive Roam</strong> alternates exploratory, focused,
              and scanning behavior.
            </li>
            <li>
              <strong>VLM Point</strong> asks the selected vision model for a
              salient coordinate after each generation. Frame scope drives COM
              within the latest patch; Canvas scope evaluates the complete
              composite and centers Pull on the selected location. Its first
              feedback point starts at the exact frame center.
            </li>
            <li>
              <strong>VLM Guide</strong> reads the complete canvas and chooses
              the next Pull location. <strong>Rotate</strong> pairs it with the
              normal weighted prompt rotation. <strong>Select</strong> asks the
              VLM to choose one unmuted prompt slot together with the coordinate.
              Its editable Select prompt must contain{" "}
              <code>{"{prompt_pool}"}</code>, which expands visibly into the
              numbered candidates sent to the model.
            </li>
            <li>
              Guide <strong>Compose</strong> chooses both the location and a new
              image-editing instruction. <strong>Hybrid</strong> chooses per step
              whether to select one pool prompt without rewriting it or write its
              own complete prompt, which may adapt or combine ideas from the pool.
              Compose and Hybrid-written prompts appear under Next action.
            </li>
          </ul>
          <p>
            With canvas limits on, Guide prepares the full workspace before its
            first decision; without limits, edge decisions expand the current
            composite. It can start from an image or a blank canvas. Applied
            coordinates and prompts remain in bounded Ollama chat history while
            only the latest canvas image is submitted. Pausing tracking preserves
            that context; changing the canvas, model, behavior, choice, prompt,
            history limit, or canvas limits starts a new conversation. Set
            history to 0 to disable continuity.
          </p>
          <p>
            Heatmap style is shared across modes. Size, jitter, speed, trail,
            and event-history settings are remembered per mode.
          </p>
        </section>

        <section id="guide-prompting" className="gz-guide-section">
          <h4>Prompting</h4>
          <p>
            Prompt slots form a second weighted pool. Add slots for alternatives
            and give them relative weights; the app normalizes the active values
            automatically, so they do not need to total 100. Focus a slot before
            choosing from the Prompting cog: List selects a built-in collection,
            and Template writes one entry from that list into the focused slot.
            Templates are starting text, not additional pinned slots.
          </p>
          <p>
            Template placeholders are randomized when a prompt is sent. The
            available tokens are <code>{"{cartoon character}"}</code>,
            <code>{"{tree part}"}</code>, <code>{"{support}"}</code>,
            <code>{"{color}"}</code>, and <code>{"{artist}"}</code>; repeated
            tokens are resolved independently. The cog also contains the Ollama
            model and editable LLM wrapper. <code>{"{prompt}"}</code> marks
            where the slot text enters that wrapper; without it, the text is
            appended. When the selected model reports thinking support, an
            effort menu appears beside it with only that model's accepted
            values.
          </p>
          <p>
            The circle inside a slot's weight field temporarily mutes that
            prompt without changing its weight. Muted slots remain editable
            and return to the same pool configuration when unmuted. Muted and
            zero-weight slots are excluded from selection; generation requires
            at least one positive, unmuted slot. Prompt text may be empty: an
            active blank slot sends an empty string to the workflow. New prompt
            slots start at weight 1.
          </p>
          <p>
            Guide Select and Hybrid deliberately ignore numeric prompt weights.
            Their weight fields disappear and the remaining circle controls
            whether each slot is available to the VLM. Stored weights are not
            changed and return when Guide switches back to Rotate.
          </p>
          <ul className="gz-guide-symbols">
            <li>
              <strong>✨</strong> runs the selected prompt tool once.
            </li>
            <li>
              <strong>○ Off</strong> sends the written prompt unchanged.
            </li>
            <li>
              <strong>↗ Send</strong> enhances it for generation without
              replacing the slot text.
            </li>
            <li>
              <strong>↻ Evolve</strong> enhances it and writes the result back,
              allowing iterative prompts to keep developing.
            </li>
          </ul>
          <p>
            The ◉ vision state turns that slot into an image-description
            instruction. The Vision model selected under Advanced reads the
            current frame first, displays its derived prompt below the
            instruction, and sends that result directly to generation without a
            second enhancement pass.
          </p>
          <p>
            Prompt-slot vision is separate from VLM tracking. VLM Guide moves the
            generation frame, then the rotated or VLM-selected prompt slot
            follows its normal direct, enhancement, evolution, or vision path.
            Compose and Hybrid-written actions instead supply the generation
            prompt directly.
          </p>
          <p>
            The ↺ control in each panel heading restores only that section to
            its fresh-install state.
          </p>
        </section>

        <section id="guide-workflows" className="gz-guide-section">
          <h4>Workflow pool</h4>
          <p>
            The picker groups valid API workflows by category and color:
            <strong> IMG</strong>, <strong>Edit</strong>, and
            <strong> In-/outpaint</strong>. Entries are alphabetical; selected
            workflows and their pool weights remain visible in the panel.
          </p>
          <ul>
            <li>
              <strong>IMG</strong> uses the whole image plus heatmap when COM is
              off, or a 1024 × 1024 COM crop when it is on.
            </li>
            <li>
              <strong>Edit</strong> uses the plain current image or COM crop.
            </li>
            <li>
              <strong>In-/outpaint</strong> also receives the heatmap-derived
              alpha mask.
            </li>
          </ul>
          <p>
            When generation selects a different workflow, Steps adopts that
            workflow's declared default; you can override it in the compact
            input. The circle inside each weight field temporarily mutes that
            workflow while preserving its weight. Active values are normalized
            automatically, so only their relative proportions matter. Removing
            or renaming a workflow removes its stale pin without rewriting the
            remaining weights.
          </p>
          <aside className="gz-guide-note">
            <strong>Custom workflows.</strong> Downloaded builds keep the
            bundled templates inside the package. On first launch, gazeCOM also
            creates a separate writable workflow tree for your additions and
            overrides:
            <span className="gz-guide-path">
              macOS: <code>~/Library/Application Support/gazeCOM/workflows/</code>
            </span>
            <span className="gz-guide-path">
              Windows: <code>%APPDATA%\gazeCOM\workflows\</code>
            </span>
            In a downloaded build, put custom API-format JSON in one of those
            user folders. If you run gazeCOM from source instead, put it in the
            repository's <code>workflows/</code> tree. In either location, use
            the matching <code>img</code>, <code>edit</code>, or
            <code>inpainting</code> category and reload. Valid files appear
            automatically; invalid files remain under Issues with the reason. A
            user file with the same category and name overrides the bundled
            version.
            Every workflow requires <code>{"{input_image}"}</code>, should
            declare its default as <code>{"{steps:N}"}</code>, and must end in
            <code> SaveImage</code> or <code>PreviewImage</code>. Prompt, seed,
            sampler, model, and other graph details remain owned by the workflow.
          </aside>
        </section>

        <section id="guide-generation" className="gz-guide-section">
          <h4>Generation</h4>
          <ul>
            <li>
              <strong>Feedback</strong> makes the latest result the next tracked
              image; off keeps tracking the current source.
            </li>
            <li>
              <strong>COM</strong> centers the generation crop on the saliency
              center and preserves that location for placement.
            </li>
            <li>
              <strong>Composite</strong> stitches patches into the spatial
              canvas. With it off, each result replaces the working image.
            </li>
            <li>
              <strong>Iterative</strong> repeats generation after the selected
              delay and clears the heatmap between rounds. Generate becomes Stop
              while the loop is active.
            </li>
          </ul>
          <p>
            The Settings section groups heatmap appearance, dot rendering,
            input-image selection, matte controls, Feedback, COM, Composite,
            and Iterative controls.
          </p>
          <p>
            Enable <strong>Limit canvas size</strong> under Advanced to set a
            maximum width and height. The canvas grows naturally in whichever
            direction COM or Pull drives it until that size is reached. Further
            overflow is clipped rather than shifted inward, so placement remains
            tied to the COM that produced it.
          </p>
        </section>

        <section id="guide-canvas" className="gz-guide-section">
          <h4>Canvas actions</h4>
          <ul>
            <li>
              <strong>Pull</strong> extracts the displayed 1024 × 1024 box from
              the composite as the new working image.
            </li>
            <li>
              <strong>Clear canvas</strong> returns to the selected source;
              <strong> Clear heatmap</strong> removes saliency history and the
              WebGazer tracking point.
            </li>
            <li>
              <strong>Download</strong> exports the composite, including the
              selected composite matte when enabled.
            </li>
          </ul>
        </section>

        <section id="guide-advanced" className="gz-guide-section">
          <h4>Advanced and view</h4>
          <p>
            Advanced contains automatic download/clear intervals, canvas
            limits, the VLM model, and WebGazer calibration-cache controls. A
            model-specific effort menu appears beside a vision model that
            supports thinking. VLM behavior, scope, Guide prompt choice, history,
            editable instructions, and Compose/Hybrid's next action are shown
            below Mode when VLM is selected.
          </p>
          <p>
            View controls frame zoom and visibility, fit target, pull-box
            display and frame width, and Reset pos, which returns the box to the
            first patch position. Hiding the heatmap frame does not stop
            tracking.
          </p>
        </section>

        <section id="guide-resources" className="gz-guide-section">
          <h4>Global settings</h4>
          <p>
            The Settings drawer is organized as General, Interface, and Settings
            file. General contains the ComfyUI and Ollama hosts, Ollama model
            retention, provider-error behavior, and the welcome-screen option.
            Interface controls UI scale and optional auto-collapse behavior for
            panel sections.
          </p>
          <p>
            Keep Ollama loaded to avoid model reloads when it runs on a separate
            machine. Turn it off when Ollama and image generation share memory so
            the model is released after each request. Skip provider errors is a
            global option for allowing iterative cloud workflows to continue
            after a provider failure.
          </p>
          <p>
            Settings file exports browser-persisted preferences as JSON and
            imports them on this or another installation. Service addresses,
            workflow files, images, API keys, canvases, and WebGazer calibration
            data stay machine-local.
          </p>
        </section>
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
