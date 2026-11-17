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
 * Projects the repository's asset sources into the static site's data files.
 *
 * Reads only: skills/, packages/specialist/src/builtins.ts,
 * packages/mcp-sources/src/*, extensions_config.json. Writes
 * apps/hub/public/, which is a build artifact and never committed.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { connectorCategories, sessionCategories, skillCategories } from "./categories.js";
import { collectConnectors } from "./connectors.js";
import { collectExternalSkills, loadExternalSnapshot } from "./external-skills.js";
import { collectSessions, loadSessionIndex } from "./sessions.js";
import { collectBuiltinSkills } from "./skills.js";
import { collectSpecialists } from "./specialists.js";

import type { Catalog, SessionAsset, SkillAsset, SkillCategory } from "./types.js";
import type { ExternalSkills } from "./external-skills.js";

export interface ExportResult {
  catalog: Catalog;
  outDir: string;
  warnings: string[];
}

export interface ExportOptions {
  externalSkillsDir?: string;
  externalSkillsUrl?: string;
  outDir?: string;
  repoRoot?: string;
  sessionsBaseUrl?: string;
  sessionsDir?: string;
  sessionsUrl?: string;
}

async function loadExternal(options: ExportOptions): Promise<ExternalSkills | null> {
  const dir = options.externalSkillsDir ?? process.env.HUB_EXTERNAL_SKILLS_DIR;
  const url = options.externalSkillsUrl ?? process.env.HUB_EXTERNAL_SKILLS_URL;
  if (!dir && !url) return null;
  const snapshot = await loadExternalSnapshot(dir ? { dir } : { url: url! });
  return collectExternalSkills(snapshot);
}

interface Sessions {
  assets: SessionAsset[];
  updatedAt: string | null;
}

/**
 * Only the published `sessions/index.json` is read here. A missing index means
 * the site has never published a package, which is not a build failure.
 */
async function loadSessions(options: ExportOptions): Promise<Sessions | null> {
  const dir = options.sessionsDir ?? process.env.HUB_SESSIONS_DIR;
  const url = options.sessionsUrl ?? process.env.HUB_SESSIONS_INDEX_URL;
  if (!dir && !url) return null;
  const index = await loadSessionIndex(dir ? { dir } : { url: url! });
  const baseUrl = options.sessionsBaseUrl ?? process.env.HUB_SESSIONS_BASE_URL ?? "/sessions";
  return { assets: collectSessions(index, baseUrl), updatedAt: index.updatedAt };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeFileAt(root: string, relative: string, bytes: Uint8Array | string): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

export async function exportHub(options: ExportOptions = {}): Promise<ExportResult> {
  const repoRoot = options.repoRoot ?? path.resolve(import.meta.dirname, "../..");
  const outDir = options.outDir ?? path.join(repoRoot, "apps/hub/public");
  // Load the frozen snapshot and the published session index before touching
  // the output: a missing or corrupt source must leave the previous export
  // (and the published site) alone.
  const external = await loadExternal(options);
  const sessions = await loadSessions(options);
  for (const directory of ["connectors", "packages", "skills", "specialists"]) {
    await rm(path.join(outDir, directory), { force: true, recursive: true });
  }
  await mkdir(outDir, { recursive: true });

  const skillCategoryMap = await readJson<Record<string, SkillCategory>>(path.join(repoRoot, "scripts/hub/skill-categories.json"));
  const connectorFunctionMap = await readJson<Record<string, string>>(path.join(repoRoot, "scripts/hub/connector-functions.json"));

  const warnings: string[] = [];
  const skills = await collectBuiltinSkills({ categories: skillCategoryMap, repoRoot, warnings });
  const specialists = collectSpecialists();
  const connectors = await collectConnectors({ functions: connectorFunctionMap, repoRoot });

  const specialistSkills = new Map(specialists.map((entry) => [entry.asset.id, entry.asset.skills]));
  const specialistIds = new Map(specialists.map((entry) => [entry.asset.name, entry.asset.id]));
  for (const { asset } of specialists) {
    asset.related = { connectors: asset.connectors, skills: asset.skills };
  }

  const skillAssets: SkillAsset[] = [
    ...skills.map((entry) => entry.asset),
    ...(external?.assets.map((entry) => entry.asset) ?? []),
  ];
  const outputs = new Map<string, string>();
  const claim = (url: string, owner: string): void => {
    const existing = outputs.get(url);
    if (existing) throw new Error(`assets ${existing} and ${owner} both produce ${url}`);
    outputs.set(url, owner);
  };
  for (const { asset } of skills) {
    claim(asset.download.url, asset.id);
    claim(asset.readme, asset.id);
  }
  for (const { asset } of external?.assets ?? []) {
    claim(asset.download.url, asset.id);
    claim(asset.readme, asset.id);
  }
  for (const { asset } of specialists) {
    claim(asset.download.url, asset.id);
    claim(asset.download.text, asset.id);
  }
  for (const { asset } of connectors) claim(asset.download.url, asset.id);

  for (const { asset, markdown, zip } of skills) {
    // Team frontmatter names specialists the way a person would; the catalog
    // links by id, so resolve here and fail rather than publish a name the
    // site cannot follow.
    const members = asset.members?.map((name) => {
      const id = specialistIds.get(name);
      if (!id) throw new Error(`skills/${asset.id} names unknown specialist ${name}`);
      return id;
    });
    asset.members = members;
    const relatedSpecialists = members
      ?? specialists
        .filter((specialist) => specialist.asset.skills.includes(asset.id))
        .map((specialist) => specialist.asset.id);
    const relatedSkills = members
      ? [...new Set(members.flatMap((member) => specialistSkills.get(member) ?? []))]
      : [];
    asset.related = { specialists: relatedSpecialists, skills: relatedSkills };
    await writeFileAt(outDir, asset.readme, `${markdown}\n`);
    await writeFileAt(outDir, asset.download.url, zip);
  }
  for (const { asset, markdown, zip } of external?.assets ?? []) {
    await writeFileAt(outDir, asset.readme, `${markdown}\n`);
    await writeFileAt(outDir, asset.download.url, zip);
  }
  for (const { asset, json, markdown } of specialists) {
    await writeFileAt(outDir, asset.download.url, json);
    await writeFileAt(outDir, asset.download.text, markdown);
  }
  for (const { asset, json } of connectors) {
    await writeFileAt(outDir, asset.download.url, json);
  }

  const sessionAssets = sessions?.assets ?? [];
  const catalog: Catalog = {
    assets: [
      ...skillAssets,
      ...specialists.map((entry) => entry.asset),
      ...connectors.map((entry) => entry.asset),
      ...sessionAssets,
    ],
    categories: {
      connector: connectorCategories(connectors.map((entry) => entry.asset)),
      sessionPackage: sessionCategories(sessionAssets),
      skill: skillCategories(skillAssets),
    },
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    sources: {
      ...(external
        ? {
          externalSkills: {
            commit: external.index.commit,
            fetchedAt: external.index.fetchedAt,
            ref: external.index.ref,
            repo: external.index.repo,
          },
        }
        : {}),
      ...(sessions
        ? { sessions: { count: sessionAssets.length, updatedAt: sessions.updatedAt } }
        : {}),
    },
  };
  warnings.push(...external?.warnings ?? []);
  await writeFileAt(outDir, "catalog.json", `${JSON.stringify(catalog, null, 2)}\n`);
  return { catalog, outDir, warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const { catalog, outDir, warnings } = await exportHub();
  const count = (kind: string): number => catalog.assets.filter((asset) => asset.kind === kind).length;
  const external = catalog.assets.filter((asset) => asset.source === "mindscience").length;
  const source = catalog.sources.externalSkills;
  process.stdout.write(
    `Exported ${catalog.assets.length} assets to ${outDir}\n`
    + `  skills: ${count("skill")} (${external} from MindScienceSkills), team skills: ${count("team-skill")}, `
    + `specialists: ${count("specialist")}, connectors: ${count("connector")}, session packages: ${count("session-package")}\n`
    + (source ? `  external snapshot: ${source.repo}@${source.commit.slice(0, 8)} (${source.fetchedAt})\n` : ""),
  );
  for (const warning of warnings) process.stdout.write(`  warning: ${warning}\n`);
}
