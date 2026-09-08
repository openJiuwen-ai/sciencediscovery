// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Refuse discovery when the synthetic credential was lost during UI editing.
if ((process.env.MCP_TEST_SECRET ?? process.env.MCP_TEST_RENAMED) !== "Bearer fixture-only") {
  throw new Error("Required synthetic MCP credential missing or invalid");
}
await import("./mcp-echo.mjs");
