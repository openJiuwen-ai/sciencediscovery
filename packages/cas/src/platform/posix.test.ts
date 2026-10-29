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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos"] });
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { lockFileName, syncDirectory } from "./index.js";

test("syncDirectory fsyncs the directory handle", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "sd-cas-platform-"));
  context.after(() => rm(dir, { force: true, recursive: true }));

  await assert.doesNotReject(syncDirectory(dir));
});

test("lockFileName keeps the historical full-length name on posix", () => {
  const key = "/data/projects/abc/sessions/def/workspace";
  const name = lockFileName(key);

  // Coordination files written by main (full sha256 digest) must keep
  // working after this lands, so posix keeps the 64-hex name; only win32
  // shortens (MAX_PATH headroom, see win32.test.ts).
  assert.match(name, /^[0-9a-f]{64}$/);
  assert.notEqual(name, lockFileName("/data/projects/abc/sessions/def/other"));
});
