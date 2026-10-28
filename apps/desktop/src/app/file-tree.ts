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

import type { WorkspaceFile } from "../api/types.js";
import { fileName } from "./paths.js";

/**
 * One directory of the workspace tree.
 *
 * A directory holds the files directly inside it and the directories directly
 * below it, and nothing else: the depth is the point. `name` is one segment —
 * `runs`, never `antibody_pipeline/runs` — because a folder is a folder at
 * every level, and a row that spells out the whole path is a row the reader
 * cannot fold, cannot count, and cannot read at the panel's own 280 px.
 */
export interface FileTreeNode {
  /** The files sitting in this directory, by name. */
  files: WorkspaceFile[];
  /** The single path segment this node is. Empty for the root. */
  name: string;
  /** The path from the workspace root, which is what the server spells and what
   *  a row's tooltip shows. */
  path: string;
  subdirectories: FileTreeNode[];
}

/**
 * Fold a flat file list into the directories its paths imply.
 *
 * The server hands over one entry per file with its whole path
 * (`antibody_pipeline/runs/antibody-demo-01/05_screening/report.md`), and a tree
 * is what gets drawn: that one path becomes five nodes, each foldable on its
 * own, with the file under the deepest of them. Grouping by the whole directory
 * string instead — which is what this replaced — made one row per *unique
 * directory*, so a parent and its child read as two unrelated rows at the same
 * indent, both labelled with slashes.
 *
 * Directories come before files and each group is sorted by name, which is the
 * order every file manager uses and the one that keeps a directory from moving
 * down as files are written into it.
 */
export function buildFileTree(files: readonly WorkspaceFile[]): FileTreeNode {
  const root: FileTreeNode = { files: [], name: "", path: "", subdirectories: [] };
  const directories = new Map<string, FileTreeNode>([["", root]]);
  for (const file of files) {
    // A leading slash, a trailing slash or a doubled separator all describe the
    // same place; the file's own `path` stays as the server wrote it.
    const segments = file.path.split("/").filter((segment) => segment !== "");
    const name = segments.pop();
    // A path that is nothing but separators names no file and belongs nowhere:
    // the server does not send one, and a row invented for it would be a row
    // with an empty label.
    if (name === undefined) continue;
    let parent = root;
    let path = "";
    for (const segment of segments) {
      path = path === "" ? segment : `${path}/${segment}`;
      let node = directories.get(path);
      if (node === undefined) {
        node = { files: [], name: segment, path, subdirectories: [] };
        directories.set(path, node);
        parent.subdirectories.push(node);
      }
      parent = node;
    }
    parent.files.push(file);
  }
  sortNode(root);
  return root;
}

/**
 * The part of the tree a search keeps, or `undefined` when it keeps nothing.
 *
 * A file is kept when its whole path contains the query, so a folder can be
 * typed as well as a name — searching `inputs` finds the files under it — and
 * the directories above a match come with it, or the row would have no place in
 * the tree.
 *
 * A directory with no matching file below it is dropped rather than shown
 * empty: it is a row that leads nowhere, and a search that answers with the
 * same forty folders whichever word is typed has not narrowed anything. That is
 * what the caller's `undefined` means — nothing matched — which is a different
 * answer from an empty workspace.
 */
export function filterFileTree(node: FileTreeNode, query: string): FileTreeNode | undefined {
  const needle = query.trim().toLowerCase();
  if (needle === "") return node;
  return prune(node, needle);
}

function prune(node: FileTreeNode, needle: string): FileTreeNode | undefined {
  const files = node.files.filter((file) => file.path.toLowerCase().includes(needle));
  const subdirectories: FileTreeNode[] = [];
  for (const child of node.subdirectories) {
    const kept = prune(child, needle);
    if (kept !== undefined) subdirectories.push(kept);
  }
  if (files.length === 0 && subdirectories.length === 0) return undefined;
  return { files, name: node.name, path: node.path, subdirectories };
}

/** How many files are at or below a directory — what its row reports, because
 *  "2 个文件" on a folder whose own two files are joined by forty in a
 *  subdirectory is a count that describes the wrong thing. */
export function countFiles(node: FileTreeNode): number {
  return node.files.length
    + node.subdirectories.reduce((total, child) => total + countFiles(child), 0);
}

function sortNode(node: FileTreeNode): void {
  // Sorted by the name the row shows, which is the same `fileName` the row is
  // labelled with, so the order and the labels cannot disagree about a file.
  node.files.sort((left, right) => fileName(left.path).localeCompare(fileName(right.path)));
  node.subdirectories.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of node.subdirectories) sortNode(child);
}
