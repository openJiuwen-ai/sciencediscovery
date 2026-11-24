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
 * Regression coverage for #1365.
 *
 * The defect was not wrong output: a 189 KB `necessary` package was correct and
 * took 38 s because the exporter first materialised every run event and then
 * walked the same streams again for the trajectory. These cases assert the work,
 * not the wall clock: the `necessary` path must not call the full-stream reader,
 * and preview object sizes must come from CAS metadata rather than a payload
 * stream (which hashes each object twice).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { CasStore } from "@sciencediscovery/cas";
import type { SessionRunEvent } from "@sciencediscovery/schema";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { createResearchSnapshots } from "./research-snapshots.js";
import { SessionStore } from "./store.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
const EVENT_COUNT = 200;

/** The preview sizing object the service builds per request (research-snapshots.ts). */
function sizing() {
  return {
    objectSizes: new Map<string, number>(), additionalRecordBytes: 0, unpinnedObjectBytes: [] as number[],
    hashes: new Set<string>(), refs: new Map(),
    jsonSizes: new WeakMap<object, number>(), casVisited: new WeakSet<object>(), refsVisited: new WeakSet<object>(),
    workspaceListings: new Map(),
  } as never;
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "necessary-package-"));
  const store = new SessionStore(root); store.setAvailableSkillIds([]); await store.load();
  const cas = new CasStore(root);
  const project = await store.createProject("necessary package");
  const session = await store.createSession(project.id, "necessary", {}, {}, { allowUnconfiguredModel: true });
  const run = await store.createSessionRun({
    sessionId: session.id, prompt: "record a long run", settingsSnapshot: store.resolveRuntimeSettings(session.id).effective,
  });
  for (let index = 0; index < EVENT_COUNT; index++) {
    await store.appendSessionRunEvent(session.id, run.id, { delta: `chunk ${index}`, turn: 1, type: "assistant.thinking.delta" } as SessionRunEvent["event"]);
  }
  const finishedAt = new Date().toISOString();
  await store.updateSessionRunStatus(session.id, run.id, "completed", { startedAt: finishedAt, finishedAt });
  const code = await cas.put("print('necessary')");
  const stdout = await cas.put("necessary\n");
  const stderr = await cas.put("");
  await store.appendExecutionRun({
    id: "necessary-execution", sessionId: session.id, turnId: run.id, code, stdout, stderr,
    cgroupMode: "none", createdFiles: [], modifiedFiles: [], environmentRevisionId: null, exitCode: 0,
    startedAt: finishedAt, finishedAt, kernelId: "test", kernelMode: null, language: null,
    networkPolicy: "none", permissionEpochId: session.permissionEpochId, runnerVersion: "test",
    sandbox: "bubblewrap", status: "succeeded", tool: "run_shell", toolVersion: "test", workingDirectory: "/workspace",
  });
  const streamed: string[] = [];
  const sized: string[] = [];
  const snapshots = createResearchSnapshots({
    store,
    evolutionStore: {} as never,
    evolveCandidates: {} as never,
    memoryGraphClient: { snapshotRevision: async () => "" } as never,
    memoryGraphEnabled: () => false,
    provenanceRecorder: { cas: {
      exists: (hash: string) => cas.exists(hash),
      read: (hash: string) => cas.read(hash),
      storedSize: async (hash: string) => { sized.push(hash); return await cas.storedSize(hash); },
      stream: async function* (hash: string) { streamed.push(hash); yield* cas.stream(hash); },
    } } as never,
  }, async () => true);
  return { root, store, cas, project, session, run, code, streamed, sized, snapshots };
}

test("a necessary preview and export never materialise the run-event history", async () => {
  const f = await fixture();
  try {
    const original = f.store.exportRunStreams.bind(f.store);
    let fullStreamReads = 0;
    f.store.exportRunStreams = async (sessionId: string, runId: string) => {
      fullStreamReads++;
      return await original(sessionId, runId);
    };
    const necessary = await f.snapshots.buildResearchPackageInput(f.project.id, f.session.id, "necessary");
    assert.equal(fullStreamReads, 0, "necessary must not call the full run-stream reader");
    const selected = (necessary.records as { sessions: Array<{ runEvents: unknown[] }> }).sessions[0]!;
    assert.deepEqual(selected.runEvents, [], "the package still carries no run events");
    assert.equal(necessary.exportProfile?.included.runEvents, 0);
    assert.equal(necessary.exportProfile?.omitted.runEvents, EVENT_COUNT,
      "the receipt still reports every omitted event, counted without materialising them");

    await f.snapshots.buildResearchPackageInput(f.project.id, f.session.id, "complete", undefined, undefined, sizing(), true, false);
    assert.ok(fullStreamReads > 0, "the complete profile still exports its run streams");
  } finally { await rm(f.root, { recursive: true, force: true }).catch(() => undefined); }
});

test("a necessary preview sizes referenced CAS objects from metadata, not by streaming them", async () => {
  const f = await fixture();
  try {
    const preview = sizing();
    await f.snapshots.buildResearchPackageInput(f.project.id, f.session.id, "necessary", undefined, undefined, preview, false, false);
    assert.equal(f.streamed.length, 0, `preview must not stream a payload to measure it, streamed: ${f.streamed.join(",")}`);
    assert.ok(f.sized.includes(f.code.hash), "the execution payload was measured from its stored length");
    assert.equal((preview as unknown as { objectSizes: Map<string, number> }).objectSizes.get(f.code.hash), f.code.size);
  } finally { await rm(f.root, { recursive: true, force: true }).catch(() => undefined); }
});

test("a preview that reconciles a new workspace file returns the revision the next request reuses", async () => {
  // The preview's own workspace reconcile writes provenance, which moves the
  // evidence revision. Returning the pre-write snapshot made the next request —
  // and an export based on it — look stale, so the preview adopts the revision
  // its own write produced and the next request is a cache hit (#1365).
  const f = await fixture();
  try {
    await mkdir(f.store.workspacePath(f.session.id), { recursive: true });
    await writeFile(resolve(f.store.workspacePath(f.session.id), "new-evidence.txt"), "fresh evidence\n");
    const first = await f.snapshots.previewResearchPackage(f.project.id, f.session.id, "necessary");
    const second = await f.snapshots.previewResearchPackage(f.project.id, f.session.id, "necessary");
    assert.equal(second.revision, first.revision, "the returned revision includes the preview's own reconcile write");
    assert.ok(second.files.some((file) => file.path === "new-evidence.txt"), "the new file is in the preview");
  } finally { await rm(f.root, { recursive: true, force: true }).catch(() => undefined); }
});

test("the necessary count matches the complete stream set, including orphan and legacy streams", async () => {
  const f = await fixture();
  try {
    // A legacy pre-stream main array plus a normal tool stream the trajectory
    // discovers, and an orphan tool stream it never opens.
    const createdAt = new Date().toISOString();
    await writeFile(resolve(f.root, "run-events", f.session.id, `${f.run.id}.json`), JSON.stringify([{
      createdAt, sequence: 100_001, event: { delta: "legacy", responseId: "legacy", turn: 1, type: "assistant.thinking.delta" },
    }]));
    await f.store.appendRunStreamEvent(f.session.id, f.run.id, "main", {
      trace: { id: "normal-call", name: "run_shell", status: "running" }, type: "tool.started",
    } as SessionRunEvent["event"]);
    await f.store.appendRunStreamEvent(f.session.id, f.run.id, "tool-normal-call", {
      chunk: "ok", toolCallId: "normal-call", type: "tool.output",
    } as SessionRunEvent["event"]);
    const orphan = Array.from({ length: 4 }, (_, index) => JSON.stringify({
      createdAt, sequence: index + 1, event: { chunk: `orphan ${index}`, toolCallId: "orphan", type: "tool.output" },
    }));
    await writeFile(resolve(f.root, "run-events", f.session.id, f.run.id, "tool-orphan.jsonl"), `${orphan.join("\n")}\n`);

    const necessary = await f.snapshots.buildResearchPackageInput(f.project.id, f.session.id, "necessary");
    const complete = await f.snapshots.buildResearchPackageInput(f.project.id, f.session.id, "complete", undefined, undefined, sizing(), true, false);
    assert.equal(necessary.exportProfile?.omitted.runEvents, complete.exportProfile?.included.runEvents,
      "necessary counts exactly the streams complete materialises, including orphan and legacy records");
    const selected = (necessary.records as { sessions: Array<Record<string, unknown>> }).sessions[0]!;
    assert.equal("runEventCount" in selected, false, "the builder measurement is not package content");
    assert.ok(!JSON.stringify(necessary.records).includes("runEventCount"), "records.json bytes cannot gain the count field");
  } finally { await rm(f.root, { recursive: true, force: true }).catch(() => undefined); }
});
