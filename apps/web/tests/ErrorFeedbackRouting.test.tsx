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

import {
  createSettingsErrorRouter,
  type SettingsOperationName,
} from "../src/settings-error-routing.js";

type DialogHarness = {
  dialogOpen: boolean;
  draft: { marker: string };
  globalToasts: string[];
  scopedErrors: string[];
  systemErrors: string[];
};

function createHarness(): DialogHarness {
  return {
    dialogOpen: true,
    draft: { marker: "unsaved draft" },
    globalToasts: [],
    scopedErrors: [],
    systemErrors: [],
  };
}

function replaceErrors(target: string[], message?: string): void {
  target.splice(0, target.length, ...(message ? [message] : []));
}

const systemOperations = [
  "saveGlobalSettings",
  "saveTimeoutSettings",
  "saveQuotaSettings",
  "revokePermission",
] as const satisfies readonly SettingsOperationName[];

for (const operationName of systemOperations) {
  test(`${operationName} failure stays in System settings without closing or clearing`, async () => {
    const harness = createHarness();
    const originalDraft = harness.draft;
    const router = createSettingsErrorRouter({
      scoped: (message) => replaceErrors(harness.scopedErrors, message),
      system: (message) => replaceErrors(harness.systemErrors, message),
    });
    const failure = new Error(`${operationName} failed`);

    const routed = router.run(operationName, async () => { throw failure; }, "fallback");
    if (operationName === "revokePermission") {
      assert.equal(await routed, undefined);
    } else {
      await assert.rejects(routed, failure);
    }

    assert.deepEqual(harness.systemErrors, [failure.message]);
    assert.deepEqual(harness.scopedErrors, []);
    assert.deepEqual(harness.globalToasts, []);
    assert.equal(harness.dialogOpen, true);
    assert.equal(harness.draft, originalDraft);
  });
}

const scopedOperations = [
  "loadScopedSettings",
  "saveScopedSettings",
] as const satisfies readonly SettingsOperationName[];

for (const operationName of scopedOperations) {
  test(`${operationName} failure stays in the scoped dialog without closing or clearing`, async () => {
    const harness = createHarness();
    const originalDraft = harness.draft;
    const router = createSettingsErrorRouter({
      scoped: (message) => replaceErrors(harness.scopedErrors, message),
      system: (message) => replaceErrors(harness.systemErrors, message),
    });
    const failure = new Error(`${operationName} failed`);

    assert.equal(
      await router.run(operationName, async () => { throw failure; }, "fallback"),
      undefined,
    );

    assert.deepEqual(harness.scopedErrors, [failure.message]);
    assert.deepEqual(harness.systemErrors, []);
    assert.deepEqual(harness.globalToasts, []);
    assert.equal(harness.dialogOpen, true);
    assert.equal(harness.draft, originalDraft);
  });
}
