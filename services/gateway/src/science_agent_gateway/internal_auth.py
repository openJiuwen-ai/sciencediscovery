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

"""Bearer check shared by the Gateway's loopback-only internal routes."""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException

from .bootstrap_tokens import resolve_internal_token


def require_internal_token(authorization: str | None = Header(default=None)) -> None:
    """Reject any caller that is not the local control plane."""
    expected = f"Bearer {resolve_internal_token()}"
    if authorization is None or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Invalid gateway internal token")
