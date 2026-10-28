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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { diagnosticIds, diagnosticLogLine, errorDiagnosticSnapshot } from "./error-diagnostics.js";
import { createApiServer, closeApiServer, loadServerConfig } from "./index.js";

const prefix = "2026-10-25T10:00:00.000Z ERROR [api] ";

test("correlation uses exact structured values and the most specific ID", () => {
  assert.equal(diagnosticLogLine(prefix + "event=failed requestId=req-other sessionId=s1", { requestId: "req-1", sessionId: "s1" }), undefined);
  assert.equal(diagnosticLogLine(prefix + 'event=failed requestId=req-10', { requestId: "req-1" }), undefined);
  assert.equal(diagnosticLogLine(prefix + 'event=failed prompt="requestId=req-1"', { requestId: "req-1" }), undefined);
  const safe = diagnosticLogLine(prefix + 'event=failed requestId="req-1" prompt="research text" errorMessage="private error" stdout="private output" apiKey=secret statusCode=500', { requestId: "req-1" });
  assert.ok(safe);
  assert.match(safe, /requestId=req-1/);
  assert.doesNotMatch(safe, /research|private|secret|stdout|errorMessage/);
  assert.equal(diagnosticIds(new URLSearchParams("runId=../../api.log")), undefined);
});

test("snapshot reads bounded tails and returns at most five correlated metadata lines", async context => {
  const root = resolve(process.cwd(), ".tmp"); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(resolve(root, "diagnostic-tail-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const path = resolve(dir, "run.log");
  const matching = Array.from({ length: 9 }, (_, i) => `${prefix}event=failed runId=r1 durationMs=${i} prompt="private"`).join("\n");
  await writeFile(path, `${prefix}event=old runId=r1\n${"x".repeat(70_000)}\n${matching}\n`);
  const snapshot = await errorDiagnosticSnapshot([path, resolve(dir, "missing.log")], { runId: "r1" });
  assert.equal(snapshot.logStatus, "available"); assert.equal(snapshot.logs.length, 5);
  assert.match(snapshot.logs[0]!, /durationMs=4/);
  assert.doesNotMatch(snapshot.logs.join("\n"), /private|event=old/);
  assert.deepEqual(await errorDiagnosticSnapshot([path], {}), { logs: [], logStatus: "unavailable" });
});

test("snapshot API requires authentication and correlates real HTTP failure IDs", async context => {
  const root = resolve(process.cwd(), ".tmp"); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(resolve(root, "diagnostic-http-"));
  const config = loadServerConfig({ SCIENCE_AGENT_DATA_DIR: dir, SCIENCE_AGENT_AUTH_TOKEN: "test-local-credential", SCIENCE_AGENT_RUNNER_TOKEN: "test-runner-credential", SCIENCE_AGENT_RUNNER_URL: "http://127.0.0.1:1", SCIENCE_AGENT_PORT: "0", SCIENCE_AGENT_MODEL_CATALOG_URL: "" });
  const server = createApiServer(config);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  context.after(async () => { await closeApiServer(server); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: "Bearer test-local-credential" };
  assert.equal((await fetch(`${origin}/api/error-diagnostics`)).status, 401);
  assert.equal((await fetch(`${origin}/api/error-diagnostics?runId=..%2Fapi.log`, { headers })).status, 400);
  const failure = await fetch(`${origin}/api/does-not-exist`, { headers });
  const requestId = failure.headers.get("x-request-id"); assert.ok(requestId);
  const response = await fetch(`${origin}/api/error-diagnostics?requestId=${requestId}`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const snapshot = await response.json() as { logs: string[] };
  assert.match(snapshot.logs.join("\n"), /event=http_request_failed/);
  assert.match(snapshot.logs.join("\n"), new RegExp(`requestId=${requestId}`));
  assert.doesNotMatch(JSON.stringify(snapshot), /test-local-credential|does-not-exist/);
});
