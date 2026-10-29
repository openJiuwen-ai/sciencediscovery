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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { CasStore } from "@sciencediscovery/cas";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { SessionStore } from "../store.js";
import { SAMPLE_SESSION_MARKER, seedSampleSession } from "./index.js";

function tempRoot(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

test("an install with no conversation of its own opens on the sample Session", async (context) => {
  const root = tempRoot("sample-session-fresh");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = new SessionStore(root);
  await store.load();

  assert.equal(await seedSampleSession(store), true);

  const projects = store.listUserProjects();
  assert.deepEqual(projects.map((project) => project.name), ["示例项目"]);
  const [project] = projects;
  assert.ok(project);
  const sessions = store.listSessions(project.id, "all");
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.ok(session);
  // The title the task was summarized into, not the "样例" the recorded
  // Session later wore.
  assert.equal(session.title, "脓毒症内型评分聚类分析");

  // The files landed under this install's own ids, not the originals: the
  // conversation is readable through the same path the store looks in, and
  // nothing in it still names the machine the sample was recorded on.
  const messages = await readFile(resolve(root, "messages", `${session.id}.json`), "utf8");
  assert.doesNotMatch(messages, /__SESSION_ID__|__PROJECT_ID__|__DATA_DIR__/);
  const runs = await readFile(resolve(root, "session-runs", `${session.id}.json`), "utf8");
  const [run] = JSON.parse(runs) as Array<{ id: string }>;
  assert.ok(run, "the transcript replays one finished run");
  // The run's stream names the Session it belongs to in every artifact event,
  // so the recorded name has to be rewritten too — a transcript that calls the
  // sidebar's Session something else is a sample that contradicts itself.
  const mainStream = await readFile(resolve(root, "run-events", session.id, run.id, "main.jsonl"), "utf8");
  assert.doesNotMatch(mainStream, /样例/);
  assert.ok(mainStream.includes(session.title));
  const workspace = resolve(root, "projects", project.id, "sessions", session.id, "workspace");
  assert.ok((await stat(workspace)).isDirectory());
  // The analysis's own deliverables and the scripts behind them landed.
  assert.ok((await readFile(resolve(workspace, "app", "trace.md"), "utf8")).length > 50_000);
  assert.ok((await readFile(resolve(workspace, "work", "sensitivity_summary.md"), "utf8")).length > 1_000);
  await assert.rejects(stat(resolve(workspace, "__pycache__")), /ENOENT/);
  // The input table ships with the analysis: without it the trace's code has
  // nothing to read, and the reader cannot follow or repeat a step.
  assert.ok((await stat(resolve(workspace, "subspace_score_table.csv"))).size > 2_000_000);

  // The 产物 tab reads the catalog, not the workspace, so the sample has to
  // publish its artifacts the way the run did. trace.md and answer.txt keep
  // every draft the answer's "v4" refers to; the version picker is what shows
  // that history.
  const outputs = store.listSessionArtifactOutputs(session.id);
  assert.deepEqual(
    outputs.map((output) => `${output.artifact.name}@v${output.version.version}`).toSorted(),
    [
      "app/answer.txt@v1", "app/answer.txt@v2", "app/answer.txt@v3", "app/answer.txt@v4",
      "app/trace.md@v1", "app/trace.md@v2", "app/trace.md@v3", "app/trace.md@v4",
      "work/sensitivity_summary.md@v1",
    ],
  );
  assert.equal(new Set(outputs.map((output) => output.artifact.id)).size, 3);
  assert.ok(outputs.every((output) => output.version.turnId), "every row can attach to a turn");
  // The answer cites the sensitivity summary by the id it had when recorded.
  // Seeding mints new ids, so that chip has to be pointed at the seeded one.
  const citations = (JSON.parse(messages) as Array<{ references?: Array<{ id: string; kind: string }> }>)
    .flatMap((message) => message.references ?? [])
    .filter((reference) => reference.kind === "artifact");
  assert.equal(citations.length, 1);
  assert.ok(outputs.some((output) => output.artifact.id === citations[0]!.id),
    "the citation resolves to a seeded artifact");
  // The bytes are in the content store, at the size the version records — a
  // row that opens on nothing is worse than no row.
  const cas = new CasStore(root, "data");
  for (const output of outputs) {
    assert.equal((await cas.read(output.version.content.hash)).length, output.version.content.size);
  }

  // The five children the recorded run delegated. Their execution is readable
  // only through the catalog, and the stream a replay reads keeps snapshots
  // without steps, so the sample has to arrive with the rows a live child
  // would have written — otherwise every delegation in it opens on "no
  // execution recorded", which is a panel that says the sample did nothing.
  const children = store.listSubagents(session.id);
  assert.deepEqual(
    children.map((child) => child.status).toSorted(),
    ["completed", "completed", "completed", "completed", "timed_out"],
  );
  assert.ok(children.every((child) => child.sessionId === session.id), "every row belongs to this install's Session");
  for (const child of children) {
    assert.ok(child.steps.length > 0, `${child.input.description} kept the steps it recorded`);
  }
  const draft = children.find((child) => child.input.description === "Draft trace and answer");
  assert.ok(draft);
  const spoken = draft.steps.filter((step) => step.kind === "assistant" && step.content.trim() !== "");
  assert.ok(spoken.length > 0, "a completed child still has the answer the panel shows as its 输出");
  // A step is re-emitted as it changes; the catalog holds one row per step,
  // in the order it was first recorded.
  const ids = draft.steps.map((step) => step.id);
  assert.equal(new Set(ids).size, ids.length);

  assert.ok((await stat(resolve(root, SAMPLE_SESSION_MARKER))).isFile());
});

test("the sample is written once, so deleting it is not undone on the next start", async (context) => {
  const root = tempRoot("sample-session-once");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = new SessionStore(root);
  await store.load();
  assert.equal(await seedSampleSession(store), true);
  const project = store.listUserProjects()[0];
  assert.ok(project);
  const session = store.listSessions(project.id, "all")[0];
  assert.ok(session);

  // The user deletes what they were given. The Project stays behind empty,
  // which is exactly the state a re-seed would fill again.
  await store.deleteSession(session.id, session.id);
  assert.deepEqual(store.listSessions(project.id, "all"), []);
  assert.equal(await seedSampleSession(store), false);

  const reopened = new SessionStore(root);
  await reopened.load();
  assert.equal(await seedSampleSession(reopened), false);
  assert.deepEqual(reopened.listUserProjects().map((entry) => entry.name), ["示例项目"]);
  assert.deepEqual(reopened.listSessions(project.id, "all"), []);
});

test("an install that already has conversations is not given a sample", async (context) => {
  const root = tempRoot("sample-session-existing");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = new SessionStore(root);
  await store.load();
  const mine = await store.createProject("My analysis");
  await store.createSession(mine.id, "Mine", {}, {}, { allowUnconfiguredModel: true });

  assert.equal(await seedSampleSession(store), false);
  assert.deepEqual(store.listUserProjects().map((project) => project.name), ["My analysis"]);
  assert.equal(store.listSessions(mine.id, "all").length, 1);
});

test("a seed that fails part-way leaves nothing behind, so the next start tries again", async (context) => {
  const root = tempRoot("sample-session-failed");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = new SessionStore(root);
  await store.load();
  // Fail where a full disk or a corrupt payload would: after the Project and
  // the Session exist, while the artifacts are being catalogued.
  store.createArtifactVersion = async () => {
    throw new Error("ENOSPC: no space left on device");
  };

  assert.equal(await seedSampleSession(store), false);

  // Nothing of the sample survives, so the "already has conversations" check
  // the next start makes does not mistake the wreckage for the user's work.
  assert.deepEqual(store.listUserProjects(), []);
  assert.equal(existsSync(resolve(root, SAMPLE_SESSION_MARKER)), false);

  // The next start — a new process over the same data directory — seeds it
  // whole, because there is nothing left for it to read as a used install.
  const reopened = new SessionStore(root);
  await reopened.load();
  assert.equal(await seedSampleSession(reopened), true);
  assert.deepEqual(reopened.listUserProjects().map((project) => project.name), ["示例项目"]);
  const [project] = reopened.listUserProjects();
  assert.ok(project);
  assert.equal(reopened.listSessions(project.id, "all").length, 1);
  assert.ok(existsSync(resolve(root, SAMPLE_SESSION_MARKER)));
});
