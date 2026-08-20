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

"""Execute one Gateway web provider with a process-isolated proxy environment."""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from ._engine import invoke_serialized_web_provider


async def _run(payload: dict[str, Any]) -> str:
    return await invoke_serialized_web_provider(payload)


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        content = asyncio.run(_run(payload))
        json.dump({"content": content}, sys.stdout, ensure_ascii=False)
    except Exception as exc:
        json.dump({"error": f"{type(exc).__name__}: {exc}"[:1_000]}, sys.stdout, ensure_ascii=False)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
