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

import { APPROVAL_MODE_STORAGE_KEY, type ReadableStorage } from "../src/state/storage.js";
import {
  inheritForSession,
  inheritedApprovalMode,
  newSessionRequest,
  rememberApprovalMode,
} from "../src/app/approval-mode-preference.js";

/** The storage shape the shell provides, with nothing else attached. */
function fakeStorage(seed?: string): ReadableStorage {
  const values = new Map<string, string>();
  if (seed !== undefined) values.set(APPROVAL_MODE_STORAGE_KEY, seed);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("a new conversation is created in the mode remembered from the last run", () => {
  const storage = fakeStorage();
  assert.deepEqual(newSessionRequest(undefined, storage), {},
    "with nothing stored the service default applies");
  rememberApprovalMode("always_allow", storage);
  // A fresh call is what a restart looks like: this module keeps no state of its own.
  assert.equal(inheritedApprovalMode(storage), "always_allow");
  assert.deepEqual(newSessionRequest("model-2", storage),
    { modelId: "model-2", approvalMode: "always_allow" });
  rememberApprovalMode("ask_for_dangerous", storage);
  assert.deepEqual(newSessionRequest(undefined, storage), { approvalMode: "ask_for_dangerous" },
    "the later choice wins");
});

test("a stored value that is not a mode is ignored", () => {
  assert.equal(inheritedApprovalMode(fakeStorage("never_ask")), undefined);
  assert.equal(inheritedApprovalMode(fakeStorage("")), undefined);
  assert.deepEqual(newSessionRequest(undefined, fakeStorage("garbage")), {});
});

test("a conversation created by another path gets the remembered mode", async () => {
  const calls: Array<{ id: string; body: unknown }> = [];
  const storage = fakeStorage();
  const update = async (id: string, body: { approvalMode: string }) => { calls.push({ id, body }); };
  assert.equal(await inheritForSession("s1", update, storage), false, "nothing remembered: no request");
  assert.deepEqual(calls, []);
  rememberApprovalMode("always_allow", storage);
  assert.equal(await inheritForSession("s1", update, storage), true);
  assert.deepEqual(calls, [{ id: "s1", body: { approvalMode: "always_allow" } }]);
});
