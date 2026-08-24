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

import type { ScientificArtifact, WorkspaceFile } from "@sciencediscovery/schema";

export type ArtifactTreeEntry = ArtifactTreeDirectory | ArtifactTreeLeaf;
export type WorkspaceFileTreeEntry = WorkspaceFileTreeDirectory | WorkspaceFileTreeLeaf;

export type PathTreeEntry<TLeaf extends PathTreeLeaf> = PathTreeDirectory<TLeaf> | TLeaf;

export interface PathTreeDirectory<TLeaf extends PathTreeLeaf> {
  children: PathTreeEntry<TLeaf>[];
  kind: "directory";
  name: string;
  path: string;
}

export interface PathTreeLeaf {
  kind: "artifact" | "file";
  name: string;
  path: string;
}

export type ArtifactTreeDirectory = PathTreeDirectory<ArtifactTreeLeaf>;

export interface ArtifactTreeLeaf {
  artifact: ScientificArtifact;
  kind: "artifact";
  name: string;
  path: string;
}

export type WorkspaceFileTreeDirectory = PathTreeDirectory<WorkspaceFileTreeLeaf>;

export interface WorkspaceFileTreeLeaf {
  file: WorkspaceFile;
  kind: "file";
  name: string;
  path: string;
}

interface MutableDirectory<TLeaf extends PathTreeLeaf> {
  directories: Map<string, MutableDirectory<TLeaf>>;
  leaves: TLeaf[];
  name: string;
  path: string;
}

function materialize<TLeaf extends PathTreeLeaf>(directory: MutableDirectory<TLeaf>): PathTreeEntry<TLeaf>[] {
  const directories: PathTreeDirectory<TLeaf>[] = [...directory.directories.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((child) => ({
      children: materialize(child),
      kind: "directory",
      name: child.name,
      path: child.path,
    }));
  const leaves = [...directory.leaves].sort((left, right) => left.name.localeCompare(right.name));
  return [...directories, ...leaves];
}

/** Builds a display-only hierarchy while every leaf retains its original object. */
export function buildPathTree<TItem, TLeaf extends PathTreeLeaf>(
  items: readonly TItem[],
  pathFor: (item: TItem) => string,
  leafFor: (item: TItem, name: string, path: string) => TLeaf,
): PathTreeEntry<TLeaf>[] {
  const root: MutableDirectory<TLeaf> = { directories: new Map(), leaves: [], name: "", path: "" };
  for (const item of items) {
    const itemPath = pathFor(item);
    const segments = itemPath.split("/").filter(Boolean);
    const leafName = segments.pop() ?? itemPath;
    let directory = root;
    for (const segment of segments) {
      const path = directory.path ? `${directory.path}/${segment}` : segment;
      let child = directory.directories.get(segment);
      if (!child) {
        child = { directories: new Map(), leaves: [], name: segment, path };
        directory.directories.set(segment, child);
      }
      directory = child;
    }
    directory.leaves.push(leafFor(item, leafName, itemPath));
  }
  return materialize(root);
}

/** Project artifact names are safe relative paths. */
export function buildArtifactTree(artifacts: readonly ScientificArtifact[]): ArtifactTreeEntry[] {
  return buildPathTree(artifacts, (artifact) => artifact.name, (artifact, name, path) => ({
    artifact,
    kind: "artifact",
    name,
    path,
  }));
}

/** Workspace file paths use the same relative-path display hierarchy as artifacts. */
export function buildWorkspaceFileTree(files: readonly WorkspaceFile[]): WorkspaceFileTreeEntry[] {
  return buildPathTree(files, (file) => file.path, (file, name, path) => ({
    file,
    kind: "file",
    name,
    path,
  }));
}

export function pathTreeCount<TLeaf extends PathTreeLeaf>(entries: readonly PathTreeEntry<TLeaf>[]): number {
  return entries.reduce(
    (count, entry) => count + (entry.kind === "directory" ? pathTreeCount(entry.children) : 1),
    0,
  );
}

export function pathTreeLeaves<TLeaf extends PathTreeLeaf>(entries: readonly PathTreeEntry<TLeaf>[]): TLeaf[] {
  return entries.flatMap((entry) => entry.kind === "directory" ? pathTreeLeaves(entry.children) : [entry]);
}

export function artifactTreeCount(entries: readonly ArtifactTreeEntry[]): number {
  return pathTreeCount(entries);
}
