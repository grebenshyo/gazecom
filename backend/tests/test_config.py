"""Tests for the runtime config route + user_config resolution.

The per-user config dir is isolated to a tmp_path via the platform env
vars (HOME on macOS, XDG_CONFIG_HOME on Linux, APPDATA on Windows) so the
real user config is never touched.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from gengaze.config import Settings, get_settings
from gengaze.launcher import _ensure_workflows_dir
from gengaze.main import create_app
from gengaze.user_config import config_dir, config_path, load_config


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    # Isolate the config dir on every platform, and make sure no stray
    # COMFY_HOST env leaks into the default-fallback assertions.
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("APPDATA", str(tmp_path))
    monkeypatch.delenv("COMFY_HOST", raising=False)

    workflows = tmp_path / "workflows"
    images = tmp_path / "images"
    workflows.mkdir()
    images.mkdir()
    settings = Settings(workflows_dir=workflows, images_dir=images)
    app = create_app(settings)
    app.dependency_overrides[get_settings] = lambda: settings
    return TestClient(app)


def test_config_falls_back_to_settings_default(client: TestClient) -> None:
    assert client.get("/api/config").json() == {
        "comfy_host": "127.0.0.1:8188",
        "ollama_host": "127.0.0.1:11434",
        "ollama_keep_model_loaded": False,
        "comfy_host_override": None,
        "ollama_host_override": None,
    }


def test_packaged_workflow_root_has_all_categories(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("APPDATA", str(tmp_path))

    root = _ensure_workflows_dir()

    assert root.name == "workflows"
    assert all((root / category).is_dir() for category in ("img", "edit", "inpainting"))


def test_config_put_persists_and_overrides(client: TestClient) -> None:
    resp = client.put("/api/config", json={"comfy_host": "host.local:9000"})
    assert resp.status_code == 200
    assert resp.json() == {
        "comfy_host": "host.local:9000",
        "ollama_host": "127.0.0.1:11434",
        "ollama_keep_model_loaded": False,
        "comfy_host_override": "host.local:9000",
        "ollama_host_override": None,
    }
    # A fresh GET reflects the persisted override, not the default.
    assert client.get("/api/config").json() == {
        "comfy_host": "host.local:9000",
        "ollama_host": "127.0.0.1:11434",
        "ollama_keep_model_loaded": False,
        "comfy_host_override": "host.local:9000",
        "ollama_host_override": None,
    }


def test_config_put_persists_ollama_host(client: TestClient) -> None:
    resp = client.put("/api/config", json={"ollama_host": "ollama.local:11434"})
    assert resp.status_code == 200
    assert resp.json() == {
        "comfy_host": "127.0.0.1:8188",
        "ollama_host": "ollama.local:11434",
        "ollama_keep_model_loaded": False,
        "comfy_host_override": None,
        "ollama_host_override": "ollama.local:11434",
    }
    assert client.get("/api/config").json() == {
        "comfy_host": "127.0.0.1:8188",
        "ollama_host": "ollama.local:11434",
        "ollama_keep_model_loaded": False,
        "comfy_host_override": None,
        "ollama_host_override": "ollama.local:11434",
    }


def test_config_put_persists_ollama_keep_model_loaded(client: TestClient) -> None:
    resp = client.put("/api/config", json={"ollama_keep_model_loaded": True})
    assert resp.status_code == 200
    assert resp.json() == {
        "comfy_host": "127.0.0.1:8188",
        "ollama_host": "127.0.0.1:11434",
        "ollama_keep_model_loaded": True,
        "comfy_host_override": None,
        "ollama_host_override": None,
    }
    assert client.get("/api/config").json() == {
        "comfy_host": "127.0.0.1:8188",
        "ollama_host": "127.0.0.1:11434",
        "ollama_keep_model_loaded": True,
        "comfy_host_override": None,
        "ollama_host_override": None,
    }


def test_config_trims_whitespace(client: TestClient) -> None:
    resp = client.put(
        "/api/config",
        json={"comfy_host": "  lan:8188  ", "ollama_host": "  ollama:11434  "},
    )
    assert resp.json() == {
        "comfy_host": "lan:8188",
        "ollama_host": "ollama:11434",
        "ollama_keep_model_loaded": False,
        "comfy_host_override": "lan:8188",
        "ollama_host_override": "ollama:11434",
    }


def test_config_rejects_empty(client: TestClient) -> None:
    assert client.put("/api/config", json={"comfy_host": ""}).status_code == 422
    assert client.put("/api/config", json={"ollama_host": ""}).status_code == 422


def test_config_delete_resets_overrides_and_preserves_user_data(
    client: TestClient,
) -> None:
    client.put(
        "/api/config",
        json={
            "comfy_host": "comfy.local:8188",
            "ollama_host": "ollama.local:11434",
            "ollama_keep_model_loaded": True,
        },
    )
    images = config_dir() / "images"
    images.mkdir()
    saved_image = images / "saved.png"
    saved_image.write_bytes(b"user image")

    resp = client.delete("/api/config")

    assert resp.status_code == 200
    assert resp.json() == {
        "comfy_host": "127.0.0.1:8188",
        "ollama_host": "127.0.0.1:11434",
        "ollama_keep_model_loaded": False,
        "comfy_host_override": None,
        "ollama_host_override": None,
    }
    assert not config_path().exists()
    assert saved_image.read_bytes() == b"user image"
    assert client.delete("/api/config").status_code == 200


def test_legacy_user_data_is_migrated(
    client: TestClient,
) -> None:
    current = config_dir()
    legacy = current.with_name("GenGaze")
    legacy.mkdir(parents=True)
    (legacy / "config.json").write_text(
        '{"comfy_host": "legacy.local:8188"}',
        encoding="utf-8",
    )
    images = legacy / "images"
    images.mkdir()
    (images / "saved.png").write_bytes(b"legacy image")

    assert load_config()["comfy_host"] == "legacy.local:8188"
    assert (current / "config.json").is_file()
    assert (current / "images" / "saved.png").read_bytes() == b"legacy image"
