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
import { basename, dirname, resolve } from "node:path";

import { SessionStore } from "./store.js";

/** The temporary name `writeArrayFile` gives the file it is about to publish. */
const TEMPORARY_PREFIX = ".state-";

async function fixture(context: TestContext): Promise<{
  messagesDir: string;
  sessionId: string;
  store: SessionStore;
}> {
  const root = resolve(process.cwd(), ".tmp", `store-cleanup-${randomUUID()}`);
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.load();
  const project = await store.createProject("Cleanup mask");
  const session = await store.createSession(project.id, "One", {}, {}, { allowUnconfiguredModel: true });
  return { messagesDir: dirname(resolve(root, "messages", `${session.id}.json`)), sessionId: session.id, store };
}

/**
 * The shape a Windows scanner creates: it holds the freshly written temporary
 * file, so the rename that publishes it is refused and so is the cleanup that
 * deletes it. Both stand-ins carry a sentinel and only touch the store's own
 * `.state-….tmp` names, so the fixture teardown and every other call stay real.
 */
function failReplaceAndCleanup(context: TestContext, cleanupFails: boolean): void {
  const hostRename = rename;
  const hostRm = rm;
  // `mock.restoreAll()` does not re-point the ESM binding on its own, so a flag
  // hands control back to the host implementation once this test is over.
  let active = true;
  context.mock.method(fs, "rename", async (source: string, destination: string) => {
    if (!active || !basename(source).startsWith(TEMPORARY_PREFIX)) return hostRename(source, destination);
    throw Object.assign(
      new Error(`EPERM: operation not permitted, rename '${source}' -> '${destination}' [sentinel-rename]`),
      { code: "EPERM", dest: destination, errno: -4048, path: source, syscall: "rename" },
    );
  });
  context.mock.method(fs, "rm", async (path: string, options?: { force?: boolean; recursive?: boolean }) => {
    if (!active || !basename(path).startsWith(TEMPORARY_PREFIX) || !cleanupFails) return hostRm(path, options);
    throw Object.assign(
      new Error(`EPERM: operation not permitted, rm '${path}' [sentinel-rm]`),
      { code: "EPERM", errno: -4048, path, syscall: "rm" },
    );
  });
  syncBuiltinESMExports();
  context.after(() => {
    active = false;
    context.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test("a refused cleanup does not replace the failure that stopped the write", async (context) => {
  const { sessionId, store } = await fixture(context);
  failReplaceAndCleanup(context, true);
  // A scanner that holds the file refuses both steps. What the caller needs is the
  // step that kept the record from being written: a bare EPERM from deleting the
  // temporary file reports the symptom instead of the cause, and carries neither
  // the errno nor the syscall that tell a locked file from a read-only volume.
  await assert.rejects(store.appendMessage(sessionId, "user", "hello"), (error: unknown) => {
    const refused = error as NodeJS.ErrnoException;
    assert.equal(refused.code, "EPERM");
    assert.equal(refused.syscall, "rename", "the caller must still see the replace that failed");
    assert.match(refused.message, /\[sentinel-rename\]/);
    return true;
  });
});

test("a write that fails still removes its temporary file", async (context) => {
  const { messagesDir, sessionId, store } = await fixture(context);
  failReplaceAndCleanup(context, false);
  await assert.rejects(store.appendMessage(sessionId, "user", "hello"), /\[sentinel-rename\]/);
  const leftovers = (await readdir(messagesDir))
    .filter((name) => name.startsWith(TEMPORARY_PREFIX) && name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "the failed attempt leaves no temporary file behind");
});
