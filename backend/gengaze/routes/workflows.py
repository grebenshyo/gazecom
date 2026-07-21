"""GET /api/workflows — inspect bundled and user ComfyUI workflows."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from gengaze.config import Settings, get_settings
from gengaze.workflow_catalog import scan_workflows

router = APIRouter()


@router.get("/workflows", summary="List and validate available workflows")
async def list_workflows(settings: Settings = Depends(get_settings)) -> list[dict]:
    folder = settings.workflows_dir
    if not folder.exists():
        raise HTTPException(
            status_code=500,
            detail=f"Workflows folder missing: {folder}",
        )

    return scan_workflows(folder, settings.user_workflows_dir)
