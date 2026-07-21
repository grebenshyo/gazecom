# gazeCOM Roadmap / Deferred Work

Running list of known issues and future work, deferred so they don't block
current tasks.

## VLM Mode

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
