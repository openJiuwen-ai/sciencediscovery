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
import { currentUserSid, win32SecretProtector } from "./win32.js";

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
  // The grant travels as a SID ("*S-1-..."); icacls read-back shows
  // either the resolved account name (whoami prints it lowercase, icacls in
  // its own case) or the raw SID — accept both, compare case-insensitively.
  const sid = currentUserSid().toLowerCase();
  const principal = spawnSync("whoami", [], { encoding: "utf8" }).stdout.trim().toLowerCase();
  const acl = report.toLowerCase();
  assert.ok(
    acl.includes(sid) || acl.includes(`${principal}:f`) || acl.includes(`${principal}:(f)`),
    report,
  );
  // Built-in groups must not survive: that would be the Windows equivalent of world-readable.
  assert.ok(!/BUILTIN\\Users|Everyone|Authenticated Users/i.test(report), report);
});

test("currentUserSid returns a plain SID string", () => {
  // S-1-5-21-… (local/domain) or S-1-12-1-… (Entra ID) — both are pure ASCII
  // and survive the OEM-codepage pipe that mangles non-ASCII account names.
  assert.match(currentUserSid(), /^S-1-\d+(-\d+)+$/);
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

// --- at-rest secret wrapping via DPAPI -----------------------------------

/** The CryptProtectData header as documented by the blob format, spelled out
 *  here independently of the implementation constant. */
const DPAPI_SPEC_PREFIX = Buffer.from([
  0x01, 0x00, 0x00, 0x00, 0xd0, 0x8c, 0x9d, 0xdf, 0x01, 0x15, 0xd1, 0x11,
  0x8c, 0x7a, 0x00, 0xc0, 0x4f, 0xc2, 0x97, 0xeb,
]);

test("wrap round-trips a master key through real DPAPI", async () => {
  const key = Buffer.from("0123456789abcdef0123456789abcdef");

  const wrapped = await win32SecretProtector.wrap(key);

  assert.equal(win32SecretProtector.wrapsAtRest, true);
  assert.equal(win32SecretProtector.isWrapped(wrapped), true, "a CryptProtectData blob must carry the documented 20-byte header");
  assert.ok(!wrapped.equals(key), "the master key must not be stored in the clear");
  assert.deepEqual(await win32SecretProtector.unwrap(wrapped), key);

  const again = await win32SecretProtector.wrap(key);
  assert.ok(!again.equals(wrapped), "CryptProtectData is non-deterministic");
  assert.deepEqual(await win32SecretProtector.unwrap(again), key);
});

test("isWrapped recognises the CryptProtectData header and nothing else", () => {
  assert.equal(win32SecretProtector.isWrapped(Buffer.concat([DPAPI_SPEC_PREFIX, Buffer.alloc(48, 1)])), true);
  assert.equal(win32SecretProtector.isWrapped(DPAPI_SPEC_PREFIX), true, "the header alone still claims the format");
  assert.equal(win32SecretProtector.isWrapped(Buffer.alloc(32, 7)), false, "a legacy raw key is not a blob");
  assert.equal(win32SecretProtector.isWrapped(Buffer.alloc(0)), false);
  const corrupt = Buffer.from(DPAPI_SPEC_PREFIX);
  corrupt[4] = corrupt[4]! ^ 0xff;
  assert.equal(win32SecretProtector.isWrapped(corrupt), false, "a one-byte difference must not pass");
});

test("unwrap fails loudly on a blob that DPAPI cannot decrypt", async () => {
  const garbage = Buffer.concat([DPAPI_SPEC_PREFIX, Buffer.alloc(64, 9)]);
  await assert.rejects(win32SecretProtector.unwrap(garbage), /ProtectedData unprotect failed/);
  await assert.rejects(win32SecretProtector.unwrap(Buffer.alloc(32, 7)), /ProtectedData unprotect failed/);
});
