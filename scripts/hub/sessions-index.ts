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
 * Removing a package from the drop directory removes its index entry on the
 * next publish, but its uploaded file is left in place so old links keep
 * working.
 */

import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { SESSIONS_INDEX, contentsOf } from "./sessions.js";
import { verifySessionDrop } from "./verify-sessions.js";

import type { SessionIndex, SessionIndexEntry } from "./sessions.js";

export interface PublishSessionsOptions {
  /** The exported catalog used to resolve `related` ids. */
  catalogPath: string;
  now?: () => Date;
  /** Receives `sessions/index.json`, `sessions/<id>.sdresearch` and `sessions/<id>/README.md`. */
  outDir: string;
  /** Drop directory holding `<id>.sdresearch` + `<id>.json`. */
  sessionsDir: string;
}

export interface PublishSessionsResult {
  entries: SessionIndexEntry[];
  index: SessionIndex;
  indexFile: string;
  warnings: string[];
}

export async function publishSessions(options: PublishSessionsOptions): Promise<PublishSessionsResult> {
  const now = options.now ?? (() => new Date());
  const publishedAt = now().toISOString();
  // Everything is verified before the first byte is written.
  const { sessions, warnings } = await verifySessionDrop(options);
  const entries: SessionIndexEntry[] = [];

  for (const { bytes, category, id, sidecar, summary } of sessions) {
    const packageFile = `${id}.sdresearch`;
    const readme = sidecar.readme ?? summary.readme;
    const root = path.join(options.outDir, "sessions");
    await mkdir(path.join(root, id), { recursive: true });
    await writeFile(path.join(root, packageFile), bytes);
    await writeFile(path.join(root, id, "README.md"), readme.endsWith("\n") ? readme : `${readme}\n`);

    entries.push({
      benchmark: sidecar.benchmark,
      category,
      contents: contentsOf(summary.manifest),
      createdAt: summary.manifest.createdAt,
      description: sidecar.description,
      download: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
        url: packageFile,
      },
      id,
      name: sidecar.name,
      packageKind: summary.manifest.packageKind,
      producer: summary.manifest.producer,
      publishedAt,
      readme: `${id}/README.md`,
      ...(sidecar.related ? { related: sidecar.related } : {}),
      run: sidecar.run,
    });
  }

  const index: SessionIndex = {
    schemaVersion: 1,
    sessions: entries,
    updatedAt: publishedAt,
  };
  const root = path.join(options.outDir, "sessions");
  await mkdir(root, { recursive: true });
  const indexFile = path.join(root, SESSIONS_INDEX);
  const temporary = `${indexFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`);
  await rename(temporary, indexFile);
  return { entries, index, indexFile, warnings };
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
  const { index, indexFile, warnings } = await publishSessions({ catalogPath, outDir, sessionsDir });
  const baseUrl = value("--base-url") ?? process.env.HUB_SESSIONS_BASE_URL ?? "/sessions";
  process.stdout.write(`Published ${index.sessions.length} session packages\n`);
  for (const entry of index.sessions) {
    process.stdout.write(
      `  ${entry.id}: ${(entry.download.size / 1024 / 1024).toFixed(1)} MiB · ${entry.benchmark.name}/${entry.benchmark.caseId}`
      + ` · ${baseUrl.replace(/\/+$/u, "")}/${entry.download.url}\n`,
    );
  }
  process.stdout.write(`  index: ${indexFile}\n`);
  for (const warning of warnings) process.stdout.write(`  warning: ${warning}\n`);
}
