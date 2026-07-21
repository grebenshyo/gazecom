"""Tests for comfy_client.pick_image_output_node.

Regression coverage for the bug where workflows with both a SaveImage AND a
MaskPreview+ node (e.g. inpainting/FLUX.json, all zimg inp.json
variants) returned the mask instead of the generated image because the
backend grabbed whichever ``executed`` ws event arrived first.

The fix scans the workflow dict for the terminal image-output node and
targets it explicitly. These tests pin that behaviour against representative
shapes and against the live workflow files on disk.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from gengaze.comfy_client import ComfyClient, ComfyError, pick_image_output_node
from gengaze.workflow_catalog import scan_workflows

WORKFLOWS_DIR = Path(__file__).resolve().parents[2] / "workflows"


def test_picks_save_image_when_only_one_present() -> None:
    prompt = {
        "1": {"class_type": "LoadImage"},
        "2": {"class_type": "KSampler"},
        "9": {"class_type": "SaveImage"},
    }
    assert pick_image_output_node(prompt) == "9"


def test_skips_mask_preview_in_favor_of_save_image() -> None:
    """The exact bug shape: SaveImage + MaskPreview+ both present."""
    prompt = {
        "10": {"class_type": "SaveImage"},
        "87": {"class_type": "MaskPreview+"},
    }
    assert pick_image_output_node(prompt) == "10"


def test_save_image_priority_over_preview_image() -> None:
    prompt = {
        "5": {"class_type": "PreviewImage"},
        "12": {"class_type": "SaveImage"},
    }
    assert pick_image_output_node(prompt) == "12"


def test_falls_back_to_preview_image_when_no_save_image() -> None:
    prompt = {
        "3": {"class_type": "PreviewImage"},
        "4": {"class_type": "KSampler"},
    }
    assert pick_image_output_node(prompt) == "3"


def test_picks_last_when_multiple_save_images() -> None:
    """Multiple SaveImage nodes: prefer the last in dict order (typical
    ComfyUI convention is to put the final save late in the graph)."""
    prompt = {
        "1": {"class_type": "SaveImage"},
        "2": {"class_type": "KSampler"},
        "3": {"class_type": "SaveImage"},
    }
    assert pick_image_output_node(prompt) == "3"


def test_returns_none_when_no_recognized_output() -> None:
    prompt = {
        "1": {"class_type": "LoadImage"},
        "2": {"class_type": "KSampler"},
    }
    assert pick_image_output_node(prompt) is None


def test_tolerates_non_dict_values() -> None:
    prompt = {
        "1": {"class_type": "SaveImage"},
        "_meta": "not a node",  # ComfyUI sometimes adds extra keys
    }
    assert pick_image_output_node(prompt) == "1"


# ── Integration: real workflow files on disk ────────────────────────────


@pytest.mark.skipif(
    not WORKFLOWS_DIR.is_dir(), reason="workflows/ tree not present in this checkout"
)
@pytest.mark.parametrize(
    "wf_path",
    sorted(WORKFLOWS_DIR.glob("*/*.json")),
    ids=lambda path: str(path.relative_to(WORKFLOWS_DIR)),
)
def test_resolves_terminal_output_in_real_workflows(wf_path: Path) -> None:
    """Every shipping image-generation workflow must resolve to a recognized
    terminal output node (`SaveImage` or `PreviewImage`) — never a
    `MaskPreview+` or other intermediate. Both classes are accepted because
    workflows can pick either: SaveImage persists to ComfyUI's output/
    folder, PreviewImage to its auto-cleaning temp/ folder; the choice
    doesn't affect what the backend fetches via /view."""
    with wf_path.open(encoding="utf-8") as fh:
        wf = json.load(fh)
    relpath = wf_path.relative_to(WORKFLOWS_DIR)
    node_id = pick_image_output_node(wf)
    assert node_id is not None, f"{relpath}: no output node found"
    cls = wf[node_id]["class_type"]
    assert cls in {"SaveImage", "PreviewImage"}, (
        f"{relpath}: expected SaveImage or PreviewImage, got {cls} (node {node_id})"
    )


def test_shipping_workflows_pass_catalog_validation() -> None:
    descriptors = scan_workflows(WORKFLOWS_DIR)

    assert descriptors
    assert all(item["valid"] for item in descriptors), [
        (item["path"], item["errors"])
        for item in descriptors
        if not item["valid"]
    ]


# ── upload_image (POST /upload/image) ───────────────────────────────────


async def test_upload_image_returns_stored_name(httpx_mock) -> None:
    """Happy path: returns ComfyUI's stored name for the LoadImage node."""
    httpx_mock.add_response(
        method="POST",
        url="http://host:8188/upload/image",
        json={"name": "gengaze_input.png", "subfolder": "", "type": "input"},
    )
    name = await ComfyClient("host:8188").upload_image(b"\x89PNG", "gengaze_input.png")
    assert name == "gengaze_input.png"


async def test_upload_image_prefixes_subfolder(httpx_mock) -> None:
    """A non-empty subfolder is prefixed, as LoadImage expects."""
    httpx_mock.add_response(
        method="POST",
        url="http://host:8188/upload/image",
        json={"name": "x.png", "subfolder": "sub", "type": "input"},
    )
    name = await ComfyClient("host:8188").upload_image(b"x", "x.png")
    assert name == "sub/x.png"


async def test_upload_image_raises_on_http_error(httpx_mock) -> None:
    httpx_mock.add_response(
        method="POST",
        url="http://host:8188/upload/image",
        status_code=400,
        text="bad request",
    )
    with pytest.raises(ComfyError):
        await ComfyClient("host:8188").upload_image(b"x", "x.png")
