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
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  SKILL_EXTENSIONS_WORKSPACE_PATH,
  type SkillPackageBundle,
  type SkillPackageManifest,
} from "@sciencediscovery/schema";
import { hashSkillPackageFiles, type RuntimeSkillSnapshot } from "@sciencediscovery/specialist";

export const SKILL_SNAPSHOT_MANIFEST = ".sciencediscovery-snapshot.json";

async function readSnapshotManifest(root: string): Promise<SkillSnapshotManifest> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new Error("Unsafe frozen Skill root");
  const manifestInfo = await lstat(resolve(root, SKILL_SNAPSHOT_MANIFEST));
  if (!manifestInfo.isFile()) throw new Error("Unsafe frozen Skill manifest");
  const manifest = JSON.parse(await readFile(resolve(root, SKILL_SNAPSHOT_MANIFEST), "utf8")) as SkillSnapshotManifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.skills)) throw new Error("Invalid frozen Skill manifest");
  for (const skill of manifest.skills) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.id)) throw new Error("Unsafe frozen Skill id");
  }
  return manifest;
}

/**
 * What this run selected, without its bytes. Each `hash` already covers that
 * package's files, so a Runner can be asked whether it holds this exact set
 * before anything is read off disk or put on the wire.
 */
export async function readPreparedSkillManifest(root: string): Promise<SkillPackageManifest> {
  const manifest = await readSnapshotManifest(root);
  return {
    skills: manifest.skills.map((skill) => ({
      hash: skill.hash,
      id: skill.id,
      revision: skill.revision,
      version: skill.version,
    })),
  };
}

/**
 * Transport only selected frozen bytes, never a control-plane mount path. Each
 * package is re-hashed from what is on disk before it leaves this machine, so a
 * snapshot damaged after staging fails the execution here rather than being
 * shipped to a Runner as if it were still the frozen package.
 */
export async function readPreparedSkillBundle(root: string): Promise<SkillPackageBundle> {
  const manifest = await readSnapshotManifest(root);
  const bundle: SkillPackageBundle = { skills: [] };
  for (const skill of manifest.skills) {
    const files: SkillPackageBundle["skills"][number]["files"] = [];
    const packageFiles = new Map<string, Uint8Array>();
    const walk = async (dir: string, prefix = ""): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = safePackagePath(prefix + entry.name);
        if (entry.isSymbolicLink()) throw new Error("Unsafe frozen Skill file");
        if (entry.isDirectory()) {
          await walk(resolve(dir, entry.name), `${path}/`);
          continue;
        }
        if (!entry.isFile()) throw new Error("Unsafe frozen Skill file");
        const bytes = await readFile(resolve(dir, entry.name));
        packageFiles.set(path, bytes);
        files.push({ path, size: bytes.length, hash: createHash("sha256").update(bytes).digest("hex"), content: bytes.toString("base64") });
      }
    };
    await walk(resolve(root, skill.id));
    if (hashSkillPackageFiles(packageFiles) !== skill.hash) {
      throw new Error(`Frozen Skill package integrity mismatch: ${skill.id}`);
    }
    bundle.skills.push({ id: skill.id, revision: skill.revision, version: skill.version, hash: skill.hash, files });
  }
  return bundle;
}

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

/**
 * Identity of one selected Skill set, used as the content-addressed snapshot
 * directory name. Runs that select the same frozen revisions reuse one staged
 * tree, which also keeps a persistent kernel's mounts stable across runs.
 */
export function skillPackageSetHash(skills: readonly RuntimeSkillSnapshot[]): string {
  const hash = createHash("sha256");
  for (const skill of [...skills].toSorted((left, right) => left.id.localeCompare(right.id))) {
    hash.update(`${skill.id}\n${skill.revision}\n${skill.version}\n${skill.hash}\n`);
  }
  return hash.digest("hex");
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
      // Concurrent runs sharing one content-addressed root race here; POSIX
      // reports a non-empty destination as ENOTEMPTY or EEXIST depending on the
      // platform. Either is fine as long as the winner staged the same bytes.
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EEXIST" && code !== "ENOTEMPTY") || !await existingSnapshotMatches(root, expectedManifest)) {
        throw error;
      }
    }
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
  return { extensionRoot, manifest, root };
}
