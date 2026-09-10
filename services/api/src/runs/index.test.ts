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
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { installApiTestModelCatalog } from "../model-catalog.fixture.js";
import { SessionStore } from "../store.js";
import {
  buildCompletedToolTrace,
  buildSubagentToolStep,
  cloneRunEventDetails,
  computeSettingsSnapshot,
  skillAuthoringCommandPrompt,
  splitArtifactVersionSuffix,
} from "./index.js";

// Regression for the artifact-chip failure: some models collapse the
// artifact_id and version into one string ("uuid#v1") inside
// cites_artifact_aliases. The splitter must recover the bare UUID (so the
// sidecar's composite-key MATCH on a bare artifact_id hits the node) and the
// encoded version (so the cite pins the exact version, not the latest).
test("splitArtifactVersionSuffix strips a #vN suffix into bare id + version", () => {
  assert.deepEqual(
    splitArtifactVersionSuffix("67c0ce25-f5c1-474c-bda3-2dd73865a29a#v1"),
    { id: "67c0ce25-f5c1-474c-bda3-2dd73865a29a", version: 1 },
  );
  assert.deepEqual(
    splitArtifactVersionSuffix("ed2265a4-9638-4b51-a95e-13bf5c1770ac#v2"),
    { id: "ed2265a4-9638-4b51-a95e-13bf5c1770ac", version: 2 },
  );
  assert.deepEqual(
    splitArtifactVersionSuffix("ABC#V12"),
    { id: "ABC", version: 12 },
    "the suffix is case-insensitive and supports multi-digit versions",
  );
});

test("a bare id with no suffix returns version undefined", () => {
  assert.deepEqual(
    splitArtifactVersionSuffix("67c0ce25-f5c1-474c-bda3-2dd73865a29a"),
    { id: "67c0ce25-f5c1-474c-bda3-2dd73865a29a", version: undefined },
  );
  assert.deepEqual(splitArtifactVersionSuffix("plain"), { id: "plain", version: undefined });
});

test("a malformed #v suffix is left whole rather than mis-parsed", () => {
  // Non-numeric version after #v: the whole string stays the id, version
  // undefined — the caller then falls back to the store's latest version.
  assert.deepEqual(
    splitArtifactVersionSuffix("abc#vxyz"),
    { id: "abc#vxyz", version: undefined },
  );
  // An empty version after #v likewise falls through unchanged.
  assert.deepEqual(splitArtifactVersionSuffix("abc#v"), { id: "abc#v", version: undefined });
});

test("an id that merely contains #v mid-string is not split", () => {
  // Only a trailing #vN is stripped; an embedded #v stays part of the id.
  assert.deepEqual(
    splitArtifactVersionSuffix("name#v1/segment"),
    { id: "name#v1/segment", version: undefined },
  );
});

test("Skill authoring slash commands expand into guarded Agent workflows", () => {
  const creator = skillAuthoringCommandPrompt("/skill-creator Build a reusable evidence checker");
  assert.match(creator ?? "", /skill-creator Skill as the authoritative/);
  assert.match(creator ?? "", /Build a reusable evidence checker/);
  assert.match(creator ?? "", /call create_skill exactly once/i);

  const distill = skillAuthoringCommandPrompt("/distill-session keep the validation steps");
  assert.match(distill ?? "", /complete prior Session conversation and execution history/);
  assert.match(distill ?? "", /keep the validation steps/);
  assert.equal(skillAuthoringCommandPrompt("ordinary message"), undefined);
});

test("run event details clone falls back to JSON-safe values", () => {
  const details = { id: "tool-1", nested: { ok: true }, callback: () => "not cloneable" };
  assert.deepEqual(cloneRunEventDetails(details), {
    id: "tool-1",
    nested: { ok: true },
  });
});

test("run event details clone omits values that cannot be safely serialized", () => {
  const details = { callback: () => "not cloneable", value: 1n };
  assert.equal(cloneRunEventDetails(details), undefined);
});

test("completed tool traces retain cloneable details through the assembly path", () => {
  const trace = buildCompletedToolTrace({
    isError: false,
    result: {
      content: [{ type: "text", text: "ok" }],
      details: { attempt: 1, nested: { status: "ok" } },
    },
    toolCallId: "call-1",
    toolName: "run_shell",
    type: "tool_execution_end",
  });

  assert.deepEqual(trace, {
    details: { attempt: 1, nested: { status: "ok" } },
    id: "call-1",
    name: "run_shell",
    outputChars: 2,
    outputStream: "tool-call-1",
    status: "completed",
  });
});

test("subagent tool steps retain cloneable details through the assembly path", () => {
  const step = buildSubagentToolStep({
    isError: true,
    result: {
      content: [{ type: "text", text: "failed" }],
      details: { error: { code: "TOOL_EXECUTION_FAILED" }, retryable: false },
    },
    toolCallId: "call-2",
    toolName: "mcp__papers__search",
    type: "tool_execution_end",
  }, {
    content: "papers query",
    createdAt: "2026-09-10T01:02:03.000Z",
    id: "call-2",
    input: "query: papers",
    kind: "tool",
    status: "running",
    toolCallId: "call-2",
    toolName: "mcp__papers__search",
  });

  assert.deepEqual(step, {
    content: "failed",
    createdAt: "2026-09-10T01:02:03.000Z",
    details: { error: { code: "TOOL_EXECUTION_FAILED" }, retryable: false },
    id: "call-2",
    input: "query: papers",
    kind: "tool",
    status: "failed",
    toolCallId: "call-2",
    toolName: "mcp__papers__search",
  });
});

test("tool trace assembly omits details that cannot be cloned or serialized", () => {
  const trace = buildCompletedToolTrace({
    isError: false,
    result: {
      content: [{ type: "text", text: "ok" }],
      details: { callback: () => "not cloneable", value: 1n },
    },
    toolCallId: "call-3",
    toolName: "unstable",
    type: "tool_execution_end",
  });

  assert.equal("details" in trace, false);
  assert.equal(trace.status, "completed");
});

test("run snapshots narrow legacy Responses max to the selected model wire capability", async (context) => {
  installApiTestModelCatalog();
  const tempRoot = resolve(process.cwd(), ".tmp", `settings-snapshot-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  const store = new SessionStore(tempRoot);
  context.after(async () => {
    store.close();
    await rm(tempRoot, { force: true, recursive: true });
  });
  await store.load();
  const provider = await store.createProvider({ apiToken: "test-token", presetId: "openai" });
  const model = await store.materializeProviderModel(provider.id, "gpt-5.5");
  const project = await store.createProject("Responses effort");
  const session = await store.createSession(project.id, "Responses effort", model.id);
  await store.updateSession(session.id, { thinkingEffort: "max", thinkingMode: "enabled" });

  const snapshot = computeSettingsSnapshot(store, session.id);
  assert.equal(snapshot.thinkingMode, "enabled");
  assert.equal(snapshot.thinkingEffort, "xhigh");
});
