// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import { filterEnabledMcpSources } from "./selection.js";

test("filterEnabledMcpSources keeps web when the MCP master switch is off", () => {
  const result = filterEnabledMcpSources(["pubmed", "web"], { mcp: { enabled: false } });
  assert.deepEqual(result, ["web"]);
});

test("filterEnabledMcpSources drops non-web MCP sources when the MCP master switch is off", () => {
  const result = filterEnabledMcpSources(["pubmed", "uniprot", "web"], { mcp: { enabled: false } });
  assert.deepEqual(result, ["web"]);
});

test("filterEnabledMcpSources keeps web when no plugin overrides are set", () => {
  const result = filterEnabledMcpSources(["web"]);
  assert.deepEqual(result, ["web"]);
});

test("filterEnabledMcpSources drops web when the connector.web plugin is disabled", () => {
  const result = filterEnabledMcpSources(["web", "pubmed"], { "connector.web": { enabled: false } });
  assert.deepEqual(result, ["pubmed"]);
});

test("filterEnabledMcpSources keeps both web and MCP sources when all are enabled", () => {
  const result = filterEnabledMcpSources(["web", "pubmed"], { mcp: { enabled: true } });
  assert.deepEqual(result, ["web", "pubmed"]);
});
