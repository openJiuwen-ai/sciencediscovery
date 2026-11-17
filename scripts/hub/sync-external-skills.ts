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

/**
 * Freezes the separate MindScienceSkills repository into one snapshot.
 *
 * The snapshot is `index.json` plus `snapshot.tar.gz`; the site build only ever
 * reads those two files, never GitCode. Nothing is written unless every skill
 * was fetched and parsed, so a failed sync leaves the previous snapshot in
 * place.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "fflate";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createGitCodeClient } from "./gitcode.js";
import { packTar } from "./tar.js";

import type { GitCodeClient } from "./gitcode.js";

import { parseSkillMarkdown } from "../../packages/specialist/src/skills.js";

export const SNAPSHOT_REPO = "mindspore/mindscience";
export const SNAPSHOT_ROOT = "MindScienceSkills";
export const SNAPSHOT_INDEX = "index.json";
export const SNAPSHOT_TARBALL = "snapshot.tar.gz";

export interface ExternalIndexEntry {
  hardware: string | null;
  path: string;
  sha256: string;
  size: number;
  type: string | null;
}

export interface ExternalIndex {
  commit: string;
  fetchedAt: string;
  ref: string;
  repo: string;
  schemaVersion: 1;
  skills: ExternalIndexEntry[];
}

export interface SnapshotSource {
  commit: string;
  description: string;
  listSkillPaths(): Promise<string[]>;
  readme(): Promise<Uint8Array>;
  readSkill(skillPath: string): Promise<Uint8Array>;
  ref: string;
  repo: string;
}

export interface SnapshotBuild {
  index: ExternalIndex;
  tarGz: Uint8Array;
  warnings: string[];
}

const SKILL_TYPES: Record<string, string> = {
  "ai model": "ai-model",
  api: "api",
  "hpc software": "hpc-software",
  "know-how": "know-how",
  "laboratory automation": "laboratory-automation",
  "python package": "python-package",
};

const HARDWARE: Record<string, string> = {
  cpu: "cpu",
  "cpu/gpu": "cpu-gpu",
  gpu: "gpu",
  "gpu/cpu": "gpu-cpu",
  npu: "npu",
};

const ROW = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/;

interface ReadmeRow {
  hardware: string | null;
  name: string;
  path: string;
  type: string | null;
}

export function normalizeSkillType(raw: string | null | undefined): string | null {
  const key = raw?.trim().toLowerCase();
  return key ? SKILL_TYPES[key] ?? null : null;
}

export function normalizeHardware(raw: string | null | undefined): string | null {
  const key = raw?.trim().toLowerCase();
  return key ? HARDWARE[key] ?? null : null;
}

/** Reads the per-domain tables in README_ZH.md; the path is the authority. */
export function parseReadmeTables(markdown: string, warnings: string[] = []): Map<string, ReadmeRow> {
  const rows = new Map<string, ReadmeRow>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = ROW.exec(line);
    if (!match) continue;
    const [, name, rawPath, rawSubdomain, rawType, rawHardware] = match;
    const segments = rawPath!.trim().replace(/\/+$/, "").split("/");
    // Links elsewhere in the README also look like table cells; only a
    // domain/subdomain/name row with a matching subdomain column is a skill.
    // Real rows use both `astronomical-analysis` and `general_tools` for the
    // same directory, so compare and key by the underscore form.
    const subdomain = rawSubdomain!.trim().replace(/-/g, "_");
    if (segments.length !== 3 || segments[1]!.replace(/-/g, "_") !== subdomain) continue;
    if (segments.some((segment) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(segment))) continue;
    const skillPath = `${segments[0]}/${segments[1]!.replace(/-/g, "_")}/${segments[2]}`;
    const type = normalizeSkillType(rawType);
    const hardware = normalizeHardware(rawHardware);
    if (!type && rawType?.trim()) warnings.push(`${skillPath}: unknown skill type "${rawType.trim()}"`);
    if (!hardware && rawHardware?.trim() && rawHardware.trim() !== "/") {
      warnings.push(`${skillPath}: unknown hardware "${rawHardware.trim()}"`);
    }
    if (rows.has(skillPath)) {
      warnings.push(`${skillPath}: listed more than once in README_ZH.md; keeping the first row`);
      continue;
    }
    if (name!.trim() !== segments[2]) {
      warnings.push(`${skillPath}: README_ZH.md labels the skill "${name!.trim()}"; the directory name wins`);
    }
    rows.set(skillPath, { hardware, name: name!.trim(), path: skillPath, type });
  }
  return rows;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function buildSnapshot(source: SnapshotSource, now: () => Date = () => new Date()): Promise<SnapshotBuild> {
  const warnings: string[] = [];
  const readmeRows = parseReadmeTables(new TextDecoder("utf-8", { fatal: true }).decode(await source.readme()), warnings);
  const skillPaths = [...new Set(await source.listSkillPaths())].toSorted();

  const entries: ExternalIndexEntry[] = [];
  const tarEntries: { bytes: Uint8Array; path: string }[] = [];
  for (const skillPath of skillPaths) {
    // Fail the whole snapshot on one bad file: a half-written snapshot is worse
    // than yesterday's complete one.
    const bytes = await source.readSkill(skillPath);
    parseSkillMarkdown(Buffer.from(bytes));
    const row = readmeRows.get(skillPath);
    if (!row) warnings.push(`${skillPath}: absent from README_ZH.md; type and hardware will show as unknown`);
    entries.push({
      hardware: row?.hardware ?? null,
      path: skillPath,
      sha256: sha256(bytes),
      size: bytes.byteLength,
      type: row?.type ?? null,
    });
    tarEntries.push({ bytes, path: `${skillPath}/SKILL.md` });
  }

  const onDisk = new Set(skillPaths);
  for (const listed of readmeRows.keys()) {
    if (!onDisk.has(listed)) warnings.push(`${listed}: listed in README_ZH.md but there is no such directory`);
  }

  const index: ExternalIndex = {
    commit: source.commit,
    fetchedAt: now().toISOString(),
    ref: source.ref ?? "master",
    repo: source.repo,
    schemaVersion: 1,
    skills: entries,
  };
  // Fixed mtime and sorted entries keep repeated syncs of the same commit byte-identical.
  const tarGz = gzipSync(packTar(tarEntries), { level: 9, mtime: 0 });
  return { index, tarGz, warnings };
}

export interface SyncOptions {
  fixtureDir?: string;
  now?: () => Date;
  outDir: string;
  ref?: string;
  repo?: string;
  token?: string;
}

function fixtureSource(root: string): SnapshotSource {
  return {
    commit: "fixture",
    description: `fixture ${root}`,
    ref: "fixture",
    repo: "fixture",
    async listSkillPaths(): Promise<string[]> {
      const skillPaths: string[] = [];
      for (const domain of await readdir(root, { withFileTypes: true })) {
        if (!domain.isDirectory() || domain.name.startsWith(".")) continue;
        for (const subdomain of await readdir(path.join(root, domain.name), { withFileTypes: true })) {
          if (!subdomain.isDirectory() || subdomain.name.startsWith(".")) continue;
          for (const skill of await readdir(path.join(root, domain.name, subdomain.name), { withFileTypes: true })) {
            if (skill.isDirectory()) skillPaths.push(`${domain.name}/${subdomain.name}/${skill.name}`);
          }
        }
      }
      return skillPaths;
    },
    async readme(): Promise<Uint8Array> {
      return readFile(path.join(root, "README_ZH.md"));
    },
    async readSkill(skillPath: string): Promise<Uint8Array> {
      return readFile(path.join(root, skillPath, "SKILL.md"));
    },
  };
}

function gitCodeSource(client: GitCodeClient, repo: string, ref: string, commit: string): SnapshotSource {
  return {
    commit,
    description: `${repo}@${ref} (${commit.slice(0, 8)})`,
    ref,
    repo,
    async listSkillPaths(): Promise<string[]> {
      const skillPaths: string[] = [];
      for (const domain of await client.listDirectories(SNAPSHOT_ROOT, commit)) {
        for (const subdomain of await client.listDirectories(`${SNAPSHOT_ROOT}/${domain}`, commit)) {
          for (const skill of await client.listDirectories(`${SNAPSHOT_ROOT}/${domain}/${subdomain}`, commit)) {
            skillPaths.push(`${domain}/${subdomain}/${skill}`);
          }
        }
      }
      return skillPaths;
    },
    async readme(): Promise<Uint8Array> {
      return client.file(`${SNAPSHOT_ROOT}/README_ZH.md`, commit);
    },
    async readSkill(skillPath: string): Promise<Uint8Array> {
      return client.file(`${SNAPSHOT_ROOT}/${skillPath}/SKILL.md`, commit);
    },
  };
}

export async function syncExternalSkills(options: SyncOptions): Promise<SnapshotBuild> {
  // SOURCE_DATE_EPOCH makes a repeated sync byte-identical; without it the
  // snapshot records when it was taken.
  const now = options.now ?? (() => {
    const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? Number.NaN);
    return Number.isFinite(epoch) ? new Date(epoch * 1000) : new Date();
  });
  const repo = options.repo ?? SNAPSHOT_REPO;
  const ref = options.ref ?? "master";
  let source: SnapshotSource;
  if (options.fixtureDir) {
    source = fixtureSource(options.fixtureDir);
  } else {
    const client = createGitCodeClient({ ref, repo, token: options.token ?? process.env.GITCODE_TOKEN });
    // Resolve the branch once so every file in the snapshot comes from the same commit.
    source = gitCodeSource(client, repo, ref, await client.commit());
  }

  const build = await buildSnapshot(source, now);

  await mkdir(options.outDir, { recursive: true });
  const indexName = path.join(options.outDir, SNAPSHOT_INDEX);
  const tarName = path.join(options.outDir, SNAPSHOT_TARBALL);
  const indexTemp = `${indexName}.${process.pid}.tmp`;
  const tarTemp = `${tarName}.${process.pid}.tmp`;
  try {
    await writeFile(indexTemp, `${JSON.stringify(build.index, null, 2)}\n`);
    await writeFile(tarTemp, build.tarGz);
    await rename(tarTemp, tarName);
    await rename(indexTemp, indexName);
  } catch (error) {
    await rm(indexTemp, { force: true });
    await rm(tarTemp, { force: true });
    throw error;
  }
  return build;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const outDir = value("--out") ?? process.env.HUB_EXTERNAL_SKILLS_OUT ?? path.resolve(import.meta.dirname, "../../.hub-cache/external-skills");
  const { index, warnings } = await syncExternalSkills({
    fixtureDir: value("--fixture"),
    outDir,
    ref: value("--ref"),
    repo: value("--repo"),
  });
  const typed = index.skills.filter((skill) => skill.type && skill.hardware).length;
  process.stdout.write(
    `Synced ${index.skills.length} external skills from ${index.repo}@${index.commit.slice(0, 8)}\n`
    + `  types and hardware: ${typed}, unknown: ${index.skills.length - typed}\n`
    + `  snapshot: ${outDir}\n`,
  );
  for (const warning of warnings) process.stdout.write(`  warning: ${warning}\n`);
}
