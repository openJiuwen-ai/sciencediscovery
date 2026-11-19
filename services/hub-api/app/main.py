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
from sqlalchemy import select

from .config import get_settings
from .db import Base, make_engine, make_session_factory
from .models import User
from .security import hash_password
from .storage import build_storage
from .routers import artifacts, assets, auth, files, health, reviews


def create_app(settings=None) -> FastAPI:
    settings = settings or get_settings()

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


app = create_app()
