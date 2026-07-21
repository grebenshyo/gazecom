"""FastAPI entrypoint — wires the routers, static mounts, and CORS.

In dev, the frontend runs separately under Vite (proxied to /api).
In production, ``frontend/dist`` is served from /, so the same uvicorn
process delivers both the API and the SPA.
"""

from __future__ import annotations

import logging

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from gengaze import __version__
from gengaze.config import Settings, get_settings
from gengaze.routes import config as config_route
from gengaze.routes import generate as generate_route
from gengaze.routes import images as images_route
from gengaze.routes import llm as llm_route
from gengaze.routes import workflows as workflows_route

logging.basicConfig(level=logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)


def _cors_origins(settings: Settings) -> list[str]:
    raw = settings.cors_origins.strip()
    if raw == "*":
        return ["*"]
    return [o.strip() for o in raw.split(",") if o.strip()]


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(title="gazeCOM", version=__version__)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(settings),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "version": app.version}

    # API routers
    app.include_router(config_route.router, prefix="/api")
    app.include_router(workflows_route.router, prefix="/api")
    app.include_router(images_route.router, prefix="/api")
    app.include_router(llm_route.router, prefix="/api")
    app.include_router(generate_route.router, prefix="/api")

    # Static images directory (used by the frontend <img src="/images/x.png">)
    images_dir = images_route.get_image_dir(settings)
    app.mount("/images", StaticFiles(directory=str(images_dir)), name="images")

    # Production frontend bundle, if it exists. In dev this is absent and
    # the frontend is served by Vite on a different port.
    repo_root = settings.workflows_dir.parent.resolve()
    frontend_dist = repo_root / "frontend" / "dist"
    if frontend_dist.is_dir():
        app.mount(
            "/",
            StaticFiles(directory=str(frontend_dist), html=True),
            name="frontend",
        )

    return app


app = create_app()


def run() -> None:
    settings = get_settings()
    uvicorn.run(
        "gengaze.main:app",
        host=settings.host,
        port=settings.port,
        log_level="warning",
        reload=False,
    )


if __name__ == "__main__":
    run()
