// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CasStore, VersionStore, committedWorkspaceSnapshot, withWorkspaceMutation } from "@sciencediscovery/cas";
import { storeEvolutionInput } from "./workspace-input.js";

test("Evolution file input uses committed bytes during a write and remains readable by the legacy CAS facade", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "evolve-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const versions = new VersionStore(root);
  await writeFile(join(workspace, "code.py"), "old");
  await committedWorkspaceSnapshot(versions, workspace);
  let finish!: () => void; let started!: () => void;
  const ready = new Promise<void>((done) => { started = done; });
  const release = new Promise<void>((done) => { finish = done; });
  const writer = withWorkspaceMutation(versions, workspace, async () => {
    await writeFile(join(workspace, "code.py"), "unfinished"); started(); await release;
  }, { kind: "test" });
  await ready;
  try {
    const input = await storeEvolutionInput(versions, workspace, { path: "code.py" });
    assert.equal((await new CasStore(root).read(input.slice(7))).toString(), "old");
  } finally { finish(); await writer; }
  const input = await storeEvolutionInput(versions, workspace, { path: "code.py" });
  assert.equal((await new CasStore(root).read(input.slice(7))).toString(), "unfinished");
  await symlink("code.py", join(workspace, "link"));
  for (const path of ["", "../code.py", "link", "missing"]) {
    await assert.rejects(storeEvolutionInput(versions, workspace, { path }));
  }
  const inline = await storeEvolutionInput(versions, workspace, { content: "explicit text" });
  assert.equal((await new CasStore(root).read(inline.slice(7))).toString(), "explicit text");
});
