"""POST /api/generate — main generation endpoint.

The endpoint talks to ComfyUI purely over its HTTP + websocket API:
upload the input image (``POST /upload/image``), submit the workflow,
stream the result back via ``/view``. gazeCOM therefore needs no
filesystem access to ComfyUI's folders and can drive a ComfyUI running
on any reachable host — only ``COMFY_HOST`` is required.

The frontend submits multipart form fields
``image | selected_image``, ``workflow``, ``prompt``, ``steps`` → returns an
``image/png`` stream.
"""

from __future__ import annotations

import io
import json
import logging
import random
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse

from gengaze.comfy_client import ComfyClient, ComfyError, ComfyExecutionError
from gengaze.config import Settings, get_settings
from gengaze.user_config import resolve_comfy_host
from gengaze.workflow import substitute_placeholders
from gengaze.workflow_catalog import resolve_workflow_path

log = logging.getLogger(__name__)

router = APIRouter()

DEFAULT_EMPTY_PROMPT = "Muppet with a Pearl Earring, painting by Vermeer"


def _resolve_input_image(
    image: UploadFile | None,
    selected_image: str,
    settings: Settings,
) -> tuple[bytes, str]:
    """Return ``(image_bytes, source_filename)`` for the generation input.

    Either a server-side reference image (``selected_image``, read from
    gazeCOM's own ``images_dir``) or a posted upload (the frontend's
    heatmap capture). The bytes are uploaded to ComfyUI via its API by
    the caller — nothing touches ComfyUI's filesystem here.
    """
    if selected_image:
        src = settings.images_dir / selected_image
        if not src.exists():
            raise HTTPException(400, f"Selected image not found: {selected_image}")
        return src.read_bytes(), selected_image

    if image is not None:
        # FastAPI's UploadFile is synchronous when read via .file
        return image.file.read(), image.filename or "input.png"

    raise HTTPException(400, "No image provided.")


# Class types whose execution errors are swallowed when the
# `skip_provider_errors` flag is set. Cloud-backed nodes commonly refuse on
# policy/safety/quota grounds — those failures are expected and the user
# would rather the iterative loop just continue than alert + halt.
_SWALLOWABLE_NODE_CLASSES = frozenset({"GeminiStudio", "OpenAIStudio"})


@router.post("/generate", summary="Generate AI-enhanced image (or LLM text)")
async def generate(
    image: UploadFile | None = File(None),
    prompt: str = Form(""),
    workflow: str = Form(...),
    selected_image: str = Form(""),
    steps: int = Form(20),
    skip_provider_errors: bool = Form(False),
    settings: Settings = Depends(get_settings),
):
    client = ComfyClient(resolve_comfy_host(settings))

    # 1. Resolve the input image bytes and upload them to ComfyUI over its
    #    API. The returned name (ComfyUI may rename on collision) is what
    #    the LoadImage node references. A stable per-purpose name with
    #    overwrite keeps ComfyUI's input folder from accumulating a file
    #    per generation. The name derives from the client's imageName stem
    #    (gengaze_input / gengaze_edit_input / gengaze_llm / ...) rather
    #    than one shared name: generations are single-flight, but an LLM
    #    enhance can run concurrently with a generation — with a single
    #    shared name its placeholder upload could overwrite the
    #    generation's input in the window before LoadImage executes.
    img_bytes, source_name = _resolve_input_image(image, selected_image, settings)
    src = Path(source_name)
    upload_name = f"gengaze_{src.stem or 'input'}{src.suffix or '.png'}"
    try:
        input_filename = await client.upload_image(img_bytes, upload_name)
    except ComfyError as e:
        log.error("ComfyUI image upload failed: %s", e)
        raise HTTPException(502, str(e)) from e

    # 2. Resolve and load workflow JSON.
    wf_path = resolve_workflow_path(
        workflow,
        settings.workflows_dir,
        settings.user_workflows_dir,
    )
    if wf_path is None:
        raise HTTPException(400, f"Workflow not found: {workflow}")
    with wf_path.open(encoding="utf-8") as fh:
        wf_data = json.load(fh)

    # 3. Substitute placeholders.
    output_prefix = f"generated_{uuid.uuid4().hex}"
    wf_data = substitute_placeholders(
        wf_data,
        {
            "{input_image}": input_filename,
            "{output_prefix}": output_prefix,
            "{seed}": random.randint(1, 1_000_000),
            "{prompt}": prompt.strip() or DEFAULT_EMPTY_PROMPT,
            "{steps}": steps,
        },
    )

    # 4. Run on ComfyUI via websocket.
    try:
        png_bytes = await client.run_for_image(wf_data, settings.generate_timeout)
        return StreamingResponse(io.BytesIO(png_bytes), media_type="image/png")
    except ComfyExecutionError as e:
        # Node-level execution failure (most commonly a cloud-provider node
        # refusing). If the client asked us to swallow this class of error
        # AND the failing node is in our allow-list, return 204 — the
        # frontend treats that as a silent skip and the iterative loop
        # continues. Otherwise re-raise as a normal 500.
        if skip_provider_errors and e.node_type in _SWALLOWABLE_NODE_CLASSES:
            log.info(
                "Swallowing ComfyUI execution error on %s (%s): %s",
                e.node_id,
                e.node_type,
                e,
            )
            return Response(status_code=204)
        log.error("ComfyUI execution error: %s", e)
        raise HTTPException(500, str(e)) from e
    except ComfyError as e:
        log.error("ComfyUI error: %s", e)
        raise HTTPException(500, str(e)) from e
