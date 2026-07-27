# Workflow authoring

gazeCOM accepts ComfyUI **API-format** workflow JSON. A workflow owns its model,
nodes, sampler, scheduler, CFG, denoise, LoRAs, and other generation details;
gazeCOM supplies the current image, prompt, seed, and optional step count
through placeholders.

## Add or override a workflow

1. Export the workflow from ComfyUI in API format.
2. Replace the relevant node values with the gazeCOM placeholders documented
   below.
3. Put the JSON directly inside the matching lowercase category folder.
4. Reload gazeCOM. Valid files appear in the workflow picker; invalid files
   remain under Issues with the reason.

Downloaded builds create a writable workflow tree on first launch:

- macOS: `~/Library/Application Support/gazeCOM/workflows/`
- Windows: `%APPDATA%\gazeCOM\workflows\`

Source checkouts use the repository's `workflows/` tree. In either case, the
required structure is:

```text
workflows/
├── img/
├── edit/
└── inpainting/
```

Files must live directly inside one of these folders. Unknown categories and
additional nesting are invalid.

Bundled and user roots share the same `category/filename.json` key. A user
workflow with the same category and filename overrides the bundled workflow
without modifying the package.

## Input routing

The category determines how gazeCOM prepares the PNG assigned to
`{input_image}`. The COM toggle independently determines whether the current
1024 x 1024 image or a crop from the live composite is used.

| Category | UI label | COM off | COM on |
|---|---|---|---|
| `img/` | **IMG** | Current image with the visible heatmap composited over it | Opaque 1024 x 1024 composite crop centered on COM |
| `edit/` | **Edit** | Plain current image without heatmap or alpha mask | Opaque 1024 x 1024 composite crop centered on COM |
| `inpainting/` | **In-/outpaint** | Current image with the heatmap removed from the alpha channel | 1024 x 1024 COM crop with the heatmap removed from the alpha channel |

With COM enabled, every category uses the same spatial crop window. The
category controls only how that crop is prepared for the selected model.

IMG and Edit inputs are flattened onto the visible frame background and sent
as opaque PNGs. Empty areas use the current theme color by default, or the
configured matte color when enabled. Only In-/outpaint uses the heatmap as an
alpha mask. Its graph must consume both the image and mask outputs of the
ComfyUI `LoadImage` node as required by the model.

## Placeholders

Placeholders may appear in any string value inside the workflow JSON.

| Placeholder | Contract |
|---|---|
| `{input_image}` | **Required.** Replaced with the image uploaded to ComfyUI for the current generation |
| `{prompt}` | Optional. Replaced with the selected generation prompt; its absence produces a warning because the prompt pool cannot affect the workflow |
| `{seed}` | Optional. Replaced with a random integer for each generation |
| `{steps:N}` | Optional. Declares a positive workflow-specific default `N` and lets the Steps field override it |
| `{output_prefix}` | Optional. Replaced with a unique filename prefix for `SaveImage` |

Do not use a bare `{steps}` token. If Steps should control the workflow, declare
the default in the same token, for example `{steps:6}`. A workflow that does not
use the Steps field may omit the placeholder entirely.

All occurrences of the same placeholder receive the same value during one
generation.

## Validation and output

A valid workflow must:

- be a JSON object in ComfyUI API format;
- contain API nodes with `class_type`;
- include `{input_image}`;
- live directly inside `img/`, `edit/`, or `inpainting/`;
- terminate in a recognized `SaveImage` or `PreviewImage` node.

gazeCOM returns the first image from the selected terminal output. Structural
problems prevent selection and appear under Issues in the workflow picker.
Missing `{prompt}` is a warning rather than an error.

The catalog is rescanned when the page loads. Adding, removing, or renaming a
file updates the menu after reload, and stale pins are reconciled without
rewriting the remaining workflow weights.

## Dependencies

Every model and node referenced by a workflow must exist in the connected
ComfyUI installation. This includes checkpoints or diffusion models, text
encoders, VAEs, LoRAs, custom nodes, and any credentials required by provider
nodes.

The bundled FLUX.2 Edit workflow expects:

- `FLUX.2-Klein-9B-INT8-ConvRot.safetensors`
- `qwen_3_8b_fp8mixed.safetensors`
- `flux2-vae.safetensors`

Custom or override workflows may use any compatible ComfyUI graph as long as
they satisfy the category, placeholder, and output contracts above.
