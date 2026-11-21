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

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });

import assert from "node:assert/strict";

import { hashPassword, signJwt, verifyJwt, verifyPassword } from "./crypto.js";

const SECRET = "test-secret-that-is-long-enough-for-hs256";

test("jwt round-trips claims", () => {
  const token = signJwt({ sub: 7, typ: "access" }, SECRET, 60, 1_700_000_000_000);
  const claims = verifyJwt<{ sub: number; typ: string; iat: number; exp: number }>(token, SECRET, 1_700_000_010_000);
  assert.equal(claims?.sub, 7);
  assert.equal(claims?.typ, "access");
  assert.equal(claims?.exp, 1_700_000_060);
});

test("jwt rejects expiry, tampering and a foreign secret", () => {
  const token = signJwt({ sub: 7 }, SECRET, 60, 1_700_000_000_000);
  assert.equal(verifyJwt(token, SECRET, 1_700_000_061_000), undefined);

  const [header, payload, signature] = token.split(".") as [string, string, string];
  const forged = Buffer.from(JSON.stringify({ sub: 8, iat: 1_700_000_000, exp: 1_700_000_060 })).toString("base64url");
  assert.equal(verifyJwt(`${header}.${forged}.${signature}`, SECRET, 1_700_000_010_000), undefined);
  assert.equal(verifyJwt(`${header}.${payload}.${signature}`, `${SECRET}x`, 1_700_000_010_000), undefined);
  assert.equal(verifyJwt("not-a-token", SECRET), undefined);
});

test("scrypt hashes are salted, verifiable and reject bad input", async () => {
  const passphrase = "three-kestrels-over-the-ridge";
  const hashes = await Promise.all([hashPassword(passphrase), hashPassword(passphrase)]);
  assert.notEqual(hashes[0], hashes[1], "a fresh salt must produce a different digest");
  assert.ok(await verifyPassword(passphrase, hashes[0]!));
  assert.equal(await verifyPassword(`${passphrase}-x`, hashes[0]!), false);
  assert.equal(await verifyPassword(passphrase, "scrypt$1$2"), false);
  assert.equal(await verifyPassword(passphrase, "plain-text"), false);
});

