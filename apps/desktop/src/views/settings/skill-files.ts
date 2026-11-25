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

import type { SkillDetail } from "../../api/types.js";

/** One node of a package's file tree; a folder is the node with children. */
export interface TreeNode {
  children?: TreeNode[];
  name: string;
  path: string;
}

/** A package's files as the handoff draws them: a 文件 group for the files at
 *  the package root, then the folders in path order. */
export function fileTree(detail: SkillDetail, extraFolders: readonly string[] = []): TreeNode[] {
  const folders: TreeNode[] = [];
  const rootFiles: TreeNode[] = [{ name: "SKILL.md", path: "SKILL.md" }];

  /** `prefix` is the folders above this call: a folder's key is its whole
   *  path, so two `scripts` folders at different depths stay separate while
   *  every file under one `scripts` shares that folder. */
  const insert = (nodes: TreeNode[], parts: string[], path: string, prefix = ""): void => {
    const [head, ...rest] = parts;
    if (head === undefined) return;
    const folderPath = prefix === "" ? head : `${prefix}/${head}`;
    if (rest.length === 0) {
      nodes.push({ name: head, path });
      return;
    }
    let folder = nodes.find((node) => node.children !== undefined && node.path === folderPath);
    if (!folder) {
      folder = { children: [], name: head, path: folderPath };
      nodes.push(folder);
    }
    insert(folder.children!, rest, path, folderPath);
  };

  for (const resource of detail.resources) {
    const parts = resource.path.split("/").filter((part) => part !== "");
    if (parts.length <= 1) {
      rootFiles.push({ name: resource.path, path: resource.path });
    } else {
      insert(folders, parts, resource.path);
    }
  }
  // A folder the editor created and has not put a file in yet exists only in
  // the editor: a package stores files, and an empty directory would vanish on
  // the next read. It is a folder even with no children, so it gets the
  // folder's own node rather than `insert`'s leaf.
  const insertFolder = (nodes: TreeNode[], parts: string[], prefix = ""): void => {
    const [head, ...rest] = parts;
    if (head === undefined) return;
    const folderPath = prefix === "" ? head : `${prefix}/${head}`;
    let folder = nodes.find((node) => node.children !== undefined && node.path === folderPath);
    if (!folder) {
      folder = { children: [], name: head, path: folderPath };
      nodes.push(folder);
    }
    insertFolder(folder.children!, rest, folderPath);
  };
  for (const folder of extraFolders) {
    insertFolder(folders, folder.split("/").filter((part) => part !== ""));
  }

  // Files come before folders at every level: the package's documents are what
  // a reader is usually after, and a folder is the way to more files. Within
  // one kind the names decide.
  const order = (nodes: TreeNode[]) => nodes.toSorted((left, right) => {
    const folder = Number(left.children !== undefined) - Number(right.children !== undefined);
    return folder !== 0 ? folder : left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
  const sortDeep = (nodes: TreeNode[]) => {
    const sorted = order(nodes);
    for (const node of sorted) if (node.children) node.children = sortDeep(node.children);
    return sorted;
  };

  // SKILL.md leads, then every other file at the package root, then the
  // folders: files that sit beside the folders are listed before them.
  const skillMarkdown = rootFiles.find((node) => node.path === "SKILL.md");
  const otherFiles = order(rootFiles.filter((node) => node.path !== "SKILL.md"));
  return [...(skillMarkdown === undefined ? [] : [skillMarkdown]), ...otherFiles, ...sortDeep(folders)];
}

/** The package-relative path a Markdown link names, or undefined when the
 *  link is not a file in the package (an absolute URL, a mailto:, an empty
 *  fragment). Relative links resolve from the file the reader is in. */
export function resolvePackageLink(href: string, from: string): string | undefined {
  const raw = (href.split("#")[0] ?? "").trim();
  if (raw === "" || raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(raw)) return undefined;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A stray `%` is part of the name, not an encoding.
  }
  const parts = decoded.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const segment of decoded.replace(/^\/+/u, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length === 0 ? undefined : parts.join("/");
}

/** Every file path a package holds, for deciding whether a link stays inside. */
export function packagePaths(detail: SkillDetail): Set<string> {
  return new Set(["SKILL.md", ...detail.resources.map((resource) => resource.path)]);
}

/** A path that can identify a file in the package, or undefined. */
export function validPackagePath(value: string): string | undefined {
  const path = value.trim().replace(/\\/gu, "/");
  if (path === "" || path.startsWith("/")) return undefined;
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
  return path;
}
