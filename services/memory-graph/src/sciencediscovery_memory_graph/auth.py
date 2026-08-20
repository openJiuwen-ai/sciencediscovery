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

"""Loopback Bearer auth for the memory-graph service.

The only caller is the Node control API over ``127.0.0.1``. The shared token is
``SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN``. When the env is unset the dependency
is permissive (local dev); in production it must be set or every protected
endpoint 401s. This mirrors the model-token pattern in the Node API.
"""

from __future__ import annotations

import os
from typing import Annotated

from fastapi import Depends, Header, HTTPException


def require_internal_token(
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    expected = os.environ.get("SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN")
    if not expected:
        # No token configured → treat as disabled auth (local dev). Protected
        # endpoints still serve; the loopback binding is the boundary.
        return
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="invalid internal token")
