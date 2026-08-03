# gazeCOM Guide

gazeCOM converts saliency patterns into spatial instructions for image
generation. Every source produces the same heatmap; its center of mass (COM)
determines what the model sees and, when COM is enabled, where the result is
placed.

## Start here

1. Open the Settings drawer and enter your ComfyUI host. Add an Ollama host
   only for LLM, vision prompting, or VLM tracking. Host fields do not need the
   `http://` prefix.
2. Under Workflow, pin at least one workflow. Multiple selections form a
   relative weighted pool; new pins start at weight 1 and values do not need to
   total 100. The first pin fills Steps from its declared `{steps:N}` default
   when available.
3. Choose an image and mode under Tracking, then start tracking to build a
   heatmap. The Tracking cog reveals the selected mode's controls.
4. Enter a prompt and generate, or let Guide Compose supply the prompt. Enable
   Iterative to repeat the cycle automatically.

## Saliency sources

- **WebGazer** follows gaze movements after five-point calibration. Event
  history limits accumulated samples while preserving the additive heatmap.
- **Handpose** follows the index fingertip through the camera; **Cursor**
  follows the pointer.
- **MSI** derives computer-vision saliency from the camera feed.
- **Roam** provides smooth autonomous movement; **Adaptive Roam** alternates
  exploratory, focused, and scanning behavior.
- **VLM Point** asks the selected vision model for a salient coordinate after
  each generation. Frame scope drives COM within the latest patch; Canvas scope
  evaluates the complete composite. Its first feedback point starts at the
  exact frame center.
- **VLM Guide** uses the selected vision model to define the next COM frame
  across the complete canvas. **Rotate** pairs that framing with normal
  weighted prompt rotation. Its optional **Pool context** toggle adds an
  editable `{prompt_pool}` block to the Guide prompt. The block expands to the
  active prompts and normalized probabilities without letting Guide choose
  one. **Select** asks the VLM to choose one unmuted prompt slot together with
  the coordinate. Its editable Select prompt must contain `{prompt_pool}`,
  which expands visibly into the numbered candidates sent to the model.
- Guide **Compose** chooses both the location and a new image-editing
  instruction. **Hybrid** chooses per step whether to select one pool prompt
  without rewriting it or write its own complete prompt, which may adapt or
  combine ideas from the pool. Compose and Hybrid-written prompts appear under
  Next action. For a direct Hybrid pool decision, Next action mirrors the
  selected prompt. If that slot uses enhancement or vision, it waits and
  displays only the final applied text.
- Guide **Visual memory** compares one previous canvas with the current canvas.
  Its toggle adds a visible explanation to every editable Guide prompt, while
  the retained image history remains fixed at one previous canvas.

Guide follows the selected canvas-limit mode like every other driver. Prepare
exposes the complete fixed workspace from its first decision; Growth and Around
center let edge decisions expand the current composite. Guide can start from an
image or a blank canvas. Applied coordinates and prompts remain in bounded
Ollama chat history while only the latest canvas image is submitted.
Pausing tracking preserves that context; changing the canvas, model, behavior,
choice, prompt, history limit, or canvas limits starts a new conversation. Set
History to 0 to disable continuity.

Heatmap style is shared across modes. Size, jitter, speed, trail, and
event-history settings are remembered per mode. Mode-specific controls live
under the Tracking cog; VLM driver prompts and Next action remain directly
visible when VLM is selected.

## Prompting

Prompt slots form a second weighted pool. Add slots for alternatives and give
them relative weights; gazeCOM normalizes the active values automatically, so
they do not need to total 100. Focus a slot before choosing from the Prompting
cog: List selects a built-in collection, and Template writes one entry from
that list into the focused slot. Templates are starting text, not additional
pinned slots.

Template placeholders are randomized when a prompt is sent. The available
tokens are `{cartoon character}`, `{tree part}`, `{support}`, `{color}`, and
`{artist}`; repeated tokens are resolved independently. The cog also contains
the Ollama model and editable LLM wrapper. `{prompt}` marks where the slot text
enters that wrapper; without it, the text is appended. When the selected model
reports thinking support, an effort menu appears beside it with only that
model's accepted values.

The circle inside a slot's weight field temporarily mutes that prompt without
changing its weight. A muted slot is veiled and its other controls are suspended
until the circle is used to unmute it. It then returns to the same pool
configuration. Muted and zero-weight slots are excluded from selection;
generation requires at least one positive, unmuted slot. Prompt text may be
empty: an active blank slot sends an empty string to the workflow. New prompt
slots start at weight 1.

Guide Select and Hybrid deliberately ignore numeric prompt weights. Their
weight fields disappear and the remaining circle controls whether each slot is
available to the VLM. Stored weights are not changed and return when Guide
switches back to Rotate.

- **✨** runs the selected prompt tool once.
- **○ Off** sends the written prompt unchanged.
- **↗ Send** enhances it for generation without replacing the slot text.
- **↻ Evolve** enhances it and writes the result back, allowing iterative
  prompts to keep developing.

The ◉ vision state turns that slot into an image-description instruction. The
Vision model selected under Advanced reads the current frame first, displays
its derived prompt below the instruction, and sends that result directly to
generation without a second enhancement pass.

Prompt-slot vision is separate from VLM tracking. VLM Guide defines the
generation frame, then the rotated or VLM-selected prompt slot follows its
normal direct, enhancement, evolution, or vision path. Compose and
Hybrid-written actions instead supply the generation prompt directly.

The ↺ control in each panel heading restores only that section to its
fresh-install state.

## Workflow pool

The picker groups valid API workflows by category and color: **IMG**, **Edit**,
and **In-/outpaint**. Entries are alphabetical; selected workflows and their
pool weights remain visible in the panel.

- **IMG** uses the whole image plus heatmap when COM is off, or a 1024 x 1024
  COM crop when it is on.
- **Edit** uses the plain current image or COM crop.
- **In-/outpaint** also receives the heatmap-derived alpha mask.

When generation selects a different workflow, Steps adopts that workflow's
declared default; you can override it in the compact input. The circle inside
each weight field temporarily mutes that workflow while preserving its weight.
Active values are normalized automatically, so only their relative proportions
matter. Removing or renaming a workflow removes its stale pin without rewriting
the remaining weights.

> **Custom workflows:** Downloaded builds keep bundled templates inside the
> package. On first launch, gazeCOM creates a separate writable workflow tree
> for additions and overrides:
>
> - macOS: `~/Library/Application Support/gazeCOM/workflows/`
> - Windows: `%APPDATA%\gazeCOM\workflows\`
>
> Put custom API-format JSON in the appropriate user folder. Source checkouts
> use the repository's `workflows/` tree instead. Valid files appear
> automatically after reload; invalid files remain under Issues with the
> reason. See [Workflow authoring](https://github.com/grebenshyo/gazecom/blob/main/docs/WORKFLOWS.md)
> for the complete category, placeholder, validation, and override contract.

## Generation

- **Feedback** makes the latest result the next tracked image; off keeps
  tracking the current source.
- **COM** centers the generation crop on the saliency center and preserves that
  location for placement.
- **Composite** stitches patches into the spatial canvas. With it off, each
  result replaces the working image.
- **Iterative** repeats generation after the selected delay and clears the
  heatmap between rounds. Generate becomes Stop while the loop is active.

The Settings section groups heatmap appearance, dot rendering, input-image
selection, matte controls, Feedback, COM, Composite, and Iterative controls.

Enable **Limit canvas size** under Advanced, set its dimensions, and choose a
limit mode:

- **Prepare** allocates the full workspace once and centers existing content.
- **Limit growth** lets the canvas grow naturally in any direction until its
  width and height reach the configured maximum.
- **Around center** fixes the configured boundary around the first patch while
  letting the visible composite grow into it.

Every mode preserves the requested COM placement. Content extending beyond the
active boundary is clipped rather than shifting the generated patch inward.

## Canvas actions

- **Pull** extracts the displayed 1024 x 1024 box from the composite as the new
  working image.
- **Clear canvas** returns to the selected source; **Clear heatmap** removes
  saliency history and the WebGazer tracking point.
- **Download** exports the composite, including the selected composite matte
  when enabled.

## Advanced and view

Advanced contains automatic download/clear intervals, canvas limits, the VLM
model, and WebGazer calibration-cache controls. A model-specific effort menu
appears beside a vision model that supports thinking. The Tracking cog contains
VLM behavior, scope, Guide prompt choice, and history. Editable driver
instructions and Compose/Hybrid's Next action remain visible below Mode when
VLM is selected.

View controls frame zoom and visibility, fit target, pull-box display and frame
width, and Reset pos, which returns the box to the first patch position. Hiding
the heatmap frame does not stop tracking.

## Global settings

The Settings drawer is organized as General, Interface, and Settings file.
General contains the ComfyUI and Ollama hosts, Ollama model retention,
provider-error behavior, and the welcome-screen option. Interface controls UI
scale and optional auto-collapse behavior for panel sections.

Keep Ollama loaded to avoid model reloads when it runs on a separate machine.
Turn it off when Ollama and image generation share memory so the model is
released after each request. Skip provider errors is a global option for
allowing iterative cloud workflows to continue after a provider failure.

Settings file exports browser-persisted preferences as JSON and imports them on
this or another installation. Service addresses, workflow files, images, API
keys, canvases, and WebGazer calibration data stay machine-local.
