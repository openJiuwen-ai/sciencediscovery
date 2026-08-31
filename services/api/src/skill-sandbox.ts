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

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { SKILL_EXTENSIONS_WORKSPACE_PATH } from "@sciencediscovery/schema";
import { hashSkillPackageFiles, type RuntimeSkillSnapshot } from "@sciencediscovery/specialist";

export const SKILL_SNAPSHOT_MANIFEST = ".sciencediscovery-snapshot.json";

export interface SkillSnapshotManifest {
  schemaVersion: 1;
  skills: Array<{
    hash: string;
    id: string;
    path: string;
    revision: number;
    version: string;
  }>;
}

function safePackagePath(path: string): string {
  if (!path || path.includes("\\") || path.includes("\0") || isAbsolute(path)) {
    throw new Error(`Unsafe frozen Skill package path: ${path || "(empty)"}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe frozen Skill package path: ${path}`);
  }
  return path;
}

function stableManifest(manifest: SkillSnapshotManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function existingSnapshotMatches(root: string, expected: string): Promise<boolean> {
  try {
    return await readFile(resolve(root, SKILL_SNAPSHOT_MANIFEST), "utf8") === expected;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Prepare one Agent execution's complete frozen Skill tree before its model loop starts. */
export async function prepareSkillSandbox(
  root: string,
  workspaceRoot: string,
  skills: readonly RuntimeSkillSnapshot[],
): Promise<{ extensionRoot: string; manifest: SkillSnapshotManifest; root: string }> {
  if (!skills.length) throw new Error("At least one frozen Skill is required");
  for (const skill of skills) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.id)) {
      throw new Error(`Unsafe frozen Skill id: ${skill.id}`);
    }
  }
  const manifest: SkillSnapshotManifest = {
    schemaVersion: 1,
    skills: skills
      .map((skill) => ({
        hash: skill.hash,
        id: skill.id,
        path: `/skills/${skill.id}`,
        revision: skill.revision,
        version: skill.version,
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  };
  if (new Set(manifest.skills.map((skill) => skill.id)).size !== manifest.skills.length) {
    throw new Error("Frozen Skill snapshot contains duplicate skill ids");
  }

  const expectedManifest = stableManifest(manifest);
  const extensionRoot = resolve(workspaceRoot, SKILL_EXTENSIONS_WORKSPACE_PATH);
  await mkdir(extensionRoot, { recursive: true });
  if (await existingSnapshotMatches(root, expectedManifest)) return { extensionRoot, manifest, root };

  const parent = dirname(root);
  const staging = resolve(parent, `.${randomUUID()}.skill-snapshot`);
  await mkdir(parent, { recursive: true });
  await mkdir(staging);
  try {
    for (const skill of skills) {
      const packageRoot = resolve(staging, skill.id);
      await mkdir(packageRoot);
      const files = skill.readPackageFiles();
      if (!files.some((file) => file.path === "SKILL.md")) {
        throw new Error(`Frozen Skill package is missing SKILL.md: ${skill.id}`);
      }
      const packageFiles = new Map<string, Uint8Array>();
      for (const file of files) {
        const path = safePackagePath(file.path);
        const bytes = Buffer.from(file.bytes);
        const hash = createHash("sha256").update(bytes).digest("hex");
        if (bytes.length !== file.size || hash !== file.hash) {
          throw new Error(`Frozen Skill file metadata mismatch: ${skill.id}/${path}`);
        }
        packageFiles.set(path, bytes);
        const destination = resolve(packageRoot, ...path.split("/"));
        const destinationParent = dirname(destination);
        await mkdir(destinationParent, { recursive: true });
        await writeFile(destination, bytes, { flag: "wx", mode: 0o444 });
      }
      if (hashSkillPackageFiles(packageFiles) !== skill.hash) {
        throw new Error(`Frozen Skill package hash mismatch: ${skill.id}`);
      }
    }
    await writeFile(resolve(staging, SKILL_SNAPSHOT_MANIFEST), expectedManifest, { flag: "wx", mode: 0o444 });
    try {
      await rename(staging, root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !await existingSnapshotMatches(root, expectedManifest)) {
        throw error;
      }
    }
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
  return { extensionRoot, manifest, root };
}
