"""GET/PUT /api/config — runtime user configuration.

Currently the ComfyUI + Ollama hosts plus Ollama keep-loaded behavior, so
the packaged app can be pointed at local services without editing any file.
Persisted per-user via
``gengaze.user_config`` (outside the app bundle).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from gengaze.config import Settings, get_settings
from gengaze.user_config import (
    clear_config,
    load_config,
    save_config,
)

router = APIRouter()


class ConfigOut(BaseModel):
    comfy_host: str
    ollama_host: str
    ollama_keep_model_loaded: bool
    comfy_host_override: str | None
    ollama_host_override: str | None


class ConfigUpdate(BaseModel):
    comfy_host: str | None = Field(default=None, min_length=1)
    ollama_host: str | None = Field(default=None, min_length=1)
    ollama_keep_model_loaded: bool | None = None


def _config_out(settings: Settings) -> ConfigOut:
    stored = load_config()
    comfy_value = stored.get("comfy_host")
    ollama_value = stored.get("ollama_host")
    keep_loaded = stored.get("ollama_keep_model_loaded")
    comfy_override = (
        comfy_value.strip() if isinstance(comfy_value, str) and comfy_value.strip() else None
    )
    ollama_override = (
        ollama_value.strip()
        if isinstance(ollama_value, str) and ollama_value.strip()
        else None
    )
    return ConfigOut(
        comfy_host=comfy_override or settings.comfy_host,
        ollama_host=ollama_override or settings.ollama_host,
        ollama_keep_model_loaded=(
            keep_loaded
            if isinstance(keep_loaded, bool)
            else settings.ollama_keep_model_loaded
        ),
        comfy_host_override=comfy_override,
        ollama_host_override=ollama_override,
    )


@router.get("/config", summary="Read the effective runtime config")
async def get_config(settings: Settings = Depends(get_settings)) -> ConfigOut:
    return _config_out(settings)


@router.put("/config", summary="Update runtime config (persisted per-user)")
async def put_config(
    body: ConfigUpdate, settings: Settings = Depends(get_settings)
) -> ConfigOut:
    update: dict[str, str | bool] = {}
    if body.comfy_host is not None:
        update["comfy_host"] = body.comfy_host.strip()
    if body.ollama_host is not None:
        update["ollama_host"] = body.ollama_host.strip()
    if body.ollama_keep_model_loaded is not None:
        update["ollama_keep_model_loaded"] = body.ollama_keep_model_loaded
    save_config(update)
    return _config_out(settings)


@router.delete("/config", summary="Reset runtime config to environment defaults")
async def delete_config(settings: Settings = Depends(get_settings)) -> ConfigOut:
    clear_config()
    return _config_out(settings)
