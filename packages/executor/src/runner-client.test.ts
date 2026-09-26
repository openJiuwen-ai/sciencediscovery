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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { RunnerClient } from "./runner-client.js";

test("RunnerClient retains an HTTP failure status even when the Runner supplies an error message", async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "temporarily unavailable" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const port = (server.address() as AddressInfo).port;
  const client = new RunnerClient(`http://127.0.0.1:${port}`, "test-token");
  await assert.rejects(client.status(), (error: unknown) => {
    assert.equal((error as Error).message, "temporarily unavailable");
    assert.equal((error as Error & { statusCode?: number }).statusCode, 503);
    return true;
  });
});
