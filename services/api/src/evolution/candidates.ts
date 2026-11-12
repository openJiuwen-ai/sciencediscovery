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
 * Reading the candidate sources the sidecar wrote.
 *
 * The sidecar and research-package importer share one filesystem and one data
 * dir. Candidate paths are content-addressed, so both writers have only the
 * run id and hash to agree on. `services/evolve/src/sciencediscovery_evolve/
 * candidates.py` is the normal writer.
 *
 * Not the CAS: a candidate is not an artifact. Most are refused, and copying
 * every one into content-addressed storage would fill it with programs nobody
 * keeps. The copy happens when a user saves one.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Rejects anything that is not a bare sha256 hex digest, with or without the
 *  algorithm prefix the event stream uses. The value reaches a path join, so
 *  this is the check that keeps `../` out of it. */
const HASH = /^(?:sha256:)?([a-f0-9]{64})$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,200}$/;

function candidatePath(root: string, runId: string, hash: string): string | undefined {
  const digest = HASH.exec(hash)?.[1];
  if (!digest || !RUN_ID.test(runId)) return undefined;
  return resolve(root, runId, `${digest}.py`);
}

function sourceHash(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export class CandidateSources {
  private readonly root: string;

  constructor(dataDir: string, override?: string) {
    this.root = override ?? resolve(dataDir, "evolve-candidates");
  }

  async read(runId: string, hash: string): Promise<string | undefined> {
    // A run id reaches the path too. Both halves are validated here rather than
    // at the route, so a second caller cannot forget.
    const path = candidatePath(this.root, runId, hash);
    if (!path) return undefined;
    try {
      return await readFile(path, "utf-8");
    } catch {
      // Missing is the ordinary case (a pruned run, a hash from another run);
      // unreadable is not, but the caller can do nothing different about it.
      return undefined;
    }
  }

  /** All candidate sources still retained for one run. Package export uses this
   *  instead of guessing hashes from an event log, which can outlive pruning. */
  async list(runId: string): Promise<Array<{ hash: string; source: string }>> {
    if (!RUN_ID.test(runId)) return [];
    let names: string[];
    try { names = await readdir(resolve(this.root, runId)); }
    catch { return []; }
    const sources = await Promise.all(names.toSorted().flatMap((name) => {
      const match = /^([a-f0-9]{64})\.py$/u.exec(name);
      return match ? [this.read(runId, match[1]!).then((source) => source === undefined || sourceHash(source) !== match[1] ? undefined : { hash: `sha256:${match[1]}`, source })] : [];
    }));
    return sources.filter((source): source is { hash: string; source: string } => source !== undefined);
  }

  /** Restore a package's candidate source without allowing package paths to
   *  escape the sidecar-owned candidate directory. */
  async write(runId: string, hash: string, source: string): Promise<boolean> {
    const digest = HASH.exec(hash)?.[1];
    const path = candidatePath(this.root, runId, hash);
    if (!path || !digest || typeof source !== "string" || sourceHash(source) !== digest) return false;
    await mkdir(resolve(this.root, runId), { recursive: true });
    await writeFile(path, source, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      // The name is the digest of the content, so an existing file that does not
      // hash to it is a leftover from a crash or a partial import: replacing it
      // is the repair. Accepting whatever is there reported a truncated file as
      // restored while the reader got bytes that never hashed to its name.
      const existing = await readFile(path, "utf-8").catch(() => undefined);
      if (existing === source) return;
      await writeFile(path, source);
    });
    return true;
  }
}
