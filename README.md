# gazeCOM

gazeCOM translates **saliency patterns** — gaze movements, hand gestures,
computer vision, cursor input, or algorithmic walks — into spatial controls
for iterative image generation and composition across an infinite canvas.

Each source is rendered as a saliency heatmap and reduced to a **center of mass
(COM)**. That coordinate selects the region passed to the generation model,
can shape an inpainting mask, and determines where each result is placed on a
persistent composite. Sources remain interchangeable because they all produce
the same spatial signal.

Runs locally against your own [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
for image generation, with optional language and vision steps through
[Ollama](https://ollama.com/).

> Current release: v0.2.1. First published as v0.2.0; evolved from a 2025 prototype.

## What you need

- A running **ComfyUI** reachable over HTTP — run it however you like
  (Desktop app, portable, manual, remote). gazeCOM talks to it purely over
  the ComfyUI API, so it doesn't care where or how it runs; it only needs the
  address. If ComfyUI is on another machine, start it with `--listen`.
- Optional: a running **Ollama** for prompt enhancement, image description,
  and the VLM tracking mode (default `127.0.0.1:11434`).

No shared folders or paths to wire up — you point gazeCOM at those addresses
from the in-app **Settings** drawer.

## Get the app

### Download a build

Grab the latest **[Release](https://github.com/grebenshyo/gazecom/releases)**
and unzip. gazeCOM runs in a terminal window that shows its address and logs —
the same shape as ComfyUI and Ollama.

- **Windows** — double-click `gazeCOM.exe` inside the unzipped `gazeCOM`
  folder. A console window opens.
- **macOS** — download `gazeCOM-macos-arm64.zip` for Apple Silicon or
  `gazeCOM-macos-intel.zip` for an Intel Mac, then double-click
  `gazeCOM.command` inside the folder. It opens in Terminal. (First time,
  it's unsigned: right-click → **Open**.)

Until a release is tagged, builds are also attached to each run of the
**Release Build** workflow under the repo's **Actions** tab.

### …or build it yourself

One command (needs Python 3.11+, Node 20+, and [pnpm](https://pnpm.io)):

```powershell
# Windows (PowerShell)
scripts\build-app.ps1
```

```bash
# macOS / Linux
scripts/build-app.sh
```

It builds the frontend, freezes the app, and prints where it landed:
`dist\gazeCOM\` (Windows) or `dist/gazeCOM/` with a `gazeCOM.command` inside
(macOS).

## Run

Launch it (see above). A terminal window opens showing the address, and your
browser opens to gazeCOM. Then:

- Open the **Settings** drawer and set your **ComfyUI** host (and optional
  **Ollama** host). That's the only setup.
- **To quit**, close the terminal window or press **Ctrl-C** in it. That stops
  the local server; the browser tab is then just a stale page you can close.
- Relaunching while it's already running reopens the same window instead of
  starting a second server.
- **First launch is unsigned**: Windows SmartScreen → *More info → Run anyway*;
  macOS → right-click `gazeCOM.command` → *Open* (the launcher then clears the
  download quarantine so the app itself starts without a second prompt).

## Saliency sources

| Mode | Calibration | Camera | What it does |
|---|---|---|---|
| WebGazer | Yes (5-point) | Yes | Estimates gaze movements from a webcam |
| Handpose | No | Yes | Translates five tracked fingertips into saliency points |
| Cursor | No | No | Uses pointer movement as the spatial signal |
| MSI | No | Yes | Computes a computer-vision saliency map from the camera |
| Roam | No | No | Produces a momentum-based algorithmic walk |
| Adaptive Roam | No | No | Alternates between exploratory, focused, and scanning patterns |
| VLM | No | No | Uses a vision model to identify the most salient coordinate |

Every source feeds the same saliency heatmap → COM → generation → composition
pipeline, so modes can be switched without changing the selected workflow.

Camera processing stays in the browser; gazeCOM does not upload webcam video.
Camera-based modes require permission, and some tracker scripts/models are
loaded from their upstream CDNs when first selected. See
**[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)** for sources and licenses.

## Generation

- **Standard** (img2img): heatmap + base image → transformation.
- **Edit**: image-conditioned editing of the current patch.
- **In-/outpainting**: the heatmap masks regions for selective regeneration
  or edge expansion.
- **COM** (independent toggle): when on, the saliency center of mass drives
  crop selection and where each patch lands on the composite.
- **Composite**: results accumulate as spatially-placed patches on an
  unbounded or size-limited canvas.
- **Iterative**: repeats generation on a configurable delay, with optional
  feedback between passes.

Prompts and ComfyUI workflows each live in independent **weighted pools**, so a
run can use one fixed choice or rotate probabilistically. Prompt slots can be
sent directly, rewritten by a local LLM (once or self-evolving), or produced
from the current frame by a vision model. A pinned workflow can be muted without
changing its weight, then unmuted to restore the same pool configuration.
Workflow values are relative weights and are normalized automatically; unlike
prompt-slot percentages, they do not need to total 100.

### Prompting and models

The **Prompting** cog exposes built-in prompt lists and templates. A chosen
template is written into the currently focused slot; placeholders such as
`{cartoon character}`, `{tree part}`, `{support}`, `{color}`, and `{artist}`
are randomized when that slot is sent. The same panel contains the editable
LLM wrapper, where `{prompt}` marks the insertion point.

Ollama model selection is explicit: fresh installations select nothing, and a
removed model returns the relevant menu to blank instead of silently choosing
another. Choose the text model under the Prompting cog and the vision model
under **Advanced**. The sparkle button runs the selected tool once; automatic
prompting cycles between off (`○`), send without replacing the slot (`↗`), and
self-evolving replacement (`↻`). The per-slot vision button describes the
current frame before generation and displays the returned prompt separately.

### Settings and portability

The `↺` control in each panel heading restores only that section to its
fresh-install state. The global **Settings** drawer is organized into three
sections:

- **General** configures the ComfyUI and Ollama hosts, Ollama model retention,
  provider-error behavior, and whether the welcome screen appears at startup.
- **Interface** controls UI scale, frame zoom, and optional automatic collapse
  of other panel sections when one is opened.
- **Settings file** exports browser-persisted preferences as a versioned JSON
  file or imports them on another installation. This includes prompt slots,
  workflow pins, model choices, tracking profiles, and UI preferences.

Service addresses, workflow files, images, API keys, canvases, and WebGazer
calibration data remain machine-local and are not included in settings files.

### Custom workflows

gazeCOM groups ComfyUI API-format workflows into `img`, `edit`, and
`inpainting`. Downloaded builds create a writable workflow folder on first
launch:

- macOS: `~/Library/Application Support/gazeCOM/workflows/`
- Windows: `%APPDATA%\gazeCOM\workflows\`

Place a workflow directly inside the matching category folder and reload the
page. User workflows are merged with the bundled catalog; a user file with the
same category and filename overrides the bundled version. The complete
workflow contract and validation rules are documented in
**[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#workflows)**.

## Development

Building from source, the architecture, the dev-vs-packaged model, the dev
servers, and the test suites are documented in
**[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**.

## License

MIT. Bundled artworks and runtime-loaded components retain their respective
terms; see **[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)**.
