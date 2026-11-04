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
import { randomUUID } from "node:crypto";
import fs, { readdir, rename, rm } from "node:fs/promises";
import type { TestContext } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";

import { SessionStore } from "./store.js";

async function fixture(context: TestContext): Promise<{ root: string; sessionId: string; store: SessionStore }> {
  const root = resolve(process.cwd(), ".tmp", `state-replace-${randomUUID()}`);
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.load();
  const project = await store.createProject("State replace");
  const session = await store.createSession(project.id, "Task", {}, {}, { allowUnconfiguredModel: true });
  return { root, sessionId: session.id, store };
}

/**
 * Inject a replace failure on this host. On native Windows an antivirus
 * scanner or search indexer can hold the freshly written temporary file, so
 * MoveFileEx reports EPERM for a few milliseconds; the same errno is injected
 * here because CI runs Linux and the retry must not depend on a Windows box.
 */
function failReplaces(context: TestContext, failures: number, code = "EPERM"): () => number {
  const hostRename = rename;
  let attempts = 0;
  context.mock.method(fs, "rename", async (source: string, destination: string) => {
    attempts += 1;
    if (attempts <= failures) {
      throw Object.assign(
        new Error(`${code}: operation not permitted, rename '${source}' -> '${destination}'`),
        { code, errno: -4048, syscall: "rename", path: source, dest: destination },
      );
    }
    return hostRename(source, destination);
  });
  // `platform/os/replace.ts` imports `rename` as a *named* binding from
  // "node:fs/promises", and a named import is bound when the module is
  // evaluated. Mocking the `fs` namespace alone therefore never reaches it —
  // this call re-syncs the builtin ESM named exports from the mocked namespace
  // object. The test would still pass without it (the mock would simply be
  // invisible and no failure would be injected), so the line is load-bearing
  // evidence, not cleanup: keep it next to the mock it enables.
  syncBuiltinESMExports();
  context.after(() => context.mock.restoreAll());
  return () => attempts;
}

test("a temporary replace failure retries the state write instead of escaping", async (context) => {
  const { root, sessionId, store } = await fixture(context);
  const attempts = failReplaces(context, 2);

  const run = await store.createSessionRun({
    sessionId,
    prompt: "Persist through a locked state file",
    settingsSnapshot: store.resolveRuntimeSettings(sessionId).effective,
  });

  assert.ok(attempts() >= 3, `the replacement must be retried past a transient EPERM, got ${attempts()} attempt(s)`);
  const runs = await store.listSessionRuns(sessionId);
  assert.equal(runs.length, 1, "the run state is written once the lock clears");
  assert.equal(runs[0]?.id, run.id);
  const leftovers = (await readdir(resolve(root, "session-runs"))).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "a retried replacement leaves no temporary file behind");
});
