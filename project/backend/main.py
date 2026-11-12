from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pymongo.errors import PyMongoError

from .database import ensure_indexes, get_db
from .routes import audit, auth, catalog, customers, imports, orders, pricing, products, settings, stats


@asynccontextmanager
async def lifespan(app):
    ensure_indexes(get_db())
    yield


app = FastAPI(title="Back-office", lifespan=lifespan, docs_url=None, redoc_url=None)
for r in (auth, products, catalog, pricing, imports, orders, customers, stats, audit, settings):
    app.include_router(r.router)


@app.exception_handler(PyMongoError)
async def mongo_error(_: Request, exc: PyMongoError):
    return JSONResponse({"detail": "База даних тимчасово недоступна"}, status_code=503)


@app.get("/health")
def health():
    try:
        get_db().command("ping")
        return {"ok": True}
    except Exception:
        return JSONResponse({"ok": False}, status_code=503)


@app.get("/")
def root():
    return RedirectResponse("/admin/")


class AdminStatic(StaticFiles):
    """Статика адмінки: завжди ревалідація (модулі без хешів у назвах) і захисні заголовки."""

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-cache"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "same-origin"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; "
            "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        return resp


app.mount("/admin", AdminStatic(directory=Path(__file__).resolve().parent.parent / "frontend" / "admin", html=True))
