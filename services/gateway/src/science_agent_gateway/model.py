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

"""Product-facing chat-model construction for the Gateway."""

from __future__ import annotations

from typing import Any

from ._engine import create_reasoning_chat_model


def build_reasoning_chat_model(**kwargs: Any) -> Any:
    """Create an OpenAI-compatible model that preserves reasoning deltas."""

    return create_reasoning_chat_model(**kwargs)
