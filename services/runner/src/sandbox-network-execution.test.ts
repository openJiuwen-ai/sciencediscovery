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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "sandbox:bubblewrap"] });
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_SANDBOX_NETWORK_ACCESS, type PermissionEpoch } from "@sciencediscovery/schema";
import { executeShell, executePython } from "./executor.js";
import { EgressGatewayRegistry } from "./egress-gateway.js";

for (const language of ["python", "shell"] as const) test(`${language} execution attributes denied hosts even when script catches the error and releases its gateway`, async t => {
  const root = await mkdtemp(join(tmpdir(), "net-exec-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "projects", "session"); await mkdir(workspaceRoot, { recursive: true });
  let dnsCalls = 0;
  const registry = new EgressGatewayRegistry(root, undefined, async () => { dnsCalls++; throw new Error("Denied target must not resolve"); });
  t.after(() => registry.close());
  const access = { ...NO_SANDBOX_NETWORK_ACCESS, mode: "domain-allowlist" as const, allowedDomains: ["configured.example.org"], revision: "configured" };
  const permissionEpoch: PermissionEpoch = { id: "epoch", sessionId: "session", environmentRevisionId: "system", createdAt: "now", reason: "test",
    mounts: [{ source: "workspace", mode: "read-write" }], secretRefs: [], networkPolicy: access.mode, networkAccess: access };
  const python = 'import urllib.request\ntry:\n urllib.request.urlopen("https://pypi.org", timeout=1)\nexcept Exception:\n print("caught; partial result only")\n';
  const request = { executionId: `denial-${language}`, agentId: "main", code: language === "python" ? python : `python3 - <<'PY'\n${python}PY`, permissionEpoch, workspaceRoot };
  const config = { dataDir: root, bwrapPath: "/usr/bin/bwrap", pythonPath: "/usr/bin/python3", execTimeoutMs: 5000, maxWorkspaceBytes: 0, maxOutputBytes: 10000 };
  const result = language === "python" ? await executePython(config, request, undefined, undefined, undefined, registry)
    : await executeShell(config, request, undefined, undefined, registry);
  assert.equal(result.exitCode, 0); assert.match(result.stdout, /partial result only/);
  assert.deepEqual(result.networkDeniedHosts, ["pypi.org:443"]); assert.equal(dnsCalls, 0);
  assert.equal(result.networkAccessRevision, "configured");
  assert.deepEqual(await readdir(join(root, "eg")), [], "execution-specific socket is released at completion");
  await assert.rejects(language === "python" ? executePython(config, request) : executeShell(config, request), /without an egress gateway registry/);
});

for (const language of ["python", "shell"] as const) test(`${language} default none execution creates no gateway or proxy environment`, async t => {
  const root = await mkdtemp(join(tmpdir(), "offline-exec-")); t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "projects", "session"); await mkdir(workspaceRoot, { recursive: true });
  const permissionEpoch = { id: "epoch", sessionId: "s", createdAt: "now", environmentRevisionId: "system", reason: "offline", secretRefs: [],
    mounts: [{ source: "workspace", mode: "read-write" }], networkPolicy: "none", networkAccess: NO_SANDBOX_NETWORK_ACCESS } as PermissionEpoch;
  const config = { dataDir: root, bwrapPath: "/usr/bin/bwrap", pythonPath: "/usr/bin/python3", execTimeoutMs: 5000, maxWorkspaceBytes: 0, maxOutputBytes: 10000 };
  const request = { executionId: language, agentId: "main", code: language === "python" ? 'print("offline")' : "printf offline", permissionEpoch, workspaceRoot };
  const result = language === "python" ? await executePython(config, request) : await executeShell(config, request);
  assert.equal(result.exitCode, 0); assert.match(result.stdout, /offline/);
  assert.equal(result.networkPolicy, "none"); assert.equal(result.networkDeniedHosts, undefined);
  assert.equal(result.environmentVariables.HTTP_PROXY, undefined);
  await assert.rejects(readdir(join(root, "eg")), /ENOENT/);
});
