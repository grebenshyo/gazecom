"""Configuration loaded from environment / .env file.

Resolves the project root from this file's location so paths and the
.env lookup work regardless of where uvicorn was invoked from. The
default values for `workflows_dir` and `images_dir` point at the
project root's sibling folders. ComfyUI is reached purely over its
API, so the only ComfyUI setting is `comfy_host` (host:port).
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/gengaze/config.py → backend/gengaze → backend → project root
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


class Settings(BaseSettings):
    """All runtime configuration for the gazeCOM backend."""

    model_config = SettingsConfigDict(
        env_file=str(PROJECT_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ComfyUI — gazeCOM talks to it purely over the HTTP + websocket API,
    # so this host:port is the only ComfyUI setting required. The ComfyUI
    # server can run anywhere reachable (localhost, LAN, remote/cloud).
    comfy_host: str = Field(
        default="127.0.0.1:8188",
        description="host:port of ComfyUI",
    )
    # Ollama — used for prompt enhancement. Same host:port shape as
    # ComfyUI and persisted through the app settings drawer.
    ollama_host: str = Field(
        default="127.0.0.1:11434",
        description="host:port of Ollama",
    )
    ollama_keep_model_loaded: bool = Field(
        default=False,
        description="keep the Ollama LLM loaded after prompt enhancement",
    )

    # gazeCOM assets — default to project-root subdirs.
    workflows_dir: Path = Field(default=PROJECT_ROOT / "workflows")
    # Optional writable workflow root. Packaged builds point this at the
    # per-user data directory; source development uses only workflows_dir.
    user_workflows_dir: Path | None = None
    images_dir: Path = Field(default=PROJECT_ROOT / "images")

    # HTTP server
    host: str = "127.0.0.1"
    port: int = 8000

    # CORS - Vite's two normal local origins. Explicitly configure LAN
    # origins when exposing a development backend to another machine.
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # Timeouts (seconds)
    generate_timeout: int = 300
    llm_timeout: int = 60

    @property
    def comfy_http(self) -> str:
        return f"http://{self.comfy_host}"

    @property
    def comfy_ws(self) -> str:
        return f"ws://{self.comfy_host}/ws"


def get_settings() -> Settings:
    """Singleton accessor used by FastAPI dependency injection."""
    return _settings


_settings = Settings()
