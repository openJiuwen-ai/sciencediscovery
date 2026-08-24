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
 * Reading a candidate's source, from the angle that matters: both halves of the
 * lookup come off the wire and both land in a path join.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, test } from "node:test";

import { CandidateSources } from "./candidates.js";

const DIGEST = "a".repeat(64);

async function store(): Promise<{ root: string; sources: CandidateSources }> {
  const root = await mkdtemp(resolve(tmpdir(), "evolve-candidates-"));
  await mkdir(resolve(root, "run-1"), { recursive: true });
  await writeFile(resolve(root, "run-1", `${DIGEST}.py`), "def train_and_predict(a, b): ...", "utf-8");
  return { root, sources: new CandidateSources("/unused", root) };
}

test("a candidate is found by the hash the event stream carries", async () => {
  const { sources } = await store();

  // With and without the algorithm prefix: the events use `sha256:<hex>` and
  // the store is keyed by the bare digest.
  assert.match(await sources.read("run-1", DIGEST) ?? "", /train_and_predict/);
  assert.match(await sources.read("run-1", `sha256:${DIGEST}`) ?? "", /train_and_predict/);
});

test("a hash that is not a hash cannot reach the filesystem", async () => {
  const { sources } = await store();

  // Both halves of the lookup come off the wire, so both are checked here
  // rather than at the route, where a second caller could forget.
  for (const hash of ["../../etc/passwd", "..", `${DIGEST}/../../x`, "sha256:zz", ""]) {
    assert.equal(await sources.read("run-1", hash), undefined, hash);
  }
  for (const runId of ["../run-1", "run-1/..", "/etc", ""]) {
    assert.equal(await sources.read(runId, DIGEST), undefined, runId);
  }
});

test("a hash this run never wrote is absent, not an error", async () => {
  const { sources } = await store();
  // The ordinary case: a pruned run, or a hash from another search.
  assert.equal(await sources.read("run-1", "b".repeat(64)), undefined);
  assert.equal(await sources.read("run-missing", DIGEST), undefined);
});
