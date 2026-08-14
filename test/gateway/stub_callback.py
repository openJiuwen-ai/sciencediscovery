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

"""Stub of the Node tool-exec callback endpoint, for gateway M0 testing.

Mimics what services/api will expose: accept {name, args, toolCallId} and
return {content, is_error}. Here it just echoes so we can prove the gateway ->
callback -> gateway round-trip without the Node process.
"""

from __future__ import annotations

import argparse

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()


class ToolExec(BaseModel):
    name: str
    args: dict
    toolCallId: str | None = None


@app.post("/internal/tool-exec")
def tool_exec(req: ToolExec) -> dict:
    return {"content": f"[node:{req.name}] echo: {req.args.get('text', '')}", "is_error": False}


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=4399)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
