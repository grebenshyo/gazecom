"""Tests for the workflows / images / health routes.

These don't touch ComfyUI — the generate endpoint integration test belongs
in a separate file (and ideally a live test with ComfyUI running).
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from gengaze.config import Settings, get_settings
from gengaze.main import create_app
from gengaze.workflow_catalog import resolve_workflow_path


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    """Settings rooted at a tmp_path with empty workflows/images dirs."""
    workflows = tmp_path / "workflows"
    images = tmp_path / "images"
    workflows.mkdir()
    images.mkdir()
    return Settings(
        workflows_dir=workflows,
        images_dir=images,
        cors_origins="*",
    )


@pytest.fixture
def client(settings: Settings) -> TestClient:
    app = create_app(settings)
    app.dependency_overrides[get_settings] = lambda: settings
    return TestClient(app)


# ── Health ──────────────────────────────────────────────────────────────


def test_health(client: TestClient) -> None:
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "version" in body


# ── Workflows ───────────────────────────────────────────────────────────


def test_list_workflows_empty(client: TestClient, settings: Settings) -> None:
    resp = client.get("/api/workflows")
    assert resp.status_code == 200
    assert resp.json() == []


def _api_workflow(*, steps: str | None = "{steps:4}") -> dict:
    sampler_inputs = {"steps": steps} if steps is not None else {}
    return {
        "1": {
            "class_type": "LoadImage",
            "inputs": {"image": "{input_image}"},
        },
        "2": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "{prompt}"},
        },
        "3": {"class_type": "KSampler", "inputs": sampler_inputs},
        "9": {"class_type": "PreviewImage", "inputs": {"images": ["3", 0]}},
    }


def test_list_workflows_grouped_and_sorted(
    client: TestClient, settings: Settings
) -> None:
    for category in ("img", "edit", "inpainting"):
        (settings.workflows_dir / category).mkdir()
    (settings.workflows_dir / "img" / "Zeta.json").write_text(
        json.dumps(_api_workflow(steps="{steps:8}"))
    )
    (settings.workflows_dir / "img" / "Alpha.json").write_text(
        json.dumps(_api_workflow())
    )
    (settings.workflows_dir / "edit" / "Cloud.json").write_text(
        json.dumps(_api_workflow(steps=None))
    )
    (settings.workflows_dir / "inpainting" / "Mask.json").write_text(
        json.dumps(_api_workflow())
    )

    resp = client.get("/api/workflows")
    assert resp.status_code == 200
    body = resp.json()
    assert [item["path"] for item in body] == [
        "img/Alpha.json",
        "img/Zeta.json",
        "edit/Cloud.json",
        "inpainting/Mask.json",
    ]
    assert body[0] == {
        "path": "img/Alpha.json",
        "label": "Alpha",
        "category": "img",
        "type": "standard",
        "default_steps": 4,
        "placeholders": ["input_image", "prompt", "steps"],
        "output_node": "9",
        "valid": True,
        "errors": [],
        "warnings": [],
    }
    assert body[2]["default_steps"] is None


def test_user_workflow_overrides_bundled_file(
    tmp_path: Path,
) -> None:
    bundled = tmp_path / "bundled"
    user = tmp_path / "user"
    images = tmp_path / "images"
    for root in (bundled, user):
        (root / "img").mkdir(parents=True)
    images.mkdir()
    (bundled / "img" / "Same.json").write_text(
        json.dumps(_api_workflow(steps="{steps:4}"))
    )
    (user / "img" / "Same.json").write_text(
        json.dumps(_api_workflow(steps="{steps:12}"))
    )
    settings = Settings(
        workflows_dir=bundled,
        user_workflows_dir=user,
        images_dir=images,
    )
    app = create_app(settings)
    app.dependency_overrides[get_settings] = lambda: settings

    body = TestClient(app).get("/api/workflows").json()

    assert len(body) == 1
    assert body[0]["path"] == "img/Same.json"
    assert body[0]["default_steps"] == 12
    assert resolve_workflow_path("img/Same.json", bundled, user) == (
        user / "img" / "Same.json"
    )


def test_workflow_resolution_rejects_unknown_or_nested_paths(tmp_path: Path) -> None:
    root = tmp_path / "workflows"
    (root / "img").mkdir(parents=True)
    (root / "img" / "Good.json").write_text("{}")

    assert resolve_workflow_path("../Good.json", root) is None
    assert resolve_workflow_path("default/Good.json", root) is None
    assert resolve_workflow_path("img/nested/Good.json", root) is None


def test_invalid_workflow_is_reported_not_hidden(
    client: TestClient, settings: Settings
) -> None:
    (settings.workflows_dir / "img").mkdir()
    (settings.workflows_dir / "img" / "Broken.json").write_text("{}")

    body = client.get("/api/workflows").json()

    assert body[0]["valid"] is False
    assert "Missing required {input_image} placeholder." in body[0]["errors"]
    assert "Missing a terminal SaveImage or PreviewImage node." in body[0]["errors"]


def test_list_workflows_missing_folder(tmp_path: Path) -> None:
    bad = Settings(
        workflows_dir=tmp_path / "does-not-exist",
        images_dir=tmp_path,
    )
    app = create_app(bad)
    app.dependency_overrides[get_settings] = lambda: bad
    client = TestClient(app)
    resp = client.get("/api/workflows")
    assert resp.status_code == 500


# ── Images ──────────────────────────────────────────────────────────────


def test_list_images_only_image_extensions(
    client: TestClient, settings: Settings
) -> None:
    (settings.images_dir / "a.png").write_bytes(b"x")
    (settings.images_dir / "b.JPG").write_bytes(b"x")
    (settings.images_dir / "c.txt").write_text("not an image")
    (settings.images_dir / "d.jpeg").write_bytes(b"x")

    resp = client.get("/api/images")
    assert resp.status_code == 200
    # Sorted, case-insensitive extensions accepted.
    assert resp.json() == ["a.png", "b.JPG", "d.jpeg"]


def test_upload_image_success(client: TestClient, settings: Settings) -> None:
    files = {"image": ("snap.png", io.BytesIO(b"\x89PNG\r\n"), "image/png")}
    resp = client.post("/api/upload", files=files)
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    filename = body["filename"]
    assert filename.startswith("snap_")
    assert filename.endswith(".png")
    assert (settings.images_dir / filename).exists()


def test_upload_rejects_non_image(client: TestClient) -> None:
    files = {"image": ("notes.txt", io.BytesIO(b"hello"), "text/plain")}
    resp = client.post("/api/upload", files=files)
    assert resp.status_code == 400


def test_upload_sanitizes_filename(client: TestClient, settings: Settings) -> None:
    files = {
        "image": (
            "../../etc/passwd.png",
            io.BytesIO(b"\x89PNG\r\n"),
            "image/png",
        )
    }
    resp = client.post("/api/upload", files=files)
    assert resp.status_code == 200
    filename = resp.json()["filename"]
    # No path separators, no parent traversal markers.
    assert ".." not in filename
    assert "/" not in filename
    assert "\\" not in filename
    assert (settings.images_dir / filename).exists()


# ── Static /images mount ────────────────────────────────────────────────


def test_images_static_mount(client: TestClient, settings: Settings) -> None:
    (settings.images_dir / "fixture.png").write_bytes(b"\x89PNG\r\nfoo")
    resp = client.get("/images/fixture.png")
    assert resp.status_code == 200
    assert resp.content.startswith(b"\x89PNG")
