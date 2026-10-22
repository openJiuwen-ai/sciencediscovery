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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:windows"] });
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { lockFileName, syncDirectory } from "./index.js";

test("syncDirectory is a safe no-op instead of an EPERM crash", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "sd-cas-platform-"));
  context.after(() => rm(dir, { force: true, recursive: true }));

  // 炸点③-14: fsync on a directory handle is EPERM on Windows; the
  // adaptation must resolve cleanly instead.
  await assert.doesNotReject(syncDirectory(dir));
});

test("lockFileName keeps the SQLite journal path under MAX_PATH", () => {
  const key = "E:\\deep\\projects\\abc\\sessions\\def\\workspace";
  const name = lockFileName(key);

  // 炸点③-15: a 64-hex digest overruns MAX_PATH (260) once SQLite appends
  // "-journal" under deep dataDir layouts, failing BEGIN IMMEDIATE with
  // SQLITE_CANTOPEN. 128 bits stays collision-safe for local lock names.
  assert.match(name, /^[0-9a-f]{32}$/);
  assert.equal(name, lockFileName(key));
  assert.notEqual(name, lockFileName("E:\\deep\\projects\\abc\\sessions\\def\\other"));
});
