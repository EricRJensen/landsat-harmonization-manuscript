"""Deliver the Explorer with compressed responses and versioned asset caching."""

from pathlib import Path
import re

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


class VersionedStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        # Vite includes an eight-character content hash in built asset names.
        # Never make unversioned files or missing-asset responses immutable.
        if response.status_code in (200, 304) and re.search(
            r"-[A-Za-z0-9_-]{8}\.[A-Za-z0-9.]+$", Path(path).name
        ):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


def mount_frontend(api: FastAPI, directory: Path, app_name: str) -> None:
    api.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=5)

    def html_response() -> FileResponse:
        # Revalidate HTML so it always points to the current content-hashed files.
        return FileResponse(directory / "index.html", headers={"Cache-Control": "no-cache"})

    @api.get("/")
    def root():
        if (directory / "index.html").is_file():
            return html_response()
        return {"name": app_name, "docs": "/docs", "frontend": "Run npm run dev in app/frontend"}

    if not directory.is_dir():
        return

    assets = directory / "assets"
    if assets.is_dir():
        api.mount("/assets", VersionedStaticFiles(directory=assets), name="frontend-assets")

    @api.get("/{path:path}")
    def frontend_fallback(path: str) -> FileResponse:
        candidate = directory / path
        if candidate.is_file():
            return FileResponse(candidate, headers={"Cache-Control": "no-cache"})
        return html_response()
