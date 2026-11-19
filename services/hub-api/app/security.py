"""Passwords, session tokens and the request-level identity dependencies.

Passwords are hashed with scrypt from the standard library, so the service
carries no native crypto dependency. Tokens are HMAC-signed JSON: no session
table, no Redis; the database remains the only stateful dependency, which is
the whole point of this service compared with the reference stack.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time

_SCRYPT = dict(n=2**14, r=8, p=1)  # ~16 MiB, ~50 ms per hash


def hash_password(password: str) -> str:
    if len(password) < 8:
        raise ValueError("password must be at least 8 characters")
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, dklen=32, **_SCRYPT)
    return "scrypt$" + base64.urlsafe_b64encode(salt + digest).decode("ascii")


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, payload = stored.split("$", 1)
        if scheme != "scrypt":
            return False
        raw = base64.urlsafe_b64decode(payload.encode("ascii"))
    except (ValueError, TypeError):
        return False
    salt, expected = raw[:16], raw[16:]
    actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, dklen=32, **_SCRYPT)
    return hmac.compare_digest(actual, expected)


def _sign(secret: str, value: str) -> str:
    return hmac.new(secret.encode("utf-8"), value.encode("utf-8"), hashlib.sha256).hexdigest()


def issue_token(secret: str, user_id: str, ttl_seconds: int) -> str:
    body = json.dumps(
        {"sub": user_id, "exp": int(time.time()) + ttl_seconds},
        separators=(",", ":"),
    )
    encoded = base64.urlsafe_b64encode(body.encode("utf-8")).decode("ascii").rstrip("=")
    return f"{encoded}.{_sign(secret, encoded)}"


def read_token(secret: str, token: str) -> str | None:
    try:
        encoded, signature = token.split(".", 1)
    except ValueError:
        return None
    if not hmac.compare_digest(_sign(secret, encoded), signature):
        return None
    padded = encoded + "=" * (-len(encoded) % 4)
    try:
        body = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(body, dict) or body.get("exp", 0) < time.time():
        return None
    subject = body.get("sub")
    return subject if isinstance(subject, str) else None
