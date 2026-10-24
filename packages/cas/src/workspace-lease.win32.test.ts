// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:windows"] });

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { withWorkspaceLease } from "./workspace-lease.js";

test("lease works where a 64-hex lock name would overrun MAX_PATH", async (t: TestContext) => {
  // 炸点③-15: coordination lock lives at
  //   dirname(workspace)/.workspace-coordination/<digest>.sqlite
  // and BEGIN IMMEDIATE needs "<file>-journal" (+8 chars). With the old 64-hex
  // digest, a dirname of ~170+ chars pushes the journal past MAX_PATH (260)
  // and SQLite reports SQLITE_CANTOPEN. The shortened 32-hex digest must fit.
  const root = await mkdtemp(join(tmpdir(), "sd-lease-deep-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  let dir = root;
  while (dir.length < 170) dir = join(dir, "d".repeat(20));
  const workspace = join(dir, "workspace");
  await mkdir(workspace, { recursive: true });

  // Old layout: dir + 24 + 64 + 7 + 8 ≈ 283 chars > MAX_PATH → CANTOPEN.
  // New layout: dir + 24 + 32 + 7 + 8 ≈ 251 chars < MAX_PATH → must work.
  let entered = false;
  await withWorkspaceLease(workspace, async () => { entered = true; });
  assert.equal(entered, true);
});
