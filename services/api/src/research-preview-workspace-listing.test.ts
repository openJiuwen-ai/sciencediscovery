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

/**
 * The shared complete workspace listing (#1140 §7.8).
 *
 * What this pins, and only this: the five profiles of one dialog request scan the
 * workspace and reconcile the catalog once. Before the sharing each profile did it
 * for itself, and each profile scanned the session a second time to build its file
 * list, so one read-only size estimate produced five directory *writes*.
 *
 * The workspace here holds real files, not an empty one. An empty session reconciles
 * nothing, so a case built on it passes even when the sharing is dropped between
 * profiles — which is exactly what Reviewers found on an earlier head: with 50 files
 * the same assertion went red because the first profile's own reconcile moved the
 * revision the sharing was keyed on.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { SessionStore } from "./store.js";
import { createResearchSnapshots } from "./research-snapshots.js";

/** The platform ports an otherwise empty session needs: a store, and no memory graph. */
async function snapshotsFor(root: string, store: SessionStore) {
  return createResearchSnapshots({
    store,
    evolutionStore: {} as never,
    evolveCandidates: {} as never,
    memoryGraphClient: { snapshotRevision: async () => "" } as never,
    memoryGraphEnabled: () => false,
    provenanceRecorder: { cas: { stream: async function* () {}, read: async () => Buffer.alloc(0) } } as never,
  }, async () => true);
}

test("the five dialog profiles reconcile the workspace once, not once each", { timeout: 20000 }, async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "preview-listing-"));
  const store = new SessionStore(root);
  store.setAvailableSkillIds([]);
  await store.load();
  try {
    const project = await store.createProject("listing");
    const session = await store.createSession(project.id, "listing", {}, {}, { allowUnconfiguredModel: true });
    // A workspace with files is the case that matters: reconciliation only writes
    // the catalog when it has something to record, and the sharing has to survive
    // that write.
    const workspaceRoot = store.workspacePath(session.id);
    await mkdir(workspaceRoot, { recursive: true });
    for (let index = 0; index < 50; index += 1) {
      await writeFile(join(workspaceRoot, `file-${index}.txt`), `row ${index}\n`);
    }
    const snapshots = await snapshotsFor(root, store);
    const original = SessionStore.prototype.reconcileWorkspaceFiles;
    const reconciled: string[] = [];
    t.mock.method(SessionStore.prototype, "reconcileWorkspaceFiles", function (this: SessionStore, ...args: Parameters<SessionStore["reconcileWorkspaceFiles"]>) {
      reconciled.push(String(args[0]));
      return original.apply(this, args);
    });
    const previews = await snapshots.exportPreviews.defaults(project.id, session.id);
    assert.ok(previews.necessary, "the dialog got its five profiles");
    assert.deepEqual(reconciled, [session.id], "one scan and one catalog write for the whole request");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
