"""Image listing and upload endpoints, plus a static mount for /images/*."""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from gengaze.config import Settings, get_settings

log = logging.getLogger(__name__)

router = APIRouter()

ALLOWED_EXTS = {".jpg", ".jpeg", ".png"}


@router.get("/images", summary="List available reference images")
async def list_images(settings: Settings = Depends(get_settings)) -> list[str]:
    folder = settings.images_dir
    if not folder.exists():
        return []

    return sorted(
        f.name
        for f in folder.iterdir()
        if f.is_file() and f.suffix.lower() in ALLOWED_EXTS
    )


@router.post("/upload", summary="Upload a new image")
async def upload_image(
    image: UploadFile = File(...),
    settings: Settings = Depends(get_settings),
) -> dict[str, str | bool]:
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(400, "Invalid file type. Please upload an image.")

    src_ext = Path(image.filename or "").suffix.lower()
    if src_ext not in ALLOWED_EXTS:
        src_ext = ".png"

    src_stem = Path(image.filename or "uploaded").stem
    safe_stem = "".join(c for c in src_stem if c.isalnum() or c in "-_") or "uploaded"
    filename = f"{safe_stem}_{uuid.uuid4().hex[:8]}{src_ext}"

    settings.images_dir.mkdir(parents=True, exist_ok=True)
    dst = settings.images_dir / filename
    with dst.open("wb") as fh:
        fh.write(await image.read())

    log.info("Uploaded image: %s", filename)
    return {"success": True, "filename": filename}


def get_image_dir(settings: Settings) -> Path:
    """Helper for main.py to mount /images as a StaticFiles route."""
    settings.images_dir.mkdir(parents=True, exist_ok=True)
    return settings.images_dir


# Re-export for tests / main
__all__ = ["ALLOWED_EXTS", "get_image_dir", "router"]
