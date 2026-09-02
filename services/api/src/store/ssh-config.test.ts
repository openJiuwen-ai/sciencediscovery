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
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  consumeStagedKey,
  generatedKeyDirectory,
  listSshConfigHosts,
  readablePrivateKey,
  readSshConfigHost,
  stageGeneratedKey,
} from "./ssh-config.js";

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

test("the importable ssh_config hosts are listed without touching key material", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `ssh-config-list-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  context.after(() => rm(root, { force: true, recursive: true }));
  const configPath = resolve(root, "config");
  await writeFile(configPath, [
    "Host *",
    "  ServerAliveInterval 30",
    "  IdentityFile /home/someone/.ssh/id_ed25519",
    "",
    "Host institution-hpc",
    "  HostName hpc.example.test",
    "  Port 2222",
    "  User scientist",
    "  IdentityFile /home/someone/.ssh/id_ed25519",
    "",
    "Host build-box lab-box",
    "  HostName build.example.test",
    "",
    "Host bastion*",
    "  HostName jump.example.test",
    "",
  ].join("\n"));

  const listed = await listSshConfigHosts(configPath);
  // Pattern blocks describe no particular machine, so they are not offered.
  assert.deepEqual(listed.map((entry) => entry.alias), ["institution-hpc", "build-box"]);
  assert.deepEqual(listed[0], {
    alias: "institution-hpc",
    hostName: "hpc.example.test",
    identityKeyReadable: false,
    port: 2222,
    username: "scientist",
  });
  assert.equal(listed[1]?.hostName, "build.example.test");
  // Listing never reads a key, so nothing about identity files travels with it.
  assert.equal(JSON.stringify(listed).includes("id_ed25519"), false);

  // A user with no SSH configuration at all is an empty list, not a failure.
  assert.deepEqual(await listSshConfigHosts(resolve(root, "missing")), []);
});

test("a generated key waits in the product data directory and is removed once stored", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `ssh-staged-key-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  context.after(() => rm(root, { force: true, recursive: true }));
  const material = "-----BEGIN OPENSSH PRIVATE KEY-----\nstaged\n-----END OPENSSH PRIVATE KEY-----\n";

  const path = await stageGeneratedKey(root, material);
  assert.equal(path.startsWith(`${generatedKeyDirectory(root)}/`), true);
  assert.equal((await stat(path)).mode & 0o777, 0o600, "a private key is written owner-only");
  assert.equal(await readablePrivateKey(path), material);

  await consumeStagedKey(root, path);
  assert.equal(await readablePrivateKey(path), undefined, "the loose copy does not outlive its use");

  // A key the user already had is theirs; consuming must not delete it.
  const ownKey = resolve(root, "their-own-key");
  await writeFile(ownKey, material);
  await consumeStagedKey(root, ownKey);
  assert.equal(await readablePrivateKey(ownKey), material);
});
