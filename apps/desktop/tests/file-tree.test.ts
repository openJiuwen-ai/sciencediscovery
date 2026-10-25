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

import { createTest } from "../../../test/support/tagged/compat.mjs";
import { buildFileTree, countFiles, type FileTreeNode } from "../src/app/file-tree.js";
import type { WorkspaceFile } from "../src/api/types.js";

const { describe, it } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

function file(path: string, size = 10): WorkspaceFile {
  return { modifiedAt: "2026-01-01T00:00:00.000Z", path, size };
}

/** The tree as indented names, which is what a reader sees; a `dir/` line means
 *  a directory node and the lines under it are its contents. */
function outline(node: FileTreeNode, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  return [
    ...node.subdirectories.flatMap((child) => [`${pad}${child.name}/`, ...outline(child, depth + 1)]),
    ...node.files.map((entry) => `${pad}${entry.path.split("/").at(-1)}`),
  ];
}

describe("a workspace path becomes one row per directory", () => {
  it("nests every level instead of joining a directory with slashes", () => {
    const tree = buildFileTree([file("antibody_pipeline/runs/demo-01/05_screening/report.md")]);
    assert.deepEqual(outline(tree), [
      "antibody_pipeline/",
      "  runs/",
      "    demo-01/",
      "      05_screening/",
      "        report.md",
    ]);
    // The name on each row is one segment: that is what makes the row foldable
    // and readable at the panel's narrowest width.
    assert.deepEqual(
      outline(tree).map((line) => line.trim().replace(/\/$/u, "")).filter((name) => name.includes("/")),
      [],
    );
  });

  it("keeps a folder in one place when files are written at several depths", () => {
    // The bug this replaces: grouping by the whole directory string made
    // `antibody_pipeline`, `antibody_pipeline/inputs` and
    // `antibody_pipeline/runs/demo-01` three separate rows at the same indent.
    const tree = buildFileTree([
      file("antibody_pipeline/artifact_manifest.txt"),
      file("antibody_pipeline/inputs/target_antigen.pdb"),
      file("antibody_pipeline/runs/demo-01/output_000000.pdb"),
      file("readme.md"),
    ]);
    assert.deepEqual(outline(tree), [
      "antibody_pipeline/",
      "  inputs/",
      "    target_antigen.pdb",
      "  runs/",
      "    demo-01/",
      "      output_000000.pdb",
      "  artifact_manifest.txt",
      "readme.md",
    ]);
  });

  it("puts directories above files, each group in name order", () => {
    const tree = buildFileTree([
      file("b.txt"),
      file("a.txt"),
      file("z_dir/inner.txt"),
      file("a_dir/inner.txt"),
    ]);
    assert.deepEqual(outline(tree), [
      "a_dir/",
      "  inner.txt",
      "z_dir/",
      "  inner.txt",
      "a.txt",
      "b.txt",
    ]);
  });

  it("counts a directory's files as everything below it", () => {
    const tree = buildFileTree([
      file("a/one.txt"),
      file("a/two.txt"),
      file("a/b/three.txt"),
      file("a/b/c/four.txt"),
    ]);
    assert.equal(countFiles(tree), 4);
    assert.equal(countFiles(tree.subdirectories[0]!), 4);
    assert.equal(countFiles(tree.subdirectories[0]!.subdirectories[0]!), 2);
  });

  it("folds separators the server may double, and drops a path that names no file", () => {
    const tree = buildFileTree([file("/a//b.txt"), file("///"), file("c.txt")]);
    assert.deepEqual(outline(tree), ["a/", "  b.txt", "c.txt"]);
  });

  it("is empty for an empty workspace", () => {
    const tree = buildFileTree([]);
    assert.deepEqual([tree.files, tree.subdirectories], [[], []]);
  });
});
