// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs, { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { listSshKeyFiles } from "./ssh-key-files.js";

test("key browsing navigates the application filesystem without returning file contents", async (context) => {
  const temporary = resolve(".tmp");
  await mkdir(temporary, { recursive: true });
  const home = await mkdtemp(join(temporary, "key-picker-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const secret = randomBytes(32).toString("hex");
  const ssh = join(home, ".ssh");
  assert.equal((await listSshKeyFiles(undefined, 0, home)).directory, home);
  await mkdir(ssh);
  await mkdir(join(ssh, "nested"));
  await writeFile(join(ssh, "id with spaces"), secret);
  await symlink(join(ssh, "id with spaces"), join(ssh, "linked-key"));
  await symlink(join(ssh, "nested"), join(ssh, "linked-folder"));
  await symlink(join(ssh, "absent"), join(ssh, "broken"));
  const listed = await listSshKeyFiles(undefined, 0, home);
  assert.equal(listed.directory, ssh);
  assert.equal(listed.parentDirectory, home);
  assert.deepEqual(listed.entries.find((entry) => entry.name === "linked-key"), { name: "linked-key", path: join(ssh, "linked-key"), kind: "file" });
  assert.equal(listed.entries.find((entry) => entry.name === "linked-folder")?.kind, "directory");
  assert.equal(listed.entries.find((entry) => entry.name === "broken")?.kind, "unavailable");
  assert.ok(!JSON.stringify(listed).includes(secret), "only paths and kinds leave the listing layer");
  assert.deepEqual(await listSshKeyFiles(join(ssh, "id with spaces"), 0, home), listed);
  assert.equal((await listSshKeyFiles("~/", 0, home)).directory, home);
  assert.equal((await listSshKeyFiles("~/.ssh/nested", 0, home)).entries.length, 0);
  await assert.rejects(listSshKeyFiles("relative/path", 0, home), /absolute path/);
  await assert.rejects(listSshKeyFiles(ssh, -1, home), /Invalid directory page/);
  await assert.rejects(listSshKeyFiles(ssh, 1.5, home), /Invalid directory page/);
  await assert.rejects(listSshKeyFiles(join(home, "missing"), 0, home), /does not exist on the application machine/);
  // Model a filesystem permission refusal even when CI runs as root.
  const denied = context.mock.method(fs, "readdir", async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(listSshKeyFiles(join(ssh, "nested"), 0, home), /permission to browse/);
  } finally { denied.mock.restore(); syncBuiltinESMExports(); }
});

test("key browsing pages large directories without hiding remaining entries", async (context) => {
  const temporary = resolve(".tmp");
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, "key-picker-pages-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 105 }, (_, i) => writeFile(join(directory, `key-${String(i).padStart(3, "0")}`), "")));
  const first = await listSshKeyFiles(directory);
  const last = await listSshKeyFiles(directory, first.nextOffset!);
  assert.equal(first.entries.length, 100);
  assert.equal(first.nextOffset, 100);
  assert.equal(last.entries.length, 5);
  assert.equal(last.nextOffset, null);
  assert.equal(new Set([...first.entries, ...last.entries].map((entry) => entry.path)).size, 105);
});
