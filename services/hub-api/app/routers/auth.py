from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..deps import get_db, get_settings, require_admin, require_user
from ..models import User
from ..schemas import LoginRequest, RegisterRequest
from ..security import hash_password, issue_token, verify_password
from ..serializers import ok, user_payload

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register")
def register(
    body: RegisterRequest,
    db: Session = Depends(get_db),
    settings=Depends(get_settings),
) -> dict:
    # Open registration is off by default. The first account may always be
    # created, which is how a fresh deployment gets its first administrator.
    user_count = db.scalar(select(func.count()).select_from(User)) or 0
    if user_count and not settings.allow_registration:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="registration is closed; ask an administrator for an account",
        )
    exists = db.scalar(select(User).where(User.username == body.username))
    if exists is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="username taken")
    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        display_name=body.display_name or body.username,
        role="admin" if user_count == 0 else "user",
    )
    db.add(user)
    db.flush()
    token = issue_token(settings.session_secret, user.id, settings.session_ttl_seconds)
    return ok({"token": token, "user": user_payload(user)})


@router.post("/login")
def login(
    body: LoginRequest,
    db: Session = Depends(get_db),
    settings=Depends(get_settings),
) -> dict:
    user = db.scalar(select(User).where(User.username == body.username))
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials"
        )
    token = issue_token(settings.session_secret, user.id, settings.session_ttl_seconds)
    return ok({"token": token, "user": user_payload(user)})


@router.get("/me")
def me(user: User = Depends(require_user)) -> dict:
    return ok(user_payload(user))


@router.post("/users")
def create_user(
    body: RegisterRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """Administrator-created account, used while registration is closed."""
    exists = db.scalar(select(User).where(User.username == body.username))
    if exists is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="username taken")
    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        display_name=body.display_name or body.username,
        role="user",
    )
    db.add(user)
    db.flush()
    return ok(user_payload(user))
