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
import { collectBuiltinSkills } from "./skills.js";
import { collectSpecialists } from "./specialists.js";

import type { Catalog, SkillCategory } from "./types.js";

export interface ExportResult {
  catalog: Catalog;
  outDir: string;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeFileAt(root: string, relative: string, bytes: Uint8Array | string): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

export async function exportHub(options: { outDir?: string; repoRoot?: string } = {}): Promise<ExportResult> {
  const repoRoot = options.repoRoot ?? path.resolve(import.meta.dirname, "../..");
  const outDir = options.outDir ?? path.join(repoRoot, "apps/hub/public");
  for (const directory of ["connectors", "packages", "skills", "specialists"]) {
    await rm(path.join(outDir, directory), { force: true, recursive: true });
  }
  await mkdir(outDir, { recursive: true });

  const skillCategoryMap = await readJson<Record<string, SkillCategory>>(path.join(repoRoot, "scripts/hub/skill-categories.json"));
  const connectorFunctionMap = await readJson<Record<string, string>>(path.join(repoRoot, "scripts/hub/connector-functions.json"));

  const skills = await collectBuiltinSkills({ categories: skillCategoryMap, repoRoot });
  const specialists = collectSpecialists();
  const connectors = await collectConnectors({ functions: connectorFunctionMap, repoRoot });

  const specialistSkills = new Map(specialists.map((entry) => [entry.asset.id, entry.asset.skills]));
  const specialistIds = new Map(specialists.map((entry) => [entry.asset.name, entry.asset.id]));
  for (const { asset } of specialists) {
    asset.related = { connectors: asset.connectors, skills: asset.skills };
  }
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
  for (const { asset, json, markdown } of specialists) {
    await writeFileAt(outDir, asset.download.url, json);
    await writeFileAt(outDir, asset.download.text, markdown);
  }
  for (const { asset, json } of connectors) {
    await writeFileAt(outDir, asset.download.url, json);
  }

  const catalog: Catalog = {
    assets: [...skills.map((entry) => entry.asset), ...specialists.map((entry) => entry.asset), ...connectors.map((entry) => entry.asset)],
    categories: {
      connector: connectorCategories(connectors.map((entry) => entry.asset)),
      sessionPackage: sessionCategories([]),
      skill: skillCategories(skills.map((entry) => entry.asset)),
    },
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    sources: {},
  };
  await writeFileAt(outDir, "catalog.json", `${JSON.stringify(catalog, null, 2)}\n`);
  return { catalog, outDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const { catalog, outDir } = await exportHub();
  const count = (kind: string): number => catalog.assets.filter((asset) => asset.kind === kind).length;
  process.stdout.write(
    `Exported ${catalog.assets.length} assets to ${outDir}\n`
    + `  skills: ${count("skill")}, team skills: ${count("team-skill")}, `
    + `specialists: ${count("specialist")}, connectors: ${count("connector")}\n`,
  );
}
