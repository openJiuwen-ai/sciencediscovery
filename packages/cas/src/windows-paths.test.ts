// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { RefStore, VersionStore } from "./versioning.js";
import { withWorkspaceAdmission } from "./workspace-lifecycle.js";
import { withWorkspaceLease } from "./workspace-lease.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });

test("CAS SQLite admission, lease and refs accept a Workspace path beyond MAX_PATH", async context => {
  const root = await mkdtemp(join(tmpdir(), "cas-long-path-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, "nested-parent-".repeat(6), "nested-child-".repeat(6), "nested-leaf-".repeat(6));
  const workspace = join(parent, "workspace");
  assert.ok(workspace.length > 260);
  await mkdir(workspace, { recursive: true });
  const versions = new VersionStore(join(parent, "data"));
  let calls = 0;
  await withWorkspaceAdmission(versions, workspace, () => withWorkspaceLease(workspace, async () => { calls += 1; }));
  assert.equal(calls, 1);
  const refs = await RefStore.open(versions);
  try { assert.equal(refs.head("absent"), null); }
  finally { refs.close(); }
});
