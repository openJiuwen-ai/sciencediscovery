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
 * Guards the numbers behind the side-table split, not a stopwatch reading.
 *
 * On the catalog this change was measured on (71k file records, 73k revisions,
 * 39 subagents) `catalog_state` was 106 MB and every save stringified and wrote
 * all of it. The row is now about 14 KB on this fixture and stays that size as
 * provenance grows, and a save costs the same on a large catalog as on an
 * empty one. Both assertions are about that shape: an absolute millisecond
 * budget belongs to the machine, a ratio does not.
 */

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";

import { SessionStore } from "./store.js";

const REVISIONS = 3_000;

async function fixture(context: TestContext) {
  const root = resolve(process.cwd(), ".tmp", `catalog-performance-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  const store = new SessionStore(root);
  context.after(async () => { store.close(); await rm(root, { force: true, recursive: true }); });
  await store.load();
  const model = await store.createModel({
    apiToken: "performance-token",
    baseUrl: "https://models.example.test/v1",
    model: "science-model",
    name: "Performance model",
  });
  const project = await store.createProject("Performance", { modelId: model.id, reviewModelId: model.id });
  const session = await store.createSession(project.id, "Session");
  return { root, session, store };
}

/** The catalog row, read beside the live connection the way an operator would
 *  inspect the database. */
function catalogRow(root: string): { bytes: number; json: string } {
  const database = new DatabaseSync(resolve(root, "catalog.sqlite"));
  try {
    const row = database.prepare("SELECT json FROM catalog_state WHERE id = 1").get() as { json: string };
    return { bytes: Buffer.byteLength(row.json), json: row.json };
  } finally {
    database.close();
  }
}

/** The rows that used to be part of that row. */
function sideTables(root: string): { bytes: number; files: number; revisions: number } {
  const database = new DatabaseSync(resolve(root, "catalog.sqlite"));
  try {
    const row = database.prepare(`
      SELECT (SELECT coalesce(sum(length(record_json)), 0) FROM workspace_files)
           + (SELECT coalesce(sum(length(revision_json)), 0) FROM workspace_file_revisions)
           + (SELECT coalesce(sum(length(subagent_json)), 0) FROM subagents) AS bytes
    `).get() as { bytes: number };
    const files = (database.prepare("SELECT count(*) AS n FROM workspace_files").get() as { n: number }).n;
    const revisions = (database.prepare("SELECT count(*) AS n FROM workspace_file_revisions").get() as { n: number }).n;
    return { bytes: Number(row.bytes), files: Number(files), revisions: Number(revisions) };
  } finally {
    database.close();
  }
}

/** Median of one catalog save, measured through a mutation that does nothing
 *  but change one string: the cost is the row, not the change. */
async function saveLatency(store: SessionStore, sessionId: string, rounds: number): Promise<number> {
  const samples: number[] = [];
  let title = store.getSession(sessionId)!.title;
  for (let index = 0; index < rounds; index += 1) {
    const nextTitle = `${title}x`;
    const started = process.hrtime.bigint();
    await store.compareAndSetSessionTitle(sessionId, title, nextTitle);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    title = nextTitle;
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)]!;
}

function revisionsInputs(): Array<{ mode: "write"; modifiedAt: string; origin: "agent"; path: string; size: number }> {
  const modifiedAt = new Date().toISOString();
  return Array.from({ length: REVISIONS }, (_, index) => ({
    mode: "write" as const,
    modifiedAt,
    origin: "agent" as const,
    path: `data/file-${index}.md`,
    size: 12,
  }));
}

test("the catalog row does not grow with the provenance stored beside it", async (context) => {
  const { root, session, store } = await fixture(context);
  const before = catalogRow(root);

  await store.recordWorkspaceFileRevisions(session.id, revisionsInputs());
  const after = catalogRow(root);

  assert.ok(
    after.bytes - before.bytes < 256,
    `${REVISIONS} revisions added ${after.bytes - before.bytes} B to the catalog row`,
  );
  assert.ok(after.bytes < 64 * 1_024, `the catalog row is ${after.bytes} B`);
  assert.ok(
    !after.json.includes("data/file-2999.md"),
    "the last recorded path is in its own table, not in the catalog row",
  );

  const side = sideTables(root);
  assert.equal(side.files, REVISIONS, "every record has a row of its own");
  assert.equal(side.revisions, REVISIONS, "every revision has a row of its own");
  assert.ok(
    side.bytes > after.bytes * 10,
    `the rows now carry the provenance (${side.bytes} B beside a ${after.bytes} B row)`,
  );
});

test("a catalog save costs the same on a large catalog as on an empty one", async (context) => {
  const { session, store } = await fixture(context);
  const empty = await saveLatency(store, session.id, 40);

  await store.recordWorkspaceFileRevisions(session.id, revisionsInputs());
  const grown = await saveLatency(store, session.id, 40);

  // The pre-split row carried every row of provenance, so this save serialized
  // and wrote all of it: 0.9 s on the live catalog, and about 28 ms for this
  // fixture's 3,000 revisions. The bound is deliberately loose — 10x the empty
  // catalog's own median, and never below 10 ms — so a slow or busy machine
  // cannot make it flake; an O(rows) save misses it by a wide margin.
  assert.ok(
    grown <= Math.max(10, empty * 10),
    `an empty catalog saves in ${empty.toFixed(3)} ms, one with ${REVISIONS} revisions in ${grown.toFixed(3)} ms`,
  );
});
