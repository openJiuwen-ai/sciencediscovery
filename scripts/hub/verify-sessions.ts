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
 * Everything a session package must pass before it may be published: a
 * sidecar for every package (and the reverse), required sidecar fields, the
 * 50 MiB limit, checksums against the package manifest, and `related` ids
 * that resolve in the catalog.
 *
 * A failure names the file and the field, because the producer has to fix the
 * drop, not the hub.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { DOMAIN_LABELS, SESSION_TASK_LABELS } from "./category-labels.js";
import { SESSIONS_INDEX, readSessionPackage, validateSidecar } from "./sessions.js";

import type { SessionPackageSummary, SessionSidecar } from "./sessions.js";
import type { RelatedAsset, SessionCategory } from "./types.js";

export const PACKAGE_EXTENSION = ".sdresearch";
export const SIDECAR_EXTENSION = ".json";
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const RELATED_KINDS: Record<keyof RelatedAsset, string[]> = {
  connectors: ["connector"],
  skills: ["skill", "team-skill"],
  specialists: ["specialist"],
};

export interface SessionCatalog {
  /** Asset id to kind, for the ids a sidecar may point at. */
  kinds: Map<string, string>;
}

export interface VerifiedSession {
  bytes: Uint8Array;
  category: SessionCategory;
  id: string;
  packagePath: string;
  sidecar: SessionSidecar;
  sidecarPath: string;
  summary: SessionPackageSummary;
}

export interface VerifiedDrop {
  sessions: VerifiedSession[];
  warnings: string[];
}

export async function loadSessionCatalog(catalogPath: string): Promise<SessionCatalog> {
  let raw: string;
  try {
    raw = await readFile(catalogPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`catalog not found at ${catalogPath}; run pnpm hub:export before publishing sessions`);
    }
    throw error;
  }
  const catalog = JSON.parse(raw) as { assets?: { id?: unknown; kind?: unknown }[] };
  if (!Array.isArray(catalog.assets)) throw new Error(`${catalogPath} is not a hub catalog`);
  const kinds = new Map<string, string>();
  for (const asset of catalog.assets) {
    if (typeof asset.id === "string" && typeof asset.kind === "string") kinds.set(asset.id, asset.kind);
  }
  return { kinds };
}

function resolveRelated(related: RelatedAsset | undefined, catalog: SessionCatalog, sidecar: string): void {
  if (!related) return;
  for (const [key, ids] of Object.entries(related) as [keyof RelatedAsset, string[] | undefined][]) {
    for (const id of ids ?? []) {
      const kind = catalog.kinds.get(id);
      if (!kind) throw new Error(`${sidecar}: field "related.${key}" names "${id}", which is not in the catalog`);
      if (!RELATED_KINDS[key].includes(kind)) {
        throw new Error(`${sidecar}: field "related.${key}" names "${id}", which is a ${kind} in the catalog`);
      }
    }
  }
}

/**
 * Pairs every package with its sidecar before reading anything: a half-dropped
 * package is a mistake in the drop, not something to skip quietly.
 */
async function pairDrop(directory: string): Promise<{ packages: Map<string, string>; sidecars: Map<string, string> }> {
  const packages = new Map<string, string>();
  const sidecars = new Map<string, string>();
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .toSorted();

  for (const entry of entries) {
    if (entry.endsWith(PACKAGE_EXTENSION)) {
      packages.set(entry.slice(0, -PACKAGE_EXTENSION.length), entry);
    } else if (entry.endsWith(SIDECAR_EXTENSION) && entry !== SESSIONS_INDEX) {
      sidecars.set(entry.slice(0, -SIDECAR_EXTENSION.length), entry);
    }
  }
  for (const [id, file] of sidecars) {
    if (!packages.has(id)) throw new Error(`${path.join(directory, file)}: there is no ${id}${PACKAGE_EXTENSION} package`);
  }
  if (!packages.size) throw new Error(`${directory}: no ${PACKAGE_EXTENSION} packages to publish`);
  for (const [id, file] of packages) {
    if (!ID_PATTERN.test(id)) throw new Error(`${path.join(directory, file)}: the id must match ${ID_PATTERN.source}`);
    if (!sidecars.has(id)) throw new Error(`${path.join(directory, file)}: sidecar ${id}${SIDECAR_EXTENSION} is missing`);
  }
  return { packages, sidecars };
}

/** Category ids the site cannot label are dropped rather than rendered as raw slugs. */
function cleanCategory(sidecar: SessionSidecar, sidecarPath: string, warnings: string[]): SessionCategory {
  let { domain, task } = sidecar.category;
  if (task && !SESSION_TASK_LABELS[task]) {
    warnings.push(`${sidecarPath}: unknown category.task "${task}"; the package is filed under uncategorized`);
    task = undefined;
  }
  if (domain && !DOMAIN_LABELS[domain]) {
    warnings.push(`${sidecarPath}: unknown category.domain "${domain}"; the package has no discipline`);
    domain = undefined;
  }
  return {
    source: sidecar.category.source,
    ...(task ? { task } : {}),
    ...(domain ? { domain } : {}),
  };
}

export async function verifySessionDrop(options: { catalogPath: string; sessionsDir: string }): Promise<VerifiedDrop> {
  const catalog = await loadSessionCatalog(options.catalogPath);
  const { packages, sidecars } = await pairDrop(options.sessionsDir);
  const warnings: string[] = [];
  const sessions: VerifiedSession[] = [];

  for (const [id, packageFile] of [...packages].toSorted(([left], [right]) => left.localeCompare(right))) {
    const packagePath = path.join(options.sessionsDir, packageFile);
    const sidecarPath = path.join(options.sessionsDir, sidecars.get(id)!);
    const bytes = new Uint8Array(await readFile(packagePath));

    let summary: SessionPackageSummary;
    try {
      summary = await readSessionPackage(bytes);
    } catch (error) {
      throw new Error(`${packagePath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    let sidecar: SessionSidecar;
    try {
      sidecar = validateSidecar(JSON.parse(await readFile(sidecarPath, "utf8")) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`${sidecarPath}: invalid JSON: ${error.message}`);
      throw new Error(`${sidecarPath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    resolveRelated(sidecar.related, catalog, sidecarPath);
    sessions.push({
      bytes,
      category: cleanCategory(sidecar, sidecarPath, warnings),
      id,
      packagePath,
      sidecar,
      sidecarPath,
      summary,
    });
  }
  return { sessions, warnings };
}
