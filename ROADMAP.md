# gazeCOM Roadmap / Deferred Work

Running list of known issues and future work, deferred so they don't block
current tasks.

## VLM Mode

- **Revisit task-specific vision reasoning controls.** Prompt-slot vision and
  VLM tracking currently share the Vision model's thinking-effort setting.
  If VLM Point or another use case makes the distinction useful, split it into
  one shared Prompting-cog setting for prompt-slot vision and one VLM Settings
  control for tracking. Do not add per-prompt-slot reasoning controls. Guide and
  Agent are the current priority, so the extra distinction is deferred.

- **Single-point inpainting masks — verify against a live model.** The VLM
  point renders through the normal h337 heatmap again (the historical
  "vanishing dot" was h337 silently dropping *fractional* coordinates — its
  point store is an array indexed by x, and a fractional index doesn't grow
  `length`, so renderAll cleared and drew nothing; fixed by rounding in
  `HeatmapInstance.withRadius`). This restored the unified path: point size
  and style come from the panel, and standard / in-outpainting inputs pick
  the point up from the heatmap canvas via `captureHeatmapOnBase` /
  `buildInpaintingMask`. Remaining: exercise a single-point inpaint mask
  against a real workflow — the mask is one styled dot (radius = Point-size
  slider), which is untested territory for mask coverage/feathering.

## Composite Bounds / Roam

- **Boundary policy for synthetic attention.** Bounded composite mode now
  constrains Roam/Adaptive Roam COM samples by clamping outside attempts to the
  nearest legal edge and letting the trail regenerate from there. This is
  acceptable for now: the velocity reversal is cheap but probably not
  conceptually essential because Roam randomizes direction quickly, while
  Adaptive Roam mostly overrides velocity through scan/focus behavior. If boundary
  stickiness becomes visible, first consider tuning damping/recovery or
  dropping outside samples. Avoid remapping/reflection unless all simpler
  policies fail.

## WebGazer

- **HTTPS / secure-context requirement.** WebGazer's camera access
  (`getUserMedia`) only works in a secure context. `localhost` is exempt in
  Chromium, but Safari and any non-localhost origin (LAN IP, packaged app
  served over plain HTTP) will refuse with an "HTTPS required" error, so
  WebGazer is effectively unusable outside `localhost`-in-Chromium today.
  Needs a TLS story (self-signed cert for the dev/LAN server, or serve the
  frozen app over HTTPS) before WebGazer is usable in normal deployment.

## Packaging

- Cold-start first-launch path (fresh mDNS/ws) only validated by reasoning +
  the retry/error-wrap; confirm on a genuinely fresh machine.
- Code signing / notarization to avoid the Gatekeeper "Open" step.

## Compatibility Cleanup

- Replace the active `gengaze.*` browser-storage namespace with `gazecom.*`,
  bump settings exports to schema 2, and intentionally stop importing schema-1
  settings.
- Remove superseded standalone tracking storage, the single `matteEnabled`
  fallback, the old VLM `agent` migration/API alias, the historical Ollama
  `"thinking"` migration, and the obsolete backend-config-route error.
- Rename current `vlmAgent*` internals to Guide/Compose terminology, retain the
  browser debugging interface as `window.gazecom`, and remove the unused legacy
  `WorkflowType` re-export.
- Remove the one-time `GenGaze` user-data copy, the `gengaze-backend` CLI alias,
  obsolete Comfy LLM comments, the old upload prefix, and stale workflow test
  nomenclature.
- Remove `/api/generate`'s unused `selected_image` branch unless an external API
  consumer is identified.
- Rename the Python import package from `gengaze` to `gazecom` in a separate
  commit, followed by full backend, launcher, packaging, CI, and release-build
  verification.
- Preserve operational fallbacks for Ollama APIs and thinking capabilities,
  cameras/browsers, host resolution, Comfy output detection and completion,
  inpainting masks, and provider-error handling.
