/** Help and runtime settings drawers. */

import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { clearAllGenGazeKeys } from "../lib/persistence";
import {
  fetchConfig,
  resetConfig,
  setComfyHost as apiSetComfyHost,
  setOllamaHost as apiSetOllamaHost,
  setOllamaKeepModelLoaded as apiSetOllamaKeepModelLoaded,
} from "../generation/api";
import { Button, Toggle } from "./components";
import "./Drawers.css";

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
              ["guide-resources", "Resources"],
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
              form a weighted pool and must total 100%.
            </li>
            <li>
              Choose an image and tracking mode under Settings, then start
              tracking to build a heatmap.
            </li>
            <li>
              Enter a prompt and generate. Enable Iterative to repeat the cycle
              automatically.
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
              <strong>VLM</strong> asks the selected vision model for the most
              salient coordinate after each generation. Its first feedback
              point starts at the exact frame center.
            </li>
          </ul>
          <p>
            Heatmap style is shared across modes. Size, jitter, speed, trail,
            and event-history settings are remembered per mode.
          </p>
        </section>

        <section id="guide-prompting" className="gz-guide-section">
          <h4>Prompting</h4>
          <p>
            Prompt slots form a second weighted pool. Add slots for alternatives
            and set their weights to total 100%; a single slot remains at 100%.
            The Prompting cog opens templates, prompt lists, model selection,
            and the editable LLM instruction wrapper.
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
            The vision state turns a slot into an image-description instruction.
            The VLM reads the current frame first, displays its derived prompt
            below the instruction, and sends that result directly to generation
            without a second enhancement pass.
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
            input. Removing or renaming a workflow removes its stale pin and
            rebalances the remaining pool automatically.
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
            Enable <strong>Limit canvas size</strong> under Advanced to set a
            fixed width and height. Patches crossing that boundary are clipped
            at the edge rather than shifted inward, so their placement remains
            tied to the COM that produced them.
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
            Advanced contains heatmap and composite matte colors, eyedropper
            sampling, automatic download/clear intervals, canvas limits, the VLM
            coordinate prompt, and WebGazer calibration-cache controls.
          </p>
          <p>
            View controls interface scale, frame zoom and visibility, fit target,
            pull-box display and frame width, and Reset pos, which returns the
            box to the first patch position. Hiding the heatmap frame does not
            stop tracking.
          </p>
        </section>

        <section id="guide-resources" className="gz-guide-section">
          <h4>Model resources</h4>
          <p>
            Keep Ollama loaded to avoid model reloads when it runs on a separate
            machine. Turn it off when Ollama and image generation share memory so
            the model is released after each request. Skip provider errors is a
            global option for allowing iterative cloud workflows to continue
            after a provider failure.
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
              clearAllGenGazeKeys();
              window.location.reload();
            } catch (err) {
              window.alert(`Reset failed: ${(err as Error).message}`);
            }
          }}
        >
          Reset all settings
        </Button>
      </div>
    </aside>
  );
}
