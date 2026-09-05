// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, statfs, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { collectRunnerResources } from "./resources.js";

test("resources measure the persistent workspace filesystem with user-available blocks", async (t) => {
  const dir = await mkdtemp(resolve(tmpdir(), "runner-resources-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await collectRunnerResources(dir);
  assert.equal(result.workspaceDisk?.path, resolve(await realpath(dir), "remote-workspaces"));
  const fs = await statfs(result.workspaceDisk!.path);
  assert.equal(result.workspaceDisk?.totalBytes, fs.blocks * fs.bsize);
  assert.ok(result.workspaceDisk!.availableBytes >= 0);
  // Available bytes can change concurrently, but cannot include reserved blocks.
  assert.ok(result.workspaceDisk!.availableBytes <= result.workspaceDisk!.totalBytes);
  assert.ok(result.cpuCores > 0);
  assert.ok(result.memoryTotalBytes > 0);
  assert.ok(Number.isFinite(Date.parse(result.capturedAt)));
});

test("resources never present another directory or a failed reading as an empty disk", async (t) => {
  const dir = await mkdtemp(resolve(tmpdir(), "runner-resources-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await symlink(dir, resolve(dir, "remote-workspaces"));
  const result = await collectRunnerResources(dir);
  assert.equal(result.workspaceDisk, null);
  assert.match(result.workspaceDiskError!, /unavailable/);
  assert.ok(result.memoryTotalBytes > 0);
});
