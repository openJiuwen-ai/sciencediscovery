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
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { readablePrivateKey, readSshConfigHost } from "./ssh-config.js";

test("an existing ssh_config Host can be imported, and an unreadable key says so", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `ssh-config-import-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  context.after(() => rm(root, { force: true, recursive: true }));
  const keyPath = resolve(root, "id_ed25519");
  await writeFile(keyPath, "-----BEGIN OPENSSH PRIVATE KEY-----\nmaterial\n-----END OPENSSH PRIVATE KEY-----\n");
  const configPath = resolve(root, "config");
  await writeFile(configPath, [
    "Host *",
    "  ServerAliveInterval 30",
    "",
    "Host institution-hpc",
    "  HostName hpc.example.test",
    "  Port 2222",
    "  User scientist",
    `  IdentityFile ${keyPath}`,
    "",
    "Host no-key",
    "  HostName other.example.test",
    "  IdentityFile /nonexistent/id_ed25519",
    "",
  ].join("\n"));

  const imported = await readSshConfigHost(configPath, "institution-hpc");
  assert.equal(imported.hostName, "hpc.example.test");
  assert.equal(imported.port, 2222);
  assert.equal(imported.username, "scientist");
  assert.equal(imported.identityFile, keyPath);
  assert.equal(imported.identityKeyReadable, true);
  // The material stays on the API host; only the fact that it is readable travels.
  assert.equal(JSON.stringify(imported).includes("material"), false);

  const withoutKey = await readSshConfigHost(configPath, "no-key");
  assert.equal(withoutKey.hostName, "other.example.test");
  assert.equal(withoutKey.identityKeyReadable, false);

  await assert.rejects(readSshConfigHost(configPath, "not-configured"), /no Host entry named not-configured/);
  await assert.rejects(readSshConfigHost(resolve(root, "missing"), "institution-hpc"), /Could not read the SSH configuration/);

  assert.match(await readablePrivateKey(keyPath) ?? "", /BEGIN OPENSSH PRIVATE KEY/);
  assert.equal(await readablePrivateKey(configPath), undefined, "a config file is not a key");
  await chmod(keyPath, 0o000);
  const unreadable = await readablePrivateKey(keyPath);
  await chmod(keyPath, 0o600);
  // Running as root defeats permission bits, so this only holds otherwise.
  if (process.getuid?.() !== 0) assert.equal(unreadable, undefined);
});
