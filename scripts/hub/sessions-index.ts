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
 * Manual session-package publication: validate, unpack, and rewrite
 * `sessions/index.json`.
 *
 * Publication is all-or-nothing: one bad package aborts before anything is
 * written, so the prefix never advertises a package the hub could not read.
 *
 * The index merges by id into the one already published. A manual run usually
 * delivers only an increment, so entries it does not mention must survive; a
 * package leaves the list only through an explicit `unpublish`, and its
 * uploaded file stays so old links keep working. Without a previous index the
 * drop alone defines the list, which is what a local rebuild expects.
 */

import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { SESSIONS_INDEX, contentsOf, loadSessionIndex } from "./sessions.js";
import { verifySessionDrop } from "./verify-sessions.js";

import type { SessionIndex, SessionIndexEntry } from "./sessions.js";

export interface PublishSessionsOptions {
  /** The exported catalog used to resolve `related` ids. */
  catalogPath: string;
  now?: () => Date;
  /** Receives `sessions/index.json`, `sessions/<id>.sdresearch` and `sessions/<id>/README.md`. */
  outDir: string;
  /**
   * The index that is already published. Entries it lists stay even when this
   * run does not deliver them, because a manual run only ships an increment.
   */
  previousIndex?: SessionIndex;
  /** Drop directory holding `<id>.sdresearch` + `<id>.json`. */
  sessionsDir: string;
  /** Ids to remove from the published index; their files are left in place. */
  unpublish?: string[];
}

export interface PublishSessionsResult {
  /** Ids this run delivered. */
  added: string[];
  entries: SessionIndexEntry[];
  index: SessionIndex;
  indexFile: string;
  /** Entries carried over from the published index. */
  kept: number;
  /** Ids this run removed from the index. */
  unpublished: string[];
  warnings: string[];
}

export async function publishSessions(options: PublishSessionsOptions): Promise<PublishSessionsResult> {
  const now = options.now ?? (() => new Date());
  const publishedAt = now().toISOString();
  const unpublish = [...new Set((options.unpublish ?? []).map((id) => id.trim()).filter(Boolean))];
  // Everything is verified before the first byte is written.
  const { sessions, warnings } = await verifySessionDrop({
    allowEmpty: unpublish.length > 0 || options.previousIndex !== undefined,
    catalogPath: options.catalogPath,
    sessionsDir: options.sessionsDir,
  });
  const added: SessionIndexEntry[] = sessions.map(({ bytes, category, id, sidecar, summary }) => ({
    benchmark: sidecar.benchmark,
    category,
    contents: contentsOf(summary.manifest),
    createdAt: summary.manifest.createdAt,
    description: sidecar.description,
    download: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
      url: `${id}.sdresearch`,
    },
    id,
    name: sidecar.name,
    packageKind: summary.manifest.packageKind,
    producer: summary.manifest.producer,
    publishedAt,
    readme: `${id}/README.md`,
    ...(sidecar.related ? { related: sidecar.related } : {}),
    run: sidecar.run,
  }));

  // Merge by id: the new entry wins, entries this run did not deliver are
  // kept, and unpublishing is a separate, explicit act. This runs before the
  // first write, so a contradictory unpublish leaves the output untouched.
  const addedIds = new Set(added.map((entry) => entry.id));
  const previousIds = new Set(options.previousIndex?.sessions.map((entry) => entry.id) ?? []);
  for (const id of unpublish) {
    if (addedIds.has(id)) throw new Error(`cannot unpublish "${id}": the same publish delivers it`);
    if (!previousIds.has(id)) throw new Error(`cannot unpublish "${id}": it is not in the published index`);
  }
  const kept = (options.previousIndex?.sessions ?? []).filter(
    (entry) => !unpublish.includes(entry.id) && !addedIds.has(entry.id),
  );
  const entries = [...kept, ...added].toSorted((left, right) => left.id.localeCompare(right.id));

  const index: SessionIndex = {
    schemaVersion: 1,
    sessions: entries,
    updatedAt: publishedAt,
  };
  const root = path.join(options.outDir, "sessions");
  await mkdir(root, { recursive: true });
  for (const { bytes, id, sidecar, summary } of sessions) {
    const readme = sidecar.readme ?? summary.readme;
    await mkdir(path.join(root, id), { recursive: true });
    await writeFile(path.join(root, `${id}.sdresearch`), bytes);
    await writeFile(path.join(root, id, "README.md"), readme.endsWith("\n") ? readme : `${readme}\n`);
  }
  const indexFile = path.join(root, SESSIONS_INDEX);
  const temporary = `${indexFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`);
  await rename(temporary, indexFile);
  return {
    added: added.map((entry) => entry.id),
    entries,
    index,
    indexFile,
    kept: kept.length,
    unpublished: unpublish,
    warnings,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const sessionsDir = value("--sessions") ?? path.join(repoRoot, "hub-sessions");
  const outDir = value("--out") ?? path.join(repoRoot, ".hub-cache/sessions-publish");
  const catalogPath = value("--catalog") ?? path.join(repoRoot, "apps/hub/public/catalog.json");
  const previous = value("--previous-index") ?? process.env.HUB_SESSIONS_INDEX_URL;
  const previousIndex = previous
    ? await loadSessionIndex(/^https?:\/\//u.test(previous) ? { url: previous } : { dir: previous })
    : undefined;
  const unpublish = (value("--unpublish") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const { added, index, indexFile, kept, unpublished, warnings } = await publishSessions({
    catalogPath,
    outDir,
    previousIndex,
    sessionsDir,
    unpublish,
  });
  const baseUrl = value("--base-url") ?? process.env.HUB_SESSIONS_BASE_URL ?? "/sessions";
  process.stdout.write(
    `Published ${index.sessions.length} session packages (${added.length} new, ${kept} kept, ${unpublished.length} unpublished)\n`,
  );
  for (const entry of index.sessions.filter((candidate) => added.includes(candidate.id))) {
    process.stdout.write(
      `  ${entry.id}: ${(entry.download.size / 1024 / 1024).toFixed(1)} MiB · ${entry.benchmark.name}/${entry.benchmark.caseId}`
      + ` · ${baseUrl.replace(/\/+$/u, "")}/${entry.download.url}\n`,
    );
  }
  for (const id of unpublished) process.stdout.write(`  unpublished: ${id}\n`);
  process.stdout.write(`  index: ${indexFile}\n`);
  for (const warning of warnings) process.stdout.write(`  warning: ${warning}\n`);
}
