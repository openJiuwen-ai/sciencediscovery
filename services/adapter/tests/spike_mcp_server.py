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

"""Stand-in MCP server for the JiuwenSwarm MCP spike: one `run_shell` tool that echoes.

Register with `mcp.register_custom` on the web channel (ws://<host>:<web>/ws), then pass
`"mcp": ["sci"]` in `chat.send` so the run can reach it. See README.md.
"""
from fastmcp import FastMCP
mcp = FastMCP("sci-spike")

@mcp.tool()
def run_shell(command: str) -> str:
    """Run a shell command in the session workspace."""
    return f"SPIKE-OUT: {command}"

if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="127.0.0.1", port=18998, path="/mcp")
