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
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import type { PermissionRequest } from "../src/api/types.js";
import type { PermissionEntry } from "../src/run-stream/model.js";
import { reconcilePermissions } from "../src/run-stream/permission.js";

const request = (overrides: Partial<PermissionRequest>): PermissionRequest => ({
  action: "artifact_download",
  createdAt: "2026-11-07T06:46:44.346Z",
  id: "request-1",
  resource: "artifact:biorxiv:10.1101/2025.04.16.649149:v2:pdf",
  state: "pending",
  summary: "Download biorxiv-2025.04.16.649149-v2.pdf",
  ...overrides,
});

const pending: PermissionEntry[] = [{ request: request({}) }];

describe("reconciling a replayed permission request with the catalog", () => {
  it("replaces the pending snapshot a replay ended on with the decided answer", () => {
    const allowed = request({ decidedAt: "2026-11-07T06:47:00.000Z", decision: "allowed", state: "allowed" });

    const reconciled = reconcilePermissions(pending, [allowed]);

    assert.equal(reconciled[0]!.request.state, "allowed");
    assert.equal(reconciled[0]!.request.decision, "allowed");
  });

  it("leaves the replay alone when the catalog still calls the request pending", () => {
    const reconciled = reconcilePermissions(pending, [request({})]);

    assert.equal(reconciled, pending, "an unchanged list keeps its identity");
  });

  it("does not grow a card for a request this run never asked about", () => {
    const other = request({ id: "request-2", state: "denied" });

    const reconciled = reconcilePermissions(pending, [other]);

    assert.equal(reconciled, pending, "a Session-wide answer list cannot add an entry");
  });

  it("does not undo a decision the replay already carries", () => {
    const decided: PermissionEntry[] = [{
      request: request({ decidedAt: "2026-11-07T06:47:00.000Z", decision: "allowed", state: "allowed" }),
    }];

    const reconciled = reconcilePermissions(decided, [request({})]);

    assert.equal(reconciled, decided, "a pending answer never overwrites a decided one");
  });

  it("takes the later of two decided answers", () => {
    const allowed: PermissionEntry[] = [{
      request: request({ decidedAt: "2026-11-07T06:47:00.000Z", decision: "allowed", state: "allowed" }),
    }];
    const denied = request({ decidedAt: "2026-11-07T06:48:00.000Z", decision: "denied", state: "denied" });

    const reconciled = reconcilePermissions(allowed, [denied]);

    assert.equal(reconciled[0]!.request.state, "denied");
  });

  it("does nothing when either side is empty", () => {
    const empty: PermissionEntry[] = [];
    assert.equal(reconcilePermissions(empty, [request({})]), empty);
    assert.equal(reconcilePermissions(pending, []), pending);
  });
});
