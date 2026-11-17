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

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { zipSync } from "fflate";

// The exporter reads the same parser the runtime uses, from source, so no
// package build has to run before the hub can be generated.
import { BUILT_IN_VERSIONS, parseSkillMarkdown } from "../../packages/specialist/src/skills.js";

import type { SkillAsset, SkillCategory, SkillResource } from "./types.js";

const MAX_SKILL_BYTES = 512 * 1024;

export interface CollectedSkill {
  asset: SkillAsset;
  markdown: string;
  zip: Uint8Array;
}

interface SkillInput {
  categories: Record<string, SkillCategory>;
  repoRoot: string;
  warnings?: string[];
}

const FALLBACK_CATEGORY: SkillCategory = { domain: "research_tools", subdomain: "general_tools" };

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function walk(root: string, relative = ""): Promise<SkillResource[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: SkillResource[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await walk(root, next));
    } else if (entry.isFile()) {
      const info = await stat(path.join(root, next));
      files.push({ path: next, size: info.size });
    }
  }
  return files;
}

function membersOf(frontmatter: Record<string, unknown>): string[] | undefined {
  const raw = frontmatter.members;
  if (!Array.isArray(raw)) return undefined;
  const members = raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return members.length ? members : undefined;
}

export async function collectBuiltinSkills(input: SkillInput): Promise<CollectedSkill[]> {
  const skillsRoot = path.join(input.repoRoot, "skills");
  const directories = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

  const collected: CollectedSkill[] = [];
  for (const id of directories) {
    const dir = path.join(skillsRoot, id);
    const markdownBytes = await readFile(path.join(dir, "SKILL.md"));
    if (markdownBytes.byteLength > MAX_SKILL_BYTES) throw new Error(`skills/${id}/SKILL.md exceeds ${MAX_SKILL_BYTES} bytes`);
    const parsed = parseSkillMarkdown(markdownBytes);
    const frontmatter = parsed.frontmatter;

    const files = await walk(dir);
    const archive: Record<string, Uint8Array> = {};
    for (const file of files) archive[file.path] = await readFile(path.join(dir, file.path));
    // A fixed mtime keeps rebuilds byte-identical, so the published sha256 only
    // changes when the skill itself changes.
    const zip = zipSync(archive, { level: 6, mtime: new Date("1980-01-01T00:00:00Z") });

    const metadata = frontmatter.metadata;
    const metadataVersion = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? asString((metadata as Record<string, unknown>).version)
      : null;
    const version = metadataVersion ?? BUILT_IN_VERSIONS[id as keyof typeof BUILT_IN_VERSIONS] ?? null;
    const teamSkill = frontmatter.kind === "team-skill";
    const members = teamSkill ? membersOf(frontmatter) : undefined;
    if (teamSkill && !members) throw new Error(`skills/${id} declares kind: team-skill without members`);
    let category = input.categories[id];
    if (!category) {
      // An unmapped skill must stay visible rather than break the catalogue.
      input.warnings?.push(`skills/${id} has no entry in scripts/hub/skill-categories.json; filed under research_tools/general_tools`);
      category = FALLBACK_CATEGORY;
    }

    const asset: SkillAsset = {
      author: null,
      category,
      description: asString(frontmatter.description) ?? "",
      download: { sha256: sha256(zip), size: zip.byteLength, url: `packages/${id}-${version ?? "unversioned"}.zip` },
      hardware: null,
      id,
      kind: teamSkill ? "team-skill" : "skill",
      members,
      name: asString(frontmatter.name) ?? id,
      readme: `skills/${id}.md`,
      resources: files.filter((file) => file.path !== "SKILL.md"),
      source: "builtin",
      tags: [],
      type: null,
      version,
    };
    collected.push({ asset, markdown: parsed.instructions, zip });
  }
  return collected;
}

export { sha256 as sha256Bytes };
