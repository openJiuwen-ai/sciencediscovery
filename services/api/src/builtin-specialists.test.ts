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
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { SessionStore } from "./store.js";
import { BUILTIN_SPECIALISTS, BUILTIN_SPECIALIST_IDS } from "./builtin-specialists.js";

async function withStore(
  fn: (store: SessionStore) => Promise<void>,
  suffix: string,
): Promise<void> {
  const tempRoot = resolve(process.cwd(), ".tmp", `builtin-spec-${suffix}-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  try {
    const store = new SessionStore(tempRoot);
    await store.load();
    await fn(store);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

test("SessionStore seeds all built-in specialists on first load", async () => {
  await withStore(async (store) => {
    const specialists = store.listSpecialists();
    const builtins = specialists.filter((s) => s.builtIn);
    assert.equal(builtins.length, BUILTIN_SPECIALISTS.length);
    for (const id of BUILTIN_SPECIALIST_IDS) {
      assert.ok(builtins.some((s) => s.id === id), `missing built-in ${id}`);
    }
    // Seeded without an `enabled` key => defaults to enabled.
    assert.equal(builtins.every((s) => s.enabled === undefined), true);
    for (const b of builtins) {
      assert.ok(b.description, `${b.id} must have a description`);
      assert.ok(b.instructions, `${b.id} must have instructions`);
    }
  }, "seed");
});

test("built-in specialists cannot be deleted", async () => {
  await withStore(async (store) => {
    await assert.rejects(
      store.deleteSpecialist(BUILTIN_SPECIALIST_IDS[0]!),
      /cannot be deleted/,
    );
    // Still present.
    assert.ok(store.listSpecialists().some((s) => s.id === BUILTIN_SPECIALIST_IDS[0]));
  }, "delete");
});

test("built-in specialist enabled toggle persists and survives reload", async () => {
  const tempRoot = resolve(process.cwd(), ".tmp", `builtin-spec-persist-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  try {
    const store = new SessionStore(tempRoot);
    await store.load();
    const id = BUILTIN_SPECIALIST_IDS[0]!;
    const updated = await store.updateSpecialist(id, { enabled: false });
    assert.equal(updated.enabled, false);

    // The disabled built-in is filtered out of the dispatch list.
    const dispatch = store.listSpecialists().filter((s) => s.enabled !== false);
    assert.equal(dispatch.some((s) => s.id === id), false);
    // Other built-ins remain.
    assert.equal(dispatch.length, BUILTIN_SPECIALIST_IDS.length - 1);

    // Re-open: the toggle survives, pinned fields stay authoritative.
    const reopened = new SessionStore(tempRoot);
    await reopened.load();
    const reloaded = reopened.listSpecialists().find((s) => s.id === id);
    assert.equal(reloaded?.enabled, false);
    // Pinned instructions/description still authoritative after reload.
    const pinned = BUILTIN_SPECIALISTS.find((b) => b.id === id)!;
    assert.equal(reloaded!.instructions, pinned.instructions);
    assert.equal(reloaded!.description, pinned.description);
    // Toggling back on works.
    const reEnabled = await reopened.updateSpecialist(id, { enabled: true });
    assert.equal(reEnabled.enabled, true);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("built-in specialist core fields are read-only; only enabled can change", async () => {
  await withStore(async (store) => {
    const id = BUILTIN_SPECIALIST_IDS[0]!;
    const before = store.getSpecialist(id)!;

    // Editing instructions is rejected.
    await assert.rejects(
      store.updateSpecialist(id, { instructions: "HACKED" }),
      /read-only/,
    );
    // Editing description is rejected.
    await assert.rejects(
      store.updateSpecialist(id, { description: "HACKED" }),
      /read-only/,
    );
    // Editing name is rejected.
    await assert.rejects(
      store.updateSpecialist(id, { name: "hacked" }),
      /read-only/,
    );
    // Editing connectorIds is rejected.
    await assert.rejects(
      store.updateSpecialist(id, { connectorIds: [] }),
      /read-only/,
    );
    // No mutation happened.
    const after = store.getSpecialist(id)!;
    assert.equal(after.instructions, before.instructions);
    assert.equal(after.description, before.description);
    assert.equal(after.name, before.name);
    assert.deepEqual(after.connectorIds, before.connectorIds);

    // Toggling enabled is allowed.
    const toggled = await store.updateSpecialist(id, { enabled: false });
    assert.equal(toggled.enabled, false);
  }, "readonly");
});

test("enabled defaults to enabled when the key is absent (backward compat)", async () => {
  await withStore(async (store) => {
    // A fresh store: built-ins have no `enabled` key but should dispatch.
    const id = BUILTIN_SPECIALIST_IDS[0]!;
    const specialist = store.getSpecialist(id)!;
    assert.equal(specialist.enabled, undefined);
    const dispatch = store.listSpecialists().filter((s) => s.enabled !== false);
    assert.ok(dispatch.some((s) => s.id === id), "absent enabled key should mean enabled");
  }, "compat");
});
