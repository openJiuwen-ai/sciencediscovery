# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Bootstrap credentials shared with the Node control plane.

The product ships with no fixed default token. When the operator does not set
``SCIENCE_AGENT_GATEWAY_INTERNAL_TOKEN``, the value is generated once from a
CSPRNG and stored under ``<data dir>/secrets/``, so a restart keeps working and
both services agree without any orchestration.

This mirrors ``services/api/src/http/bootstrap-tokens.ts`` exactly: same
directory, same file names, one token per file so creation is a single atomic
``O_CREAT|O_EXCL`` call. Whichever service starts first creates the file; the
other one reads that value back instead of generating a second token.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path
from typing import Mapping

SECRETS_DIRECTORY = "secrets"
AUTH_TOKEN_FILE = "auth-token"
GATEWAY_INTERNAL_TOKEN_FILE = "gateway-internal-token"

# 32 random bytes, URL-safe: matches the Node side's randomBytes(32).base64url.
_TOKEN_BYTES = 32


def bootstrap_token_path(data_dir: Path, file_name: str) -> Path:
    return data_dir / SECRETS_DIRECTORY / file_name


def _read_stored_token(path: Path) -> str | None:
    try:
        token = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    return token or None


def load_or_create_token(path: Path) -> str:
    """Return the persisted token, generating and storing one when absent."""
    stored = _read_stored_token(path)
    if stored:
        return stored

    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    token = secrets.token_urlsafe(_TOKEN_BYTES)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        # The control plane created it first; its value is authoritative.
        winner = _read_stored_token(path)
        if winner:
            return winner
        # Present but blank: replace it rather than authenticate with "".
        path.write_text(f"{token}\n", encoding="utf-8")
        path.chmod(0o600)
        return token
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(f"{token}\n")
    return token


def resolve_bootstrap_token(
    file_name: str,
    variable: str,
    env: Mapping[str, str] | None = None,
) -> str:
    """Explicit environment value first, then the stored one, then a new one."""
    values = os.environ if env is None else env
    configured = values.get(variable, "").strip()
    if configured:
        return configured
    data_dir = Path(values.get("SCIENCE_AGENT_DATA_DIR", "").strip() or "data")
    return load_or_create_token(bootstrap_token_path(data_dir, file_name))


def resolve_internal_token(env: Mapping[str, str] | None = None) -> str:
    return resolve_bootstrap_token(
        GATEWAY_INTERNAL_TOKEN_FILE,
        "SCIENCE_AGENT_GATEWAY_INTERNAL_TOKEN",
        env,
    )
