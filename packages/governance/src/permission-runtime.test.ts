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

import assert from "node:assert/strict";
import test from "node:test";

import type { PermissionAuthorization, PermissionEpoch, PermissionRequest } from "@sciencediscovery/schema";

import { createAgentPermissionRuntime } from "./permission-runtime.js";

function epoch(id: string): PermissionEpoch {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    environmentRevisionId: "environment-1",
    id,
    mounts: [],
    networkPolicy: "none",
    reason: "test",
    secretRefs: [],
    sessionId: "session-1",
  };
}

function request(id: string, state: PermissionRequest["state"] = "pending"): PermissionRequest {
  return {
    action: "code",
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    resource: "workspace-code",
    sessionId: "session-1",
    state,
    summary: "Run code",
  };
}

function authorization(id: string): PermissionAuthorization {
  return {
    action: "code",
    approvalMode: "ask_for_dangerous",
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    outcome: "allowed",
    permissionEpochId: "epoch-2",
    projectId: "project-1",
    resource: "workspace-code",
    sessionId: "session-1",
    source: "user_once",
  };
}

test("governance permission runtime emits through the root sink and refreshes a shared live epoch", async () => {
  let currentEpoch = epoch("epoch-1");
  let checks = 0;
  const emitted: string[] = [];
  const allowed = authorization("authorization-1");
  const runtime = createAgentPermissionRuntime(currentEpoch, {
    emitRequired: (pending) => emitted.push(pending.id),
    readAuthorization: (id) => id === allowed.id ? allowed : undefined,
    readEpoch: () => currentEpoch,
    requestPermission: async () => {
      checks += 1;
      return { allowed: false, request: request("request-1") };
    },
    waitForDecision: async (pending) => {
      currentEpoch = epoch("epoch-2");
      return {
        ...pending,
        decisionEpochId: currentEpoch.id,
        permissionAuthorizationId: allowed.id,
        state: "allowed",
      };
    },
  });

  await runtime.requirePrivilege({
    action: "code",
    resource: "workspace-code",
    summary: "Run code",
  });

  assert.deepEqual(emitted, ["request-1"]);
  assert.equal(checks, 1);
  assert.equal(runtime.getEpoch().id, "epoch-2");
});

test("permission runtime reuses an existing grant without emitting approval UI", async () => {
  let checks = 0;
  const covered = authorization("authorization-covered");
  const runtime = createAgentPermissionRuntime(epoch("epoch-1"), {
    emitRequired: () => assert.fail("existing grants must not emit a permission card"),
    readAuthorization: () => covered,
    readEpoch: () => epoch("epoch-1"),
    requestPermission: async () => {
      checks += 1;
      return { allowed: true, authorization: covered };
    },
    waitForDecision: async () => assert.fail("existing grants must not wait"),
  });

  await runtime.requirePrivilege({
    action: "connector",
    resource: "pubmed",
    summary: "Query PubMed",
  });
  assert.equal(checks, 1);
});

test("manual permission decisions resume only their own action", async () => {
  const requests = new Map([
    ["code", request("request-code")],
    ["connector", {
      ...request("request-connector"),
      action: "connector" as const,
      resource: "arxiv:search",
      summary: "Search arXiv",
    }],
  ]);
  const decisions = new Map<string, PermissionRequest>();
  const waiters = new Map<string, (decision: PermissionRequest) => void>();
  const authorizations = new Map<string, PermissionAuthorization>();
  const emitted: string[] = [];
  const runtime = createAgentPermissionRuntime(epoch("epoch-1"), {
    emitRequired: (pending) => emitted.push(pending.id),
    readAuthorization: (id) => authorizations.get(id),
    readEpoch: () => epoch("epoch-2"),
    requestPermission: async (action) => ({ allowed: false, request: requests.get(action)! }),
    waitForDecision: (pending) => new Promise((resolve) => waiters.set(pending.id, resolve)),
  });

  let codeCompleted = false;
  let connectorCompleted = false;
  const codeRun = runtime.requirePrivilege({
    action: "code",
    resource: "workspace-code",
    summary: "Run code",
  }).then(() => {
    codeCompleted = true;
  });
  const connectorRun = runtime.requirePrivilege({
    action: "connector",
    resource: "arxiv:search",
    summary: "Search arXiv",
  }).then(() => {
    connectorCompleted = true;
  });
  await Promise.resolve();
  assert.deepEqual(emitted.toSorted(), ["request-code", "request-connector"]);

  const codeAuthorization = authorization("authorization-code");
  authorizations.set(codeAuthorization.id, codeAuthorization);
  const allowed = {
    ...requests.get("code")!,
    decisionEpochId: "epoch-2",
    permissionAuthorizationId: codeAuthorization.id,
    state: "allowed" as const,
  };
  decisions.set(allowed.id, allowed);
  waiters.get(allowed.id)!(allowed);
  await codeRun;
  assert.equal(codeCompleted, true);
  assert.equal(connectorCompleted, false, "an unrelated pending action must remain paused");

  const denied = { ...requests.get("connector")!, state: "denied" as const };
  decisions.set(denied.id, denied);
  waiters.get(denied.id)!(denied);
  await assert.rejects(connectorRun, /Permission denied: Search arXiv/);
});
