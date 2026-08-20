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

"""Model compatibility supplied by the bundled orchestration engine."""

from __future__ import annotations

from typing import Any

from deerflow.models.patched_openai import PatchedChatOpenAI


class _ReasoningChatOpenAI(PatchedChatOpenAI):
    def _convert_chunk_to_generation_chunk(
        self,
        chunk: dict,
        default_chunk_class: type,
        base_generation_info: dict | None,
    ) -> Any:
        generation = super()._convert_chunk_to_generation_chunk(
            chunk,
            default_chunk_class,
            base_generation_info,
        )
        if generation is not None:
            choices = chunk.get("choices") or []
            delta = (choices[0].get("delta") or {}) if choices else {}
            reasoning = delta.get("reasoning_content")
            if reasoning:
                generation.message.additional_kwargs["reasoning_content"] = reasoning
        return generation


def create_reasoning_chat_model(**kwargs: Any) -> Any:
    """Create the OpenAI-compatible model with reasoning delta preservation."""

    return _ReasoningChatOpenAI(**kwargs)
