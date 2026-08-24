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
 * The two processes share one filesystem and one data dir, so the sidecar
 * writes and this reads; there is no protocol between them beyond the layout,
 * which is content-addressed and therefore has nothing to agree about but the
 * hash. `services/evolve/src/sciencediscovery_evolve/candidates.py` is the writer.
 *
 * Not the CAS: a candidate is not an artifact. Most are refused, and copying
 * every one into content-addressed storage would fill it with programs nobody
 * keeps. The copy happens when a user saves one.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Rejects anything that is not a bare sha256 hex digest, with or without the
 *  algorithm prefix the event stream uses. The value reaches a path join, so
 *  this is the check that keeps `../` out of it. */
const HASH = /^(?:sha256:)?([a-f0-9]{64})$/;

export class CandidateSources {
  private readonly root: string;

  constructor(dataDir: string, override?: string) {
    this.root = override ?? resolve(dataDir, "evolve-candidates");
  }

  async read(runId: string, hash: string): Promise<string | undefined> {
    const digest = HASH.exec(hash)?.[1];
    // A run id reaches the path too. Both halves are validated here rather than
    // at the route, so a second caller cannot forget.
    if (!digest || !/^[A-Za-z0-9_-]{1,200}$/.test(runId)) return undefined;
    try {
      return await readFile(resolve(this.root, runId, `${digest}.py`), "utf-8");
    } catch {
      // Missing is the ordinary case (a pruned run, a hash from another run);
      // unreadable is not, but the caller can do nothing different about it.
      return undefined;
    }
  }
}
