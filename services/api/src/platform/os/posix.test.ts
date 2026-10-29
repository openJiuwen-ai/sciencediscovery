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

import { createTest } from "../../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos"] });
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { restrictToOwner, restrictToOwnerSync } from "./index.js";

test("a file is chmodded to 0600", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "sd-platform-os-"));
  context.after(() => rm(dir, { force: true, recursive: true }));
  const file = join(dir, "token.txt");
  await writeFile(file, "secret");

  restrictToOwnerSync(file);

  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("a directory is chmodded to 0700", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "sd-platform-os-"));
  context.after(() => rm(dir, { force: true, recursive: true }));
  const secrets = join(dir, "secrets");
  await mkdir(secrets);

  await restrictToOwner(secrets, { directory: true });

  assert.equal((await stat(secrets)).mode & 0o777, 0o700);
});
