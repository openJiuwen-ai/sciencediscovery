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

import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import type { RunStreamEvent } from "@science-agent/schema";

import { SessionStore } from "../store.js";
import { emitWorkspaceChanges } from "./index.js";

/** Session store plus an empty workspace snapshot, ready for the first refresh. */
async function createWorkspace(context: { after: (fn: () => unknown) => void }, label: string): Promise<{
  sessionId: string;
  store: SessionStore;
  workspaceRoot: string;
}> {
  const tempRoot = resolve(process.cwd(), ".tmp", `${label}-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });
  const project = await store.createProject("Workspace events");
  const session = await store.createSession(project.id, label, model.id);
  return { sessionId: session.id, store, workspaceRoot: store.workspacePath(session.id) };
}

test("workspace refresh stays silent when only subagent private files change", async (context) => {
  const { sessionId, store, workspaceRoot } = await createWorkspace(context, "workspace-subagent-only");
  const events: RunStreamEvent[] = [];
  const emit = (event: RunStreamEvent) => {
    events.push(event);
  };

  const baseline = await emitWorkspaceChanges({ emit, previous: new Map(), sessionId, store });
  events.length = 0;

  await mkdir(resolve(workspaceRoot, "subagents/subagent-1/inputs"), { recursive: true });
  await writeFile(resolve(workspaceRoot, "subagents/subagent-1/handoff.json"), "{}\n", "utf8");
  await writeFile(resolve(workspaceRoot, "subagents/subagent-1/inputs/copy.csv"), "value\n1\n", "utf8");
  const afterSubagent = await emitWorkspaceChanges({ emit, previous: baseline, sessionId, store });

  assert.deepEqual(events.map((event) => event.type), []);
  assert.ok(afterSubagent.has("subagents/subagent-1/handoff.json"));
});

test("workspace refresh still reports ordinary workspace changes", async (context) => {
  const { sessionId, store, workspaceRoot } = await createWorkspace(context, "workspace-user-visible");
  const events: RunStreamEvent[] = [];
  const emit = (event: RunStreamEvent) => {
    events.push(event);
  };

  const baseline = await emitWorkspaceChanges({ emit, previous: new Map(), sessionId, store });
  events.length = 0;

  await writeFile(resolve(workspaceRoot, "result.csv"), "value\n1\n", "utf8");
  const afterUserFile = await emitWorkspaceChanges({ emit, previous: baseline, sessionId, store });

  const changed = events.find((event) => event.type === "workspace.changed");
  assert.ok(changed && changed.type === "workspace.changed");
  assert.deepEqual(changed.changedPaths, ["result.csv"]);
  assert.equal(changed.files.find((file) => file.path === "result.csv")?.previewKind, "dataset");
  assert.equal(changed.files.some((file) => Object.hasOwn(file, "kind")), false);
  assert.ok(afterUserFile.has("result.csv"));
});

test("a mixed change set still reports the ordinary workspace change", async (context) => {
  const { sessionId, store, workspaceRoot } = await createWorkspace(context, "workspace-mixed");
  const events: RunStreamEvent[] = [];
  const emit = (event: RunStreamEvent) => {
    events.push(event);
  };

  const baseline = await emitWorkspaceChanges({ emit, previous: new Map(), sessionId, store });
  events.length = 0;

  await mkdir(resolve(workspaceRoot, "subagents/subagent-2"), { recursive: true });
  await writeFile(resolve(workspaceRoot, "subagents/subagent-2/handoff.json"), "{}\n", "utf8");
  await writeFile(resolve(workspaceRoot, "report.md"), "# report\n", "utf8");
  await emitWorkspaceChanges({ emit, previous: baseline, sessionId, store });

  const changed = events.find((event) => event.type === "workspace.changed");
  assert.ok(changed && changed.type === "workspace.changed");
  assert.ok(changed.changedPaths.includes("report.md"));
});
