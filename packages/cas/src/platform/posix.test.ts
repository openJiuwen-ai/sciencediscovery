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

test("lockFileName follows the same shortened rule as win32", () => {
  const key = "/data/projects/abc/sessions/def/workspace";
  const name = lockFileName(key);

  // Lock names are machine-local and ephemeral, but the rule must be identical
  // on every platform: 128-bit sha256 hex (炸点③-15, see win32.test.ts).
  assert.match(name, /^[0-9a-f]{32}$/);
  assert.equal(name, lockFileName(key));
  assert.notEqual(name, lockFileName("/data/projects/abc/sessions/def/other"));
});
