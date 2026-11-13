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
 * The per-revision trajectory sizing cache (#1140 §7.4).
 *
 * What this pins is narrow and deliberate: the replay branch reads the map it is
 * handed, and only for the walk shape it was recorded under. It does **not**
 * observe `readTrajectoryDetail` not being called — that closure is not exported
 * and its reader is built inside `buildResearchPackageInput`, so there is no seam
 * to spy on. A seeded map entry that cannot exist for an empty trajectory is the
 * signal instead: if the branch were not taken, the number would be zero.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { SessionStore } from "./store.js";
import { createResearchSnapshots } from "./research-snapshots.js";

/** A value no real trajectory of an empty session can produce. */
const FABRICATED_BYTES = 1_000_000;

/**
 * Just enough of the platform ports for a session with no runs, no memory graph
 * and no evolve history: the preview reads the store, and the recorder only has
 * to expose the CAS it would stream from.
 */
async function snapshotsFor(root: string, store: SessionStore) {
  return createResearchSnapshots({
    store,
    evolutionStore: {} as never,
    evolveCandidates: {} as never,
    memoryGraphClient: { snapshotRevision: async () => "" } as never,
    memoryGraphEnabled: () => false,
    provenanceRecorder: { cas: { stream: async function* () {}, read: async () => Buffer.alloc(0) } } as never,
  }, async () => true);
}

/** The preview sizing object the service builds per request (research-snapshots.ts). */
function sizing(seeded?: Map<string, unknown>) {
  return {
    objectSizes: new Map<string, number>(), additionalRecordBytes: 0,
    hashes: new Set<string>(), refs: new Map(),
    jsonSizes: new WeakMap<object, number>(), casVisited: new WeakSet<object>(), refsVisited: new WeakSet<object>(),
    ...(seeded ? { trajectorySizing: seeded } : {}),
  } as never;
}

async function sessionFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "preview-replay-"));
  const store = new SessionStore(root); store.setAvailableSkillIds([]); await store.load();
  const project = await store.createProject("replay");
  const session = await store.createSession(project.id, "replay", {}, {}, { allowUnconfiguredModel: true });
  const snapshots = await snapshotsFor(root, store);
  return { root, store, project, session, snapshots };
}

test("a seeded full-trajectory sizing entry is what the preview adds, not the records", async (t) => {
  const f = await sessionFixture();
  try {
    const seeded = new Map([["full:" + f.session.id, [
      { bytes: FABRICATED_BYTES, hashes: [], id: "fabricated-entry", refs: [] },
    ]]]);
    const replayed = sizing(seeded);
    await f.snapshots.buildResearchPackageInput(f.project.id, f.session.id, "complete", undefined, undefined,
      replayed, true, false);
    assert.equal((replayed as { additionalRecordBytes: number }).additionalRecordBytes, FABRICATED_BYTES,
      "the replay branch adds the number it finds in the map, so the map is the source");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("without a seeded entry the same session adds nothing, so the value above came from the map", async (t) => {
  // The reverse of the case above: this session has no trajectory records at all,
  // so a walk of its own would contribute zero. Reading FABRICATED_BYTES in the
  // first case therefore cannot have come from walking anything.
  const f = await sessionFixture();
  try {
    const empty = sizing(new Map());
    await f.snapshots.buildResearchPackageInput(f.project.id, f.session.id, "complete", undefined, undefined,
      empty, true, false);
    assert.equal((empty as { additionalRecordBytes: number }).additionalRecordBytes, 0,
      "an empty cache means no recorded trajectory bytes for a session that has none");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a summary-shaped entry does not feed a full-trajectory walk", async (t) => {
  // The defect the reviewers caught: one key per session let a summarized walk
  // hand its smaller numbers to a full one. The key is per walk shape now, so a
  // `summary:` entry must be ignored by the `full:` walk.
  const f = await sessionFixture();
  try {
    const wrongShape = new Map([["summary:" + f.session.id, [
      { bytes: FABRICATED_BYTES, hashes: [], id: "fabricated-entry", refs: [] },
    ]]]);
    const preview = sizing(wrongShape);
    await f.snapshots.buildResearchPackageInput(f.project.id, f.session.id, "complete", undefined, undefined,
      preview, true, false);
    assert.equal((preview as { additionalRecordBytes: number }).additionalRecordBytes, 0,
      "a summarized entry is not replayed into a full-trajectory walk");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
