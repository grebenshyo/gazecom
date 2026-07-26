"""Direct Ollama prompt enhancement routes.

This replaces the older "LLM via ComfyUI workflow" path. gazeCOM still
keeps the browser talking only to its own backend, while the backend calls
Ollama's local HTTP API directly.
"""

from __future__ import annotations

import json
import re
from base64 import b64encode
from collections.abc import Callable
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from gazecom.config import Settings, get_settings
from gazecom.user_config import (
    resolve_ollama_host,
    resolve_ollama_keep_model_loaded,
)

router = APIRouter()

OllamaThink = bool | Literal["low", "medium", "high", "max"]
OllamaThinkingMode = Literal["off", "on", "low", "medium", "high", "max"]

DEFAULT_ENHANCE_TEMPLATE = (
    "Rewrite this into a stronger image-generation prompt:\n\n"
    '"{prompt}"\n\n'
    "Return only the rewritten prompt, no explanation.\n"
    "Keep it concise."
)
_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)
_WHITESPACE_RE = re.compile(r"\s+")
_EMPTY_SENTINEL = "<empty>"
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
    model: str = Field(min_length=1)
    template: str = DEFAULT_ENHANCE_TEMPLATE
    think: OllamaThink | None = None


class LLMEnhanceOut(BaseModel):
    text: str


class LLMModelInfo(BaseModel):
    name: str
    capabilities: list[str] = []
    thinking_modes: list[OllamaThinkingMode] = []


class LLMModelsOut(BaseModel):
    models: list[LLMModelInfo]


class LLMPointOut(BaseModel):
    # Salient point, normalized to [0, 1] over the submitted image.
    x: float
    y: float


class VLMComposeDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=0, le=1000)
    y: float = Field(ge=0, le=1000)
    instruction: str = Field(min_length=1)


class VLMComposeDecisionOut(BaseModel):
    # Coordinates are normalized to [0, 1] over the submitted canvas.
    x: float
    y: float
    instruction: str


class VLMComposeHistoryItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    instruction: str = Field(min_length=1)


_COMPOSE_HISTORY_ADAPTER = TypeAdapter(list[VLMComposeHistoryItem])


class VLMGuideDecision(BaseModel):
    model_config = ConfigDict(extra="ignore")

    x: float = Field(ge=0, le=1000)
    y: float = Field(ge=0, le=1000)


class VLMGuideDecisionOut(BaseModel):
    x: float
    y: float


class VLMGuideHistoryItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


_GUIDE_HISTORY_ADAPTER = TypeAdapter(list[VLMGuideHistoryItem])


class VLMSelectDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=0, le=1000)
    y: float = Field(ge=0, le=1000)
    prompt_id: int


class VLMSelectDecisionOut(BaseModel):
    x: float
    y: float
    prompt_id: int


class VLMSelectHistoryItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    prompt_id: int
    prompt: str


_SELECT_HISTORY_ADAPTER = TypeAdapter(list[VLMSelectHistoryItem])


class VLMHybridDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=0, le=1000)
    y: float = Field(ge=0, le=1000)
    source: Literal["pool", "write"]
    prompt_id: int = Field(ge=0)
    instruction: str


class VLMHybridDecisionOut(BaseModel):
    x: float
    y: float
    source: Literal["pool", "write"]
    prompt_id: int
    instruction: str


class VLMHybridHistoryItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    source: Literal["pool", "write"]
    prompt_id: int = Field(ge=0)
    instruction: str
    prompt: str


_HYBRID_HISTORY_ADAPTER = TypeAdapter(list[VLMHybridHistoryItem])
_PROMPT_IDS_ADAPTER = TypeAdapter(list[int])


def _thinking_modes_for_model(item: dict[str, Any]) -> list[OllamaThinkingMode]:
    capabilities = item.get("capabilities")
    if not isinstance(capabilities, list) or "thinking" not in capabilities:
        return []

    details = item.get("details")
    families: set[str] = set()
    if isinstance(details, dict):
        family = details.get("family")
        if isinstance(family, str):
            families.add(family.casefold())
        listed_families = details.get("families")
        if isinstance(listed_families, list):
            families.update(
                family.casefold() for family in listed_families if isinstance(family, str)
            )

    # Ollama exposes the model family and broad thinking capability, but not
    # its accepted effort values. Keep the compatibility mapping here rather
    # than making the UI guess from model names.
    if "gptoss" in families:
        return ["low", "medium", "high"]
    if "gemma4" in families:
        return ["off", "low", "medium", "high", "max"]
    return ["off", "on"]


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
    return (
        _WHITESPACE_RE.sub(" ", a).strip().casefold()
        == _WHITESPACE_RE.sub(" ", b).strip().casefold()
    )


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


def _extract_ollama_thinking(body: dict[str, Any]) -> str:
    thinking = body.get("thinking")
    if isinstance(thinking, str):
        return thinking
    message = body.get("message")
    if isinstance(message, dict) and isinstance(message.get("thinking"), str):
        return message["thinking"]
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


def _validate_compose_decision(
    body: Any,
) -> tuple[VLMComposeDecisionOut | None, str | None]:
    if not isinstance(body, dict):
        return None, "unexpected non-object response"
    text = _strip_model_output(_extract_ollama_text(body))
    if not text:
        # Qwen3-VL thinking checkpoints can place schema-constrained output in
        # Ollama's thinking field even with think=false. Only accept it when the
        # entire field validates as the strict decision object below.
        text = _strip_model_output(_extract_ollama_thinking(body))
    if not text:
        return None, f"empty compose decision ({_body_summary(body)})"
    try:
        decision = VLMComposeDecision.model_validate_json(text)
    except ValidationError as e:
        return None, f"invalid compose decision ({_short_detail(str(e))})"

    instruction = decision.instruction.strip()
    if not instruction:
        return None, "empty compose instruction"
    x, y = _normalize_coord(decision.x, decision.y)
    return VLMComposeDecisionOut(x=x, y=y, instruction=instruction), None


def _validate_guide_decision(
    body: Any,
) -> tuple[VLMGuideDecisionOut | None, str | None]:
    if not isinstance(body, dict):
        return None, "unexpected non-object response"
    text = _strip_model_output(_extract_ollama_text(body))
    if not text:
        text = _strip_model_output(_extract_ollama_thinking(body))
    if not text:
        return None, f"empty guide decision ({_body_summary(body)})"
    try:
        decision = VLMGuideDecision.model_validate_json(text)
    except ValidationError as e:
        return None, f"invalid guide decision ({_short_detail(str(e))})"

    x, y = _normalize_coord(decision.x, decision.y)
    return VLMGuideDecisionOut(x=x, y=y), None


def _validate_select_decision(
    body: Any,
    allowed_prompt_ids: set[int],
) -> tuple[VLMSelectDecisionOut | None, str | None]:
    if not isinstance(body, dict):
        return None, "unexpected non-object response"
    text = _strip_model_output(_extract_ollama_text(body))
    if not text:
        text = _strip_model_output(_extract_ollama_thinking(body))
    if not text:
        return None, f"empty select decision ({_body_summary(body)})"
    try:
        decision = VLMSelectDecision.model_validate_json(text)
    except ValidationError as e:
        return None, f"invalid select decision ({_short_detail(str(e))})"
    if decision.prompt_id not in allowed_prompt_ids:
        return None, f"unknown prompt ID {decision.prompt_id}"

    x, y = _normalize_coord(decision.x, decision.y)
    return VLMSelectDecisionOut(
        x=x,
        y=y,
        prompt_id=decision.prompt_id,
    ), None


def _validate_hybrid_decision(
    body: Any,
    allowed_prompt_ids: set[int],
) -> tuple[VLMHybridDecisionOut | None, str | None]:
    if not isinstance(body, dict):
        return None, "unexpected non-object response"
    text = _strip_model_output(_extract_ollama_text(body))
    if not text:
        text = _strip_model_output(_extract_ollama_thinking(body))
    if not text:
        return None, f"empty hybrid decision ({_body_summary(body)})"
    try:
        decision = VLMHybridDecision.model_validate_json(text)
    except ValidationError as e:
        return None, f"invalid hybrid decision ({_short_detail(str(e))})"

    instruction = decision.instruction.strip()
    if decision.source == "pool":
        if decision.prompt_id not in allowed_prompt_ids:
            return None, f"unknown prompt ID {decision.prompt_id}"
        if instruction:
            return None, "pool decision must return an empty instruction"
    else:
        if decision.prompt_id != 0:
            return None, "write decision must use prompt ID 0"
        if not instruction:
            return None, "write decision returned an empty instruction"

    x, y = _normalize_coord(decision.x, decision.y)
    return VLMHybridDecisionOut(
        x=x,
        y=y,
        source=decision.source,
        prompt_id=decision.prompt_id,
        instruction=instruction,
    ), None


def _short_detail(text: str, max_len: int = 400) -> str:
    text = text.strip()
    if len(text) <= max_len:
        return text
    return text[: max_len - 1].rstrip() + "…"


def _ollama_attempts(
    chat_payload: dict[str, Any],
    generate_payload: dict[str, Any],
    think: OllamaThink | None,
) -> list[tuple[str, str, dict[str, Any]]]:
    if think is not None:
        chat_payload["think"] = think
        generate_payload["think"] = think
    mode = str(think).lower() if think is not None else "default"
    return [
        (f"chat+{mode}", "/api/chat", chat_payload),
        (f"generate+{mode}", "/api/generate", generate_payload),
    ]


def _parse_compose_history(raw: str) -> list[VLMComposeHistoryItem]:
    try:
        return _COMPOSE_HISTORY_ADAPTER.validate_json(raw)
    except ValidationError as e:
        raise HTTPException(
            400,
            f"Compose history is invalid: {_short_detail(str(e))}",
        ) from e


def _parse_guide_history(raw: str) -> list[VLMGuideHistoryItem]:
    try:
        return _GUIDE_HISTORY_ADAPTER.validate_json(raw)
    except ValidationError as e:
        raise HTTPException(
            400,
            f"Guide history is invalid: {_short_detail(str(e))}",
        ) from e


def _parse_select_history(raw: str) -> list[VLMSelectHistoryItem]:
    try:
        return _SELECT_HISTORY_ADAPTER.validate_json(raw)
    except ValidationError as e:
        raise HTTPException(
            400,
            f"Select history is invalid: {_short_detail(str(e))}",
        ) from e


def _parse_hybrid_history(raw: str) -> list[VLMHybridHistoryItem]:
    try:
        return _HYBRID_HISTORY_ADAPTER.validate_json(raw)
    except ValidationError as e:
        raise HTTPException(
            400,
            f"Hybrid history is invalid: {_short_detail(str(e))}",
        ) from e


def _parse_prompt_ids(raw: str, *, allow_empty: bool = False) -> list[int]:
    try:
        prompt_ids = _PROMPT_IDS_ADAPTER.validate_json(raw)
    except ValidationError as e:
        raise HTTPException(
            400,
            f"Select prompt IDs are invalid: {_short_detail(str(e))}",
        ) from e
    if not prompt_ids and not allow_empty:
        raise HTTPException(400, "Select requires at least one prompt ID.")
    if any(prompt_id < 1 for prompt_id in prompt_ids):
        raise HTTPException(400, "Select prompt IDs must be positive integers.")
    if len(prompt_ids) != len(set(prompt_ids)):
        raise HTTPException(400, "Select prompt IDs must be unique.")
    return prompt_ids


def _decision_chat_messages(
    instruction: str,
    history: (
        list[VLMComposeHistoryItem]
        | list[VLMGuideHistoryItem]
        | list[VLMSelectHistoryItem]
        | list[VLMHybridHistoryItem]
    ),
    image_b64: str,
    previous_image_b64: str | None = None,
    *,
    behavior: Literal["compose", "guide", "select", "hybrid"],
) -> list[dict[str, Any]]:
    images = (
        [previous_image_b64, image_b64]
        if previous_image_b64 is not None
        else [image_b64]
    )
    if not history:
        return [
            {
                "role": "user",
                "content": instruction,
                "images": images,
            }
        ]

    # Text carries long-term continuity. Visual memory is deliberately bounded
    # to one previous canvas plus the current canvas.
    messages: list[dict[str, Any]] = [{"role": "user", "content": instruction}]
    for action in history:
        action_payload: dict[str, float | str] = {
            "x": round(action.x * 1000, 3),
            "y": round(action.y * 1000, 3),
        }
        if behavior == "compose" and isinstance(action, VLMComposeHistoryItem):
            action_payload["instruction"] = action.instruction.strip()
        elif behavior == "select" and isinstance(action, VLMSelectHistoryItem):
            action_payload["prompt_id"] = action.prompt_id
        elif behavior == "hybrid" and isinstance(action, VLMHybridHistoryItem):
            action_payload["source"] = action.source
            action_payload["prompt_id"] = action.prompt_id
            action_payload["instruction"] = action.instruction.strip()
        messages.append(
            {
                "role": "assistant",
                "content": json.dumps(action_payload, separators=(",", ":")),
            }
        )
        applied = "The crop centered at that coordinate was generated and composited."
        if behavior == "select" and isinstance(action, VLMSelectHistoryItem):
            applied = (
                f"The crop was generated with prompt ID {action.prompt_id}: "
                f"{json.dumps(action.prompt)}"
            )
        elif behavior == "hybrid" and isinstance(action, VLMHybridHistoryItem):
            applied = (
                f"The crop used the {action.source} source and was generated "
                f"with this final prompt: {json.dumps(action.prompt)}"
            )
        messages.append({"role": "user", "content": applied})
    messages.append(
        {
            "role": "user",
            "content": instruction,
            "images": images,
        }
    )
    return messages


def _flatten_chat_messages(messages: list[dict[str, Any]]) -> str:
    return "\n\n".join(
        f"{str(message.get('role', 'user')).upper()}: {str(message.get('content', '')).strip()}"
        for message in messages
    )


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
            models: list[LLMModelInfo] = []
            for item in body.get("models", []):
                if isinstance(item, dict) and isinstance(item.get("name"), str):
                    capabilities = item.get("capabilities")
                    models.append(
                        LLMModelInfo(
                            name=item["name"],
                            capabilities=sorted(
                                {
                                    capability
                                    for capability in capabilities
                                    if isinstance(capability, str)
                                },
                                key=str.casefold,
                            )
                            if isinstance(capabilities, list)
                            else [],
                            thinking_modes=_thinking_modes_for_model(item),
                        )
                    )

    except httpx.HTTPError as e:
        raise HTTPException(502, f"Ollama model list failed: {e}") from e

    return LLMModelsOut(models=sorted(models, key=lambda model: model.name.casefold()))


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
        "stream": False,
        "keep_alive": keep_alive,
        "options": options,
    }
    generate_payload: dict[str, Any] = {
        "model": model,
        "prompt": task_prompt,
        "stream": False,
        "keep_alive": keep_alive,
        "options": options,
    }
    attempts = _ollama_attempts(chat_payload, generate_payload, body.think)
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
    model: str = Form(min_length=1),
    prompt: str = Form(default=""),
    think: OllamaThink | None = Form(default=None),
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
        "stream": False,
        "keep_alive": keep_alive,
        "options": options,
    }
    generate_payload: dict[str, Any] = {
        "model": model_name,
        "prompt": instruction,
        "images": [image_b64],
        "stream": False,
        "keep_alive": keep_alive,
        "options": options,
    }
    attempts = _ollama_attempts(chat_payload, generate_payload, think)
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
    model: str = Form(min_length=1),
    prompt: str = Form(default=""),
    think: OllamaThink | None = Form(default=None),
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
        "stream": False,
        "keep_alive": keep_alive,
        "options": options,
    }
    generate_payload: dict[str, Any] = {
        "model": model_name,
        "prompt": instruction,
        "images": [image_b64],
        "stream": False,
        "keep_alive": keep_alive,
        "options": options,
    }
    attempts = _ollama_attempts(chat_payload, generate_payload, think)
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


@router.post(
    "/llm/decision",
    summary="Choose the next canvas action or location through Ollama",
)
async def decision(
    image: UploadFile = File(...),
    previous_image: UploadFile | None = File(default=None),
    model: str = Form(min_length=1),
    prompt: str = Form(min_length=1),
    history: str = Form(default="[]"),
    behavior: Literal["compose", "guide", "select", "hybrid"] = Form(default="compose"),
    prompt_ids: str = Form(default="[]"),
    think: OllamaThink | None = Form(default=None),
    settings: Settings = Depends(get_settings),
) -> VLMComposeDecisionOut | VLMGuideDecisionOut | VLMSelectDecisionOut | VLMHybridDecisionOut:
    instruction = prompt.strip()
    if not instruction:
        raise HTTPException(400, f"{behavior.title()} prompt is empty.")
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(400, "Image is empty.")

    image_b64 = b64encode(image_bytes).decode("ascii")
    previous_image_b64: str | None = None
    if previous_image is not None:
        previous_image_bytes = await previous_image.read()
        if not previous_image_bytes:
            raise HTTPException(400, "Previous image is empty.")
        previous_image_b64 = b64encode(previous_image_bytes).decode("ascii")
    model_name = model.strip()
    parsed_history: (
        list[VLMComposeHistoryItem]
        | list[VLMGuideHistoryItem]
        | list[VLMSelectHistoryItem]
        | list[VLMHybridHistoryItem]
    )
    validate_decision: Callable[
        [Any],
        tuple[
            VLMComposeDecisionOut
            | VLMGuideDecisionOut
            | VLMSelectDecisionOut
            | VLMHybridDecisionOut
            | None,
            str | None,
        ],
    ]
    if behavior == "compose":
        parsed_history = _parse_compose_history(history)
        output_schema = VLMComposeDecision.model_json_schema()
        validate_decision = _validate_compose_decision
    elif behavior == "guide":
        parsed_history = _parse_guide_history(history)
        output_schema = VLMGuideDecision.model_json_schema()
        validate_decision = _validate_guide_decision
    elif behavior == "select":
        parsed_history = _parse_select_history(history)
        allowed_prompt_ids = _parse_prompt_ids(prompt_ids)
        allowed_prompt_id_set = set(allowed_prompt_ids)
        output_schema = VLMSelectDecision.model_json_schema()
        output_schema["properties"]["prompt_id"]["enum"] = allowed_prompt_ids

        def validate_select_decision(
            body: Any,
        ) -> tuple[VLMSelectDecisionOut | None, str | None]:
            return _validate_select_decision(body, allowed_prompt_id_set)

        validate_decision = validate_select_decision
    else:
        parsed_history = _parse_hybrid_history(history)
        allowed_prompt_ids = _parse_prompt_ids(prompt_ids, allow_empty=True)
        allowed_prompt_id_set = set(allowed_prompt_ids)
        output_schema = VLMHybridDecision.model_json_schema()
        output_schema["properties"]["prompt_id"]["enum"] = [0, *allowed_prompt_ids]

        def validate_hybrid_decision(
            body: Any,
        ) -> tuple[VLMHybridDecisionOut | None, str | None]:
            return _validate_hybrid_decision(body, allowed_prompt_id_set)

        validate_decision = validate_hybrid_decision

    options = {
        "temperature": 0.1,
        "num_predict": OLLAMA_DESCRIBE_NUM_PREDICT,
    }
    keep_alive = _ollama_keep_alive(settings)
    messages = _decision_chat_messages(
        instruction,
        parsed_history,
        image_b64,
        previous_image_b64,
        behavior=behavior,
    )
    chat_payload: dict[str, Any] = {
        "model": model_name,
        "messages": messages,
        "format": output_schema,
        "stream": False,
        "keep_alive": keep_alive,
        "options": options,
    }
    generate_payload: dict[str, Any] = {
        "model": model_name,
        "prompt": _flatten_chat_messages(messages),
        "images": (
            [previous_image_b64, image_b64]
            if previous_image_b64 is not None
            else [image_b64]
        ),
        "format": output_schema,
        "stream": False,
        "keep_alive": keep_alive,
        "options": options,
    }
    attempts = _ollama_attempts(chat_payload, generate_payload, think)
    base_url = _ollama_base_url(resolve_ollama_host(settings))
    failures: list[str] = []
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
                parsed, failure = validate_decision(response_body)
                if parsed is not None:
                    return parsed
                failures.append(f"{label}: {failure}")
    except httpx.HTTPError as e:
        failures.append(f"client: {_short_detail(str(e))}")

    status = 422 if got_response else 502
    raise HTTPException(
        status,
        f"Ollama {behavior} decision failed. Attempts: {'; '.join(failures)}",
    )
