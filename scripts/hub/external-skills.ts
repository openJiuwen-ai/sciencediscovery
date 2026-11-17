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
 * Turns a frozen MindScienceSkills snapshot into catalog assets.
 *
 * The site never talks to GitCode at build time: the snapshot is downloaded
 * once (or read from disk while developing), unpacked in memory, and every
 * SKILL.md ships byte for byte inside its package.
 */

import { createHash } from "node:crypto";
import { gunzipSync, zipSync } from "fflate";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { DOMAIN_LABELS, SUBDOMAIN_LABELS } from "./category-labels.js";
import { SNAPSHOT_INDEX, SNAPSHOT_TARBALL } from "./sync-external-skills.js";
import { unpackTar } from "./tar.js";

import type { ExternalIndex } from "./sync-external-skills.js";
import type { SkillAsset } from "./types.js";

import { parseSkillMarkdown } from "../../packages/specialist/src/skills.js";

export interface LoadedSnapshot {
  index: ExternalIndex;
  files: Map<string, Uint8Array>;
}

export interface ExternalSkill {
  asset: SkillAsset;
  markdown: string;
  zip: Uint8Array;
}

export interface ExternalSkills {
  assets: ExternalSkill[];
  index: ExternalIndex;
  warnings: string[];
}

const FALLBACK_DOMAIN = "research_tools";
const FALLBACK_SUBDOMAIN = "general_tools";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function authorOf(frontmatter: Record<string, unknown>): string | null {
  const direct = asString(frontmatter.author);
  if (direct) return direct;
  const metadata = frontmatter.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return asString((metadata as Record<string, unknown>)["skill-author"])
      ?? asString((metadata as Record<string, unknown>).author);
  }
  return null;
}

function validateIndex(raw: string): ExternalIndex {
  const index = JSON.parse(raw) as ExternalIndex;
  if (index.schemaVersion !== 1) throw new Error(`external snapshot schemaVersion ${String(index.schemaVersion)} is not supported`);
  if (!index.commit || !Array.isArray(index.skills)) throw new Error("external snapshot index is incomplete");
  const seen = new Set<string>();
  for (const skill of index.skills) {
    const segments = skill.path.split("/");
    if (segments.length !== 3 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error(`external snapshot has an unsafe skill path: ${skill.path}`);
    }
    if (seen.has(skill.path)) throw new Error(`external snapshot lists ${skill.path} twice`);
    seen.add(skill.path);
    if (!/^[0-9a-f]{64}$/.test(skill.sha256)) throw new Error(`external snapshot has a bad sha256 for ${skill.path}`);
  }
  return index;
}

export async function loadExternalSnapshot(source: { dir: string } | { url: string }): Promise<LoadedSnapshot> {
  let indexBytes: Uint8Array;
  let tarGz: Uint8Array;
  if ("dir" in source) {
    indexBytes = await readFile(path.join(source.dir, SNAPSHOT_INDEX));
    tarGz = await readFile(path.join(source.dir, SNAPSHOT_TARBALL));
  } else {
    const base = source.url.replace(/\/+$/, "");
    const signal = AbortSignal.timeout(120_000);
    const [indexResponse, tarResponse] = await Promise.all([
      fetch(`${base}/${SNAPSHOT_INDEX}`, { signal }),
      fetch(`${base}/${SNAPSHOT_TARBALL}`, { signal }),
    ]);
    if (!indexResponse.ok) throw new Error(`external snapshot index download failed: ${indexResponse.status} ${base}`);
    if (!tarResponse.ok) throw new Error(`external snapshot download failed: ${tarResponse.status} ${base}`);
    indexBytes = new Uint8Array(await indexResponse.arrayBuffer());
    tarGz = new Uint8Array(await tarResponse.arrayBuffer());
  }
  const index = validateIndex(new TextDecoder("utf-8", { fatal: true }).decode(indexBytes));
  return { files: unpackTar(gunzipSync(tarGz)), index };
}

/** `<subdomain>-<name>.zip`, disambiguated by domain only if two skills collide. */
function packageNames(skills: ExternalIndex["skills"]): Map<string, string> {
  const base = skills.map((skill) => {
    const [, subdomain, name] = skill.path.split("/");
    return { path: skill.path, slug: `${subdomain}-${name}.zip` };
  });
  const counts = new Map<string, number>();
  for (const entry of base) counts.set(entry.slug, (counts.get(entry.slug) ?? 0) + 1);
  return new Map(base.map((entry) => [
    entry.path,
    counts.get(entry.slug)! > 1 ? `${entry.slug.slice(0, -4)}-${entry.path.split("/")[0]}.zip` : entry.slug,
  ]));
}

export function collectExternalSkills(snapshot: LoadedSnapshot): ExternalSkills {
  const warnings: string[] = [];
  const names = packageNames(snapshot.index.skills);
  const day = snapshot.index.fetchedAt.slice(0, 10).replace(/-/g, "");
  const version = `snapshot-${day}`;
  const assets: ExternalSkill[] = [];

  for (const entry of [...snapshot.index.skills].toSorted((left, right) => left.path.localeCompare(right.path))) {
    const bytes = snapshot.files.get(`${entry.path}/SKILL.md`);
    if (!bytes) throw new Error(`external snapshot is missing ${entry.path}/SKILL.md`);
    if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) {
      throw new Error(`external snapshot bytes do not match the index for ${entry.path}`);
    }
    const parsed = parseSkillMarkdown(Buffer.from(bytes));
    const frontmatter = parsed.frontmatter;
    const [rawDomain, rawSubdomain] = entry.path.split("/") as [string, string, string];
    let domain = rawDomain;
    let subdomain = rawSubdomain;
    if (!DOMAIN_LABELS[domain] || !SUBDOMAIN_LABELS[subdomain]) {
      warnings.push(`${entry.path}: unknown category; filed under ${FALLBACK_DOMAIN}/${FALLBACK_SUBDOMAIN}`);
      domain = FALLBACK_DOMAIN;
      subdomain = FALLBACK_SUBDOMAIN;
    }
    const zip = zipSync({ "SKILL.md": bytes }, { level: 6, mtime: new Date("1980-01-01T00:00:00Z") });
    assets.push({
      asset: {
        author: authorOf(frontmatter),
        category: { domain, subdomain },
        description: asString(frontmatter.description) ?? "",
        download: {
          sha256: sha256(zip),
          size: zip.byteLength,
          url: `packages/${names.get(entry.path)!}`,
        },
        hardware: entry.hardware,
        id: entry.path,
        kind: "skill",
        name: asString(frontmatter.name) ?? entry.path.split("/")[2]!,
        readme: `skills/external/${entry.path}.md`,
        resources: [],
        source: "mindscience",
        tags: [],
        type: entry.type,
        version,
      },
      markdown: parsed.instructions,
      zip,
    });
  }
  return { assets, index: snapshot.index, warnings };
}
