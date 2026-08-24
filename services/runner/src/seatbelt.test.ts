// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSeatbeltProfile, seatbeltString, seatbeltWorkspaceMapping } from "./seatbelt.js";

test("Seatbelt strings escape profile metacharacters", () => {
  assert.equal(seatbeltString('a\\b"c'), '"a\\\\b\\"c"');
});

test("offline Seatbelt profile grants only declared writable roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "seatbelt-profile-"));
  const workspace = join(root, "workspace");
  const runtime = join(root, "runtime");
  await Promise.all([mkdir(workspace), mkdir(runtime)]);
  const profile = await buildSeatbeltProfile({ readPaths: [workspace, runtime], writePaths: [workspace] });
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /allow file-write\*/);
  assert.match(profile, new RegExp(`${workspace.split("/").at(-1)}"\\)`));
  assert.doesNotMatch(profile, new RegExp(`file-write\\*.*${runtime.split("/").at(-1)}"\\)`));
  assert.doesNotMatch(profile, /network-outbound/);
});

test("networked Seatbelt profile grants only its loopback proxy port", async () => {
  const root = await mkdtemp(join(tmpdir(), "seatbelt-network-"));
  const profile = await buildSeatbeltProfile({
    proxyPort: 32123,
    readPaths: [root],
    writePaths: [root],
  });
  assert.match(profile, /network-outbound \(remote ip "localhost:32123"\)/);
  assert.doesNotMatch(profile, /network-outbound\)\s*$/m);
  assert.doesNotMatch(profile, /remote tcp/);
});

test("workspace mapping preserves the logical provenance path", async () => {
  const root = await mkdtemp(join(tmpdir(), "seatbelt-workspace-"));
  const child = join(root, "agent", "work");
  await mkdir(child, { recursive: true });
  const mapping = seatbeltWorkspaceMapping(child, root, "/workspace/agent/work");
  assert.equal(mapping.hostCwd, child);
  assert.equal(mapping.toHostPath("/workspace/agent/work"), child);
  assert.equal(mapping.toLogicalPath(child), "/workspace/agent/work");
});
