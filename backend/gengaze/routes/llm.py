"""Direct Ollama prompt enhancement routes.

This replaces the older "LLM via ComfyUI workflow" path. gazeCOM still
keeps the browser talking only to its own backend, while the backend calls
Ollama's local HTTP API directly.
"""

from __future__ import annotations

import re
from base64 import b64encode
from typing import Any

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from gengaze.config import Settings, get_settings
from gengaze.user_config import (
    resolve_ollama_host,
    resolve_ollama_keep_model_loaded,
)

router = APIRouter()

DEFAULT_MODEL = "mistral"
DEFAULT_ENHANCE_TEMPLATE = (
    'Rewrite this into a stronger image-generation prompt:\n\n'
    '"{prompt}"\n\n'
    "Return only the rewritten prompt, no explanation.\n"
    "Keep it concise."
)
_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)
_WHITESPACE_RE = re.compile(r"\s+")
_EMPTY_SENTINEL = "<empty>"
OLLAMA_THINK_LEVEL = "low"
OLLAMA_NUM_PREDICT = 2048
OLLAMA_DESCRIBE_NUM_PREDICT = 2048

# Default instruction for the /llm/point endpoint. Qwen-VL-family models emit
# 0-1000 grid coordinates natively; the strict-JSON shape keeps parsing cheap.
# The client may override this via the multipart `prompt` field.
POINT_SYSTEM_PROMPT = (
    "Look at this image and identify the single most visually salient point — "
    "the one location a viewer's eye is drawn to first. Respond with ONLY that "
    "point's coordinates as strict JSON on a 0-1000 grid, where (0,0) is the "
    "top-left corner and (1000,1000) is the bottom-right corner: "
    '{"x": <0-1000>, "y": <0-1000>}. No explanation, no other text.'
)
_NUM = r"(-?\d+(?:\.\d+)?)"
_POINT_X_RE = re.compile(r"[\"']?x[\"']?\s*[:=]\s*" + _NUM, re.IGNORECASE)
_POINT_Y_RE = re.compile(r"[\"']?y[\"']?\s*[:=]\s*" + _NUM, re.IGNORECASE)
_POINT_NUM_RE = re.compile(_NUM)


class LLMEnhanceIn(BaseModel):
    prompt: str = Field(min_length=1)
    model: str = Field(default=DEFAULT_MODEL, min_length=1)
    template: str = DEFAULT_ENHANCE_TEMPLATE


class LLMEnhanceOut(BaseModel):
    text: str


class LLMModelsOut(BaseModel):
    models: list[str]
    # Subset of `models` whose Ollama capabilities include "vision" —
    # candidates for the frontend's Vision-model dropdown.
    vision: list[str] = []


class LLMPointOut(BaseModel):
    # Salient point, normalized to [0, 1] over the submitted image.
    x: float
    y: float


def _ollama_base_url(host: str) -> str:
    host = host.strip().rstrip("/")
    if host.startswith(("http://", "https://")):
        return host
    return f"http://{host}"


def _strip_model_output(text: str) -> str:
    # Thinking models such as deepseek-r1 may include hidden reasoning tags.
    text = _THINK_BLOCK_RE.sub("", text)
    return text.strip().strip('"').strip()


def _same_prompt(a: str, b: str) -> bool:
    return _WHITESPACE_RE.sub(" ", a).strip().casefold() == _WHITESPACE_RE.sub(
        " ", b
    ).strip().casefold()


def _render_enhance_prompt(template: str, prompt: str) -> str:
    template = template.strip() or DEFAULT_ENHANCE_TEMPLATE
    if "{prompt}" in template:
        return template.replace("{prompt}", prompt)
    return f"{template}\n{prompt}"


def _extract_ollama_text(body: dict[str, Any]) -> str:
    response = body.get("response")
    if isinstance(response, str):
        return response
    message = body.get("message")
    if isinstance(message, dict) and isinstance(message.get("content"), str):
        return message["content"]
    return ""


def _body_summary(body: dict[str, Any]) -> str:
    keys = ", ".join(sorted(str(k) for k in body.keys())) or "none"
    done_reason = body.get("done_reason") or body.get("error") or _EMPTY_SENTINEL
    message = body.get("message")
    if isinstance(message, dict):
        message_keys = ", ".join(sorted(str(k) for k in message.keys())) or "none"
        content = message.get("content")
        thinking = message.get("thinking")
        content_len = len(content) if isinstance(content, str) else 0
        thinking_len = len(thinking) if isinstance(thinking, str) else 0
        return (
            f"keys={keys}; message_keys={message_keys}; "
            f"content_len={content_len}; thinking_len={thinking_len}; "
            f"done_reason={done_reason}"
        )
    return f"keys={keys}; done_reason={done_reason}"


def _validate_enhancement(body: Any, prompt: str) -> tuple[str | None, str | None]:
    if not isinstance(body, dict):
        return None, "unexpected non-object response"
    text = _strip_model_output(_extract_ollama_text(body))
    if not text:
        return None, f"empty prompt enhancement ({_body_summary(body)})"
    if _same_prompt(text, prompt):
        return None, "prompt unchanged"
    return text, None


def _validate_description(body: Any) -> tuple[str | None, str | None]:
    if not isinstance(body, dict):
        return None, "unexpected non-object response"
    text = _strip_model_output(_extract_ollama_text(body))
    if not text:
        return None, f"empty image description ({_body_summary(body)})"
    return text, None


def _normalize_coord(x: float, y: float) -> tuple[float, float]:
    # Instruction asks for a 0-1000 grid, but some models emit already-
    # normalized [0, 1] floats. Detect that so we don't collapse everything
    # to ~0 by dividing a fraction by 1000. Anything bigger is grid-space.
    scale = 1.0 if max(abs(x), abs(y)) <= 1.0 else 1000.0
    nx = min(1.0, max(0.0, x / scale))
    ny = min(1.0, max(0.0, y / scale))
    return nx, ny


def _parse_point(text: str) -> tuple[float, float] | None:
    # Defensive: strip <think> noise, then prefer explicitly keyed x/y (handles
    # {"x":512,"y":380}, x=512 y=380, "x": 0.5 …) before falling back to the
    # first two bare numbers ("(512, 380)", "512 380").
    text = _strip_model_output(text)
    if not text:
        return None
    xm = _POINT_X_RE.search(text)
    ym = _POINT_Y_RE.search(text)
    if xm and ym:
        return _normalize_coord(float(xm.group(1)), float(ym.group(1)))
    nums = _POINT_NUM_RE.findall(text)
    if len(nums) >= 2:
        return _normalize_coord(float(nums[0]), float(nums[1]))
    return None


def _validate_point(
    body: Any,
) -> tuple[tuple[float, float] | None, str | None]:
    if not isinstance(body, dict):
        return None, "unexpected non-object response"
    point = _parse_point(_extract_ollama_text(body))
    if point is None:
        return None, f"no coordinates in response ({_body_summary(body)})"
    return point, None


def _short_detail(text: str, max_len: int = 400) -> str:
    text = text.strip()
    if len(text) <= max_len:
        return text
    return text[: max_len - 1].rstrip() + "…"


def _without_think(payload: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if key != "think"}


def _ollama_keep_alive(settings: Settings) -> int:
    # Flux/Comfy often needs the GPU back immediately after prompt enhancement,
    # so the default is unload-after-use. When Ollama runs on a separate machine,
    # keep it resident to avoid the expensive model reload each generation.
    return -1 if resolve_ollama_keep_model_loaded(settings) else 0


@router.get("/llm/models", summary="List local Ollama models")
async def list_models(settings: Settings = Depends(get_settings)) -> LLMModelsOut:
    base_url = _ollama_base_url(resolve_ollama_host(settings))
    try:
        async with httpx.AsyncClient(timeout=settings.llm_timeout) as client:
            resp = await client.get(f"{base_url}/api/tags")
            resp.raise_for_status()

            body = resp.json()
            models: list[str] = []
            for item in body.get("models", []):
                if isinstance(item, dict) and isinstance(item.get("name"), str):
                    models.append(item["name"])

            # Vision capability per model via /api/show. A failed or odd
            # /api/show response just means "not vision" — the model list
            # itself must never break on capability probing.
            vision: list[str] = []
            for name in models:
                try:
                    show = await client.post(
                        f"{base_url}/api/show", json={"model": name}
                    )
                    show.raise_for_status()
                    caps = show.json().get("capabilities")
                except (httpx.HTTPError, ValueError):
                    continue
                if isinstance(caps, list) and "vision" in caps:
                    vision.append(name)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Ollama model list failed: {e}") from e

    return LLMModelsOut(
        models=sorted(models, key=str.casefold),
        vision=sorted(vision, key=str.casefold),
    )


@router.post("/llm/enhance", summary="Enhance a prompt through Ollama")
async def enhance(
    body: LLMEnhanceIn,
    settings: Settings = Depends(get_settings),
) -> LLMEnhanceOut:
    prompt = body.prompt.strip()
    model = body.model.strip()
    task_prompt = _render_enhance_prompt(body.template, prompt)
    options = {
        "temperature": 0.8,
        "num_predict": OLLAMA_NUM_PREDICT,
    }
    keep_alive = _ollama_keep_alive(settings)
    chat_payload: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "user", "content": task_prompt},
        ],
        "think": OLLAMA_THINK_LEVEL,
        "stream": False,
        "keep_alive": keep_alive,
        "options": options,
    }
    generate_payload: dict[str, Any] = {
        "model": model,
        "prompt": task_prompt,
        "think": OLLAMA_THINK_LEVEL,
        "stream": False,
        "keep_alive": keep_alive,
        "options": options,
    }
    attempts: list[tuple[str, str, dict[str, Any]]] = [
        ("chat+think", "/api/chat", chat_payload),
        ("chat", "/api/chat", _without_think(chat_payload)),
        ("generate+think", "/api/generate", generate_payload),
        ("generate", "/api/generate", _without_think(generate_payload)),
    ]
    base_url = _ollama_base_url(resolve_ollama_host(settings))
    failures: list[str] = []

    try:
        async with httpx.AsyncClient(timeout=settings.llm_timeout) as client:
            for label, path, payload in attempts:
                try:
                    resp = await client.post(f"{base_url}{path}", json=payload)
                    resp.raise_for_status()
                except httpx.HTTPStatusError as e:
                    failures.append(
                        f"{label}: HTTP {e.response.status_code} "
                        f"{_short_detail(e.response.text or str(e))}"
                    )
                    continue
                except httpx.HTTPError as e:
                    failures.append(f"{label}: {_short_detail(str(e))}")
                    continue

                try:
                    response_body = resp.json()
                except ValueError as e:
                    failures.append(f"{label}: invalid JSON response ({e})")
                    continue

                text, failure = _validate_enhancement(response_body, prompt)
                if text:
                    return LLMEnhanceOut(text=text)
                failures.append(f"{label}: {failure}")
    except httpx.HTTPError as e:
        # Defensive catch for errors raised while entering/leaving the client.
        failures.append(f"client: {_short_detail(str(e))}")

    raise HTTPException(502, f"Ollama enhance failed. Attempts: {'; '.join(failures)}")


@router.post("/llm/describe", summary="Describe an image through Ollama")
async def describe(
    image: UploadFile = File(...),
    model: str = Form(default=DEFAULT_MODEL, min_length=1),
    prompt: str = Form(default=""),
    settings: Settings = Depends(get_settings),
) -> LLMEnhanceOut:
    instruction = prompt.strip()
    if not instruction:
        raise HTTPException(400, "Vision prompt is empty.")
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(400, "Image is empty.")

    image_b64 = b64encode(image_bytes).decode("ascii")
    model_name = model.strip()
    options = {
        "temperature": 0.2,
        "num_predict": OLLAMA_DESCRIBE_NUM_PREDICT,
    }
    keep_alive = _ollama_keep_alive(settings)
    chat_payload: dict[str, Any] = {
        "model": model_name,
        "messages": [
            {
                "role": "user",
                "content": instruction,
                "images": [image_b64],
            }
        ],
        "think": OLLAMA_THINK_LEVEL,
        "stream": False,
        "keep_alive": keep_alive,
        "options": options,
    }
    generate_payload: dict[str, Any] = {
        "model": model_name,
        "prompt": instruction,
        "images": [image_b64],
        "think": OLLAMA_THINK_LEVEL,
        "stream": False,
        "keep_alive": keep_alive,
        "options": options,
    }
    attempts: list[tuple[str, str, dict[str, Any]]] = [
        ("chat+think", "/api/chat", chat_payload),
        ("chat", "/api/chat", _without_think(chat_payload)),
        ("generate+think", "/api/generate", generate_payload),
        ("generate", "/api/generate", _without_think(generate_payload)),
    ]
    base_url = _ollama_base_url(resolve_ollama_host(settings))
    failures: list[str] = []

    try:
        async with httpx.AsyncClient(timeout=settings.llm_timeout) as client:
            for label, path, payload in attempts:
                try:
                    resp = await client.post(f"{base_url}{path}", json=payload)
                    resp.raise_for_status()
                except httpx.HTTPStatusError as e:
                    failures.append(
                        f"{label}: HTTP {e.response.status_code} "
                        f"{_short_detail(e.response.text or str(e))}"
                    )
                    continue
                except httpx.HTTPError as e:
                    failures.append(f"{label}: {_short_detail(str(e))}")
                    continue

                try:
                    response_body = resp.json()
                except ValueError as e:
                    failures.append(f"{label}: invalid JSON response ({e})")
                    continue

                text, failure = _validate_description(response_body)
                if text:
                    return LLMEnhanceOut(text=text)
                failures.append(f"{label}: {failure}")
    except httpx.HTTPError as e:
        failures.append(f"client: {_short_detail(str(e))}")

    raise HTTPException(
        502,
        f"Ollama describe failed. Attempts: {'; '.join(failures)}",
    )


@router.post("/llm/point", summary="Locate the salient point in an image")
async def point(
    image: UploadFile = File(...),
    model: str = Form(default=DEFAULT_MODEL, min_length=1),
    prompt: str = Form(default=""),
    settings: Settings = Depends(get_settings),
) -> LLMPointOut:
    instruction = prompt.strip() or POINT_SYSTEM_PROMPT
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(400, "Image is empty.")

    image_b64 = b64encode(image_bytes).decode("ascii")
    model_name = model.strip()
    options = {
        "temperature": 0.1,
        "num_predict": OLLAMA_DESCRIBE_NUM_PREDICT,
    }
    keep_alive = _ollama_keep_alive(settings)
    chat_payload: dict[str, Any] = {
        "model": model_name,
        "messages": [
            {
                "role": "user",
                "content": instruction,
                "images": [image_b64],
            }
        ],
        "think": OLLAMA_THINK_LEVEL,
        "stream": False,
        "keep_alive": keep_alive,
        "options": options,
    }
    generate_payload: dict[str, Any] = {
        "model": model_name,
        "prompt": instruction,
        "images": [image_b64],
        "think": OLLAMA_THINK_LEVEL,
        "stream": False,
        "keep_alive": keep_alive,
        "options": options,
    }
    attempts: list[tuple[str, str, dict[str, Any]]] = [
        ("chat+think", "/api/chat", chat_payload),
        ("chat", "/api/chat", _without_think(chat_payload)),
        ("generate+think", "/api/generate", generate_payload),
        ("generate", "/api/generate", _without_think(generate_payload)),
    ]
    base_url = _ollama_base_url(resolve_ollama_host(settings))
    failures: list[str] = []
    # Distinguish "reached the model but couldn't parse a point" (422, worth a
    # client-side resubmit) from "never got a usable response" (502, transport).
    got_response = False

    try:
        async with httpx.AsyncClient(timeout=settings.llm_timeout) as client:
            for label, path, payload in attempts:
                try:
                    resp = await client.post(f"{base_url}{path}", json=payload)
                    resp.raise_for_status()
                except httpx.HTTPStatusError as e:
                    failures.append(
                        f"{label}: HTTP {e.response.status_code} "
                        f"{_short_detail(e.response.text or str(e))}"
                    )
                    continue
                except httpx.HTTPError as e:
                    failures.append(f"{label}: {_short_detail(str(e))}")
                    continue

                try:
                    response_body = resp.json()
                except ValueError as e:
                    failures.append(f"{label}: invalid JSON response ({e})")
                    continue

                got_response = True
                point_xy, failure = _validate_point(response_body)
                if point_xy is not None:
                    return LLMPointOut(x=point_xy[0], y=point_xy[1])
                failures.append(f"{label}: {failure}")
    except httpx.HTTPError as e:
        failures.append(f"client: {_short_detail(str(e))}")

    status = 422 if got_response else 502
    raise HTTPException(
        status,
        f"Ollama point failed. Attempts: {'; '.join(failures)}",
    )
