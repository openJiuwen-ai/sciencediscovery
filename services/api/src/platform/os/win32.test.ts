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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:windows"] });
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { renameReplace, restrictToOwner, restrictToOwnerSync } from "./index.js";
import { currentUserPrincipal } from "./win32.js";

function icaclsReport(path: string): string {
  const result = spawnSync("icacls", [path], { encoding: "utf8" });
  assert.equal(result.status, 0, `icacls read-back failed: ${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

async function fixture(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sd-platform-os-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

test("a file ends up with an ACL granting only the current user", async (context) => {
  const dir = await fixture(context);
  const file = join(dir, "token.txt");
  await writeFile(file, "secret");

  restrictToOwnerSync(file);

  const report = icaclsReport(file);
  const principal = currentUserPrincipal();
  assert.ok(report.includes(`${principal}:F`) || report.includes(`${principal}:(F)`), report);
  // Built-in groups must not survive: that would be the Windows equivalent of world-readable.
  assert.ok(!/BUILTIN\\Users|Everyone|Authenticated Users/i.test(report), report);
});

test("the async form restricts a file identically", async (context) => {
  const dir = await fixture(context);
  const file = join(dir, "oauth.json");
  await writeFile(file, "{}");

  await restrictToOwner(file);

  const report = icaclsReport(file);
  assert.ok(!/BUILTIN\\Users|Everyone|Authenticated Users/i.test(report), report);
});

test("a directory is restricted with inheritance for future children", async (context) => {
  const dir = await fixture(context);
  const secrets = join(dir, "secrets");
  await mkdir(secrets);

  await restrictToOwner(secrets, { directory: true });

  const report = icaclsReport(secrets);
  assert.ok(report.includes("(OI)(CI)(F)") || report.includes("(OI)(CI)F"), report);
  assert.ok(!/BUILTIN\\Users|Everyone|Authenticated Users/i.test(report), report);
});

test("renameReplace overwrites an existing destination", async (context) => {
  const dir = await fixture(context);
  const target = join(dir, "state.json");
  const staging = join(dir, ".state.tmp");
  await writeFile(target, "old");
  await writeFile(staging, "new");

  await renameReplace(staging, target);

  assert.equal(await readFile(target, "utf8"), "new");
});

test("a child created after the restriction inherits the owner-only ACL", async (context) => {
  const dir = await fixture(context);
  const secrets = join(dir, "secrets");
  await mkdir(secrets);
  restrictToOwnerSync(secrets, { directory: true });

  const child = join(secrets, "auth-token");
  await writeFile(child, "token");

  const report = icaclsReport(child);
  assert.ok(!/BUILTIN\\Users|Everyone|Authenticated Users/i.test(report), report);
});
