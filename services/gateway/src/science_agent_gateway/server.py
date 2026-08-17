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

"""ScienceDiscovery web-provider Gateway.

A thin FastAPI sidecar whose only client is the Node control API. The agent
loop, model transport, and MCP client all run natively in that Node process;
what remains here is keyed web-provider execution:

  * ``POST /internal/web/invoke`` — run one resolved provider request
  * ``GET /health``              — liveness for the start-up scripts

The same environment also supplies the interpreter for the bundled Python MCP
servers (biomed, UniProt), which Node spawns directly as stdio subprocesses.
"""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI

from .logging_config import configure_logging
from .web_api import router as web_router

logger = logging.getLogger("science_agent_gateway")

app = FastAPI(title="science-agent-gateway")
app.include_router(web_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def main() -> None:
    import uvicorn

    host = os.environ.get("SCIENCE_AGENT_GATEWAY_HOST", "127.0.0.1")
    port = int(os.environ.get("SCIENCE_AGENT_GATEWAY_PORT", "4312"))
    configure_logging()
    logger.info("event=service_started host=%s port=%s", host, port)
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
