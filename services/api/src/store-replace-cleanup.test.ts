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
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";
import { basename, resolve } from "node:path";

import { SessionStore } from "./store.js";

const TEMPORARY_PREFIX = ".state-";

async function fixture(context: TestContext): Promise<{ root: string; sessionId: string; store: SessionStore }> {
  const root = resolve(process.cwd(), ".tmp", `state-replace-cleanup-${randomUUID()}`);
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.load();
  const project = await store.createProject("State replace cleanup");
  const session = await store.createSession(project.id, "Task", {}, {}, { allowUnconfiguredModel: true });
  return { root, sessionId: session.id, store };
}

/**
 * Make the atomic write fail twice: `rename` cannot publish the temporary file
 * and `rm` cannot delete it either — the Windows shape where an antivirus
 * scanner holds the freshly written file, so MoveFileEx reports EPERM and the
 * cleanup reports EPERM too. Both mocks carry a sentinel so the test can tell
 * which failure reached the caller, and both only touch the store's own
 * `.state-<pid>-<uuid>.tmp` files.
 */
function failReplaceAndCleanup(context: TestContext, cleanupFails: boolean): void {
  const hostRename = rename;
  const hostRm = rm;
  // The mock stays installed after restoreAll (the ESM binding is not re-pointed on its
  // own), so a flag hands control back to the host once this test is over.
  let active = true;
  context.mock.method(fs, "rename", async (source: string, destination: string) => {
    if (!active || !basename(source).startsWith(TEMPORARY_PREFIX)) return hostRename(source, destination);
    throw Object.assign(
      new Error(`EPERM: operation not permitted, rename '${source}' -> '${destination}' [sentinel-rename]`),
      { code: "EPERM", errno: -4048, syscall: "rename", path: source, dest: destination },
    );
  });
  context.mock.method(fs, "rm", async (path: string, options?: { force?: boolean; recursive?: boolean }) => {
    if (!active || !basename(path).startsWith(TEMPORARY_PREFIX)) return hostRm(path, options);
    if (!cleanupFails) return hostRm(path, options);
    throw Object.assign(
      new Error(`EPERM: operation not permitted, rm '${path}' [sentinel-rm]`),
      { code: "EPERM", errno: -4048, syscall: "rm", path },
    );
  });
  syncBuiltinESMExports();
  context.after(() => {
    active = false;
    context.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

function writeRun(store: SessionStore, sessionId: string): Promise<unknown> {
  return store.createSessionRun({
    sessionId,
    prompt: "Persist through a locked state file",
    settingsSnapshot: store.resolveRuntimeSettings(sessionId).effective,
  });
}

test("a failed temporary-file cleanup never masks the replace error", async (context) => {
  const { store, sessionId } = await fixture(context);
  failReplaceAndCleanup(context, true);

  await assert.rejects(writeRun(store, sessionId), (error: unknown) => {
    const surfaced = `${(error as Error | undefined)?.message ?? ""} ${(error as { cause?: Error } | undefined)?.cause?.message ?? ""}`;
    assert.doesNotMatch(surfaced, /\[sentinel-rm\]/, "the cleanup failure must not replace the replace error");
    assert.match(surfaced, /\[sentinel-rename\]/, "the caller must still see the replace that failed");
    return true;
  });
});

test("a replace that fails still removes its temporary file", async (context) => {
  const { root, store, sessionId } = await fixture(context);
  failReplaceAndCleanup(context, false);

  await assert.rejects(writeRun(store, sessionId), /sentinel-rename/);
  const directory = resolve(root, "session-runs");
  const leftovers = (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "the failed attempt leaves no temporary file behind");
});
