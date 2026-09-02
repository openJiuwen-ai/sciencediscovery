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

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import ssh2 from "ssh2";

import { generateSshKeyPair, openSshPublicKey } from "./ssh-keys.js";

const run = promisify(execFile);

test("a generated key is a real OpenSSH key whose public half is what OpenSSH derives", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "sd-ssh-keys-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const pair = generateSshKeyPair("sciencediscovery@lab-box");

  // The client that will use it has to be able to read it.
  assert.ok(pair.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----"));
  const parsed = ssh2.utils.parseKey(pair.privateKey);
  assert.equal(parsed instanceof Error, false, parsed instanceof Error ? parsed.message : "");
  assert.equal((parsed as ssh2.ParsedKey).type, "ssh-ed25519");

  // And OpenSSH itself must agree on the public half, since that is the line
  // the user pastes into the machine's authorized_keys.
  const keyPath = resolve(root, "id_ed25519");
  await writeFile(keyPath, pair.privateKey);
  await chmod(keyPath, 0o600);
  const { stdout } = await run("ssh-keygen", ["-y", "-f", keyPath]);
  assert.equal(stdout.trim(), pair.publicKey);
  assert.match(pair.publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]+ sciencediscovery@lab-box$/);

  // Two generations are two different keys.
  assert.notEqual(generateSshKeyPair("x").privateKey, pair.privateKey);
});

test("the public line can be derived from stored material, and junk is reported as unusable", () => {
  const pair = generateSshKeyPair("comment-here");
  assert.equal(openSshPublicKey(pair.privateKey, "comment-here"), pair.publicKey);
  // Without a comment the line is just type and key, as OpenSSH writes it.
  assert.equal(openSshPublicKey(pair.privateKey), pair.publicKey.split(" ").slice(0, 2).join(" "));
  assert.equal(openSshPublicKey("-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-key\n-----END OPENSSH PRIVATE KEY-----"), undefined);
  assert.equal(openSshPublicKey(""), undefined);
});
