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
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { digestTree } from "./content-digest.js";

describe("content tree digest", () => {
  let workspace = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "science-agent-digest-"));
  });

  after(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  async function buildTree(name: string): Promise<string> {
    const root = join(workspace, name);
    await mkdir(join(root, "backend", "packages"), { recursive: true });
    await writeFile(join(root, "README.md"), "deer-flow fixture\n");
    await writeFile(join(root, "backend", "pyproject.toml"), "[project]\nname = \"fixture\"\n");
    await writeFile(join(root, "backend", "packages", "module.py"), "print('hi')\n");
    await symlink("../README.md", join(root, "backend", "readme-link"));
    return root;
  }

  test("is stable across identical trees at different paths", async () => {
    const first = await digestTree(await buildTree("tree-a"));
    const second = await digestTree(await buildTree("tree-b"));
    assert.match(first, /^sha256:[0-9a-f]{64}$/);
    assert.equal(first, second);
  });

  test("changes when file content changes", async () => {
    const root = await buildTree("tree-content");
    const before_ = await digestTree(root);
    await writeFile(join(root, "backend", "packages", "module.py"), "print('changed')\n");
    assert.notEqual(await digestTree(root), before_);
  });

  test("changes when a path changes and ignores .git state", async () => {
    const root = await buildTree("tree-paths");
    const baseline = await digestTree(root);

    // Repository metadata must not affect the digest: a git checkout and an
    // extracted archive of the same commit have to compare equal.
    await mkdir(join(root, ".git", "objects"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    assert.equal(await digestTree(root), baseline);

    await writeFile(join(root, "extra.txt"), "new file\n");
    assert.notEqual(await digestTree(root), baseline);
  });
});
