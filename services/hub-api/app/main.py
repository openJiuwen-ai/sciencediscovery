"""Application entry point.

Layout follows the reference marketplace: `/api/v1` prefix, one router per
resource, a settings object built from the environment. The differences are
deliberate and documented in `docs/hub-backend-design.md`: SQLite is accepted
as the development database, sessions are stateless HMAC tokens instead of a
Redis-backed store, and the asset kinds are the hub's five rather than the
marketplace's six.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import select

from .config import DEFAULT_SESSION_SECRET, get_settings
from .db import Base, make_engine, make_session_factory
from .models import User
from .security import hash_password
from .storage import build_storage
from .routers import artifacts, assets, auth, files, health, reviews


def validate_settings(settings) -> None:
    """Refuse a configuration whose tokens anyone can forge.

    The session secret signs login tokens and the development download URLs;
    empty or the committed default makes both forgeable, so this runs before
    anything is created and a server fails at startup rather than serving.
    """
    if (
        not settings.session_secret
        or settings.session_secret == DEFAULT_SESSION_SECRET
    ) and not settings.allow_dev_secret:
        raise RuntimeError(
            "set HUB_SESSION_SECRET to a random value "
            "(or HUB_ALLOW_DEV_SECRET=1 on a development machine)"
        )


def create_app(settings=None) -> FastAPI:
    settings = settings or get_settings()
    validate_settings(settings)

    engine = make_engine(settings.database_url)
    Base.metadata.create_all(engine)
    session_factory = make_session_factory(engine)
    storage = build_storage(settings)

    app = FastAPI(
        title="ScienceDiscovery Hub API",
        version="0.1.0",
        description="Accounts, uploads, versions, review and signed downloads for the asset hub.",
    )
    app.state.settings = settings
    app.state.engine = engine
    app.state.session_factory = session_factory
    app.state.storage = storage

    # Reject an oversized upload before the multipart parser spools it to a
    # temporary file. A chunked body carries no length; the in-route running
    # limit still stops it, after the spool.
    multipart_overhead = 1024 * 1024

    @app.middleware("http")
    async def reject_oversized_uploads(request, call_next):
        if request.method == "POST" and request.url.path.endswith("/versions"):
            declared = request.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > settings.max_package_bytes + multipart_overhead:
                return JSONResponse(
                    status_code=413,
                    content={"detail": f"package is larger than {settings.max_package_bytes} bytes"},
                )
        return await call_next(request)

    api = "/api/v1"
    app.include_router(health.router, prefix=api)
    app.include_router(auth.router, prefix=api)
    app.include_router(assets.router, prefix=api)
    app.include_router(artifacts.router, prefix=api)
    app.include_router(reviews.router, prefix=api)
    app.include_router(files.router, prefix=api)

    _bootstrap_admin(app, settings)
    return app


def _bootstrap_admin(app: FastAPI, settings) -> None:
    if not (settings.admin_username and settings.admin_password):
        return
    session = app.state.session_factory()
    try:
        existing = session.scalar(select(User).where(User.username == settings.admin_username))
        if existing is None:
            session.add(
                User(
                    username=settings.admin_username,
                    password_hash=hash_password(settings.admin_password),
                    display_name=settings.admin_username,
                    role="admin",
                )
            )
            session.commit()
    finally:
        session.close()


# The server entry point is the factory, not a module-level instance:
# `uvicorn app.main:create_app --factory` evaluates the configuration before it
# listens, so a refused secret stops the process instead of producing a server
# that answers 500 to everything. Tests import `create_app` and build their own.
