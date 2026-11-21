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

import { sessionReadOnly } from "../src/app/session-read-only.js";
import type { SessionDetail } from "../src/api/types.js";

function detail(over: Record<string, unknown> = {}): SessionDetail {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "s1",
    projectId: "inbox",
    title: "结构比对",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as unknown as SessionDetail;
}

function snapshot(over: Record<string, unknown> = {}) {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    operationId: "op1",
    packageChecksum: "sha256:abc",
    role: "imported_snapshot",
    sessionIds: ["s1"],
    state: "ready",
    ...over,
  };
}

test("a live Session takes input", () => {
  assert.equal(sessionReadOnly(undefined), undefined, "no Session open is not a read-only state");
  assert.equal(sessionReadOnly(detail()), undefined);
});

test("an archived Session is read-only, which is what opening it from a search hit gives", () => {
  // The search opens the Session; the Session's own record decides the rest, so
  // this is the rule that puts the banner up and takes the composer's input.
  assert.equal(sessionReadOnly(detail({ archivedAt: "2026-01-02T00:00:00.000Z" })), "archived");
});

test("an imported snapshot stays read-only until it is copied", () => {
  assert.equal(sessionReadOnly(detail({ researchSnapshot: snapshot() })), "evidence");
  assert.equal(sessionReadOnly(detail({ researchSnapshot: snapshot({ state: "importing" }) })), "evidence",
    "a snapshot still importing is read-only too");
  assert.equal(sessionReadOnly(detail({ researchSnapshot: snapshot({ role: "research_copy" }) })), undefined,
    "a copied Session is writable: copying is how a reader continues");
});

test("archiving wins over the snapshot, because restoring is the action offered", () => {
  const both = detail({
    archivedAt: "2026-01-02T00:00:00.000Z",
    researchSnapshot: snapshot(),
  });
  assert.equal(sessionReadOnly(both), "archived", "the sidebar offers 恢复, so the banner names archiving");
});
