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
import test from "node:test";

import type { SessionArtifactOutput, SessionRun, Subagent } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConversationArtifactList } from "../src/session/ConversationArtifactList.js";
import { anchorArtifactOutputs, groupArtifactOutputsByRun } from "../src/session/run-artifacts.js";

function run(
  id: string,
  overrides: Partial<Pick<SessionRun, "assistantMessageId" | "status" | "userMessageId">> = {},
): SessionRun {
  return { createdAt: "2026-09-05T00:00:00.000Z", id, status: "completed", ...overrides } as SessionRun;
}

function output(options: {
  artifactId: string;
  createdAt: string;
  name: string;
  turnId?: string;
  version: number;
}): SessionArtifactOutput {
  return {
    artifact: {
      createdAt: options.createdAt,
      createdInSessionId: "session-1",
      createdInSessionTitle: "Session",
      currentVersion: options.version,
      id: options.artifactId,
      kind: "dataset",
      logicalName: options.name,
      name: options.name,
      origin: "llm_declared",
      projectId: "project-1",
      sessionId: "session-1",
      updatedAt: options.createdAt,
    },
    version: {
      artifactId: options.artifactId,
      content: { hash: "a".repeat(64), size: 1 },
      createdAt: options.createdAt,
      executionRunIds: [],
      id: `${options.artifactId}-v${options.version}`,
      inputArtifactVersionIds: [],
      mediaType: "text/csv",
      projectId: "project-1",
      sessionId: "session-1",
      ...(options.turnId ? { turnId: options.turnId } : {}),
      version: options.version,
    },
  };
}

test("groups main-agent and nested SubAgent Artifact outputs under their root Run", () => {
  const outputs = [
    output({ artifactId: "main", createdAt: "2026-09-05T00:01:00.000Z", name: "main.csv", turnId: "run-1", version: 1 }),
    output({ artifactId: "child", createdAt: "2026-09-05T00:02:00.000Z", name: "child.csv", turnId: "subagent-1", version: 1 }),
    output({ artifactId: "grandchild", createdAt: "2026-09-05T00:03:00.000Z", name: "grandchild.csv", turnId: "subagent-2", version: 1 }),
  ];
  const subagents = [
    { id: "subagent-1", parentTurnId: "run-1" },
    { id: "subagent-2", parentTurnId: "subagent-1" },
  ] as Subagent[];

  const grouped = groupArtifactOutputsByRun(outputs, [run("run-1")], subagents);

  assert.deepEqual(grouped.get("run-1")?.map((item) => item.artifact.name), ["main.csv", "child.csv", "grandchild.csv"]);
});

test("keeps only the newest version of an Artifact in one Run but preserves it across Runs", () => {
  const grouped = groupArtifactOutputsByRun([
    output({ artifactId: "shared", createdAt: "2026-09-05T00:01:00.000Z", name: "result.csv", turnId: "run-1", version: 1 }),
    output({ artifactId: "shared", createdAt: "2026-09-05T00:02:00.000Z", name: "result.csv", turnId: "run-1", version: 2 }),
    output({ artifactId: "shared", createdAt: "2026-09-05T00:03:00.000Z", name: "result.csv", turnId: "run-2", version: 3 }),
  ], [run("run-1"), run("run-2")], []);

  assert.deepEqual(grouped.get("run-1")?.map((item) => item.version.version), [2]);
  assert.deepEqual(grouped.get("run-2")?.map((item) => item.version.version), [3]);
});

test("does not guess a Run for outputs with an unknown or cyclic turn lineage", () => {
  const grouped = groupArtifactOutputsByRun([
    output({ artifactId: "unknown", createdAt: "2026-09-05T00:01:00.000Z", name: "unknown.csv", turnId: "missing", version: 1 }),
    output({ artifactId: "cycle", createdAt: "2026-09-05T00:02:00.000Z", name: "cycle.csv", turnId: "subagent-a", version: 1 }),
    output({ artifactId: "no-turn", createdAt: "2026-09-05T00:03:00.000Z", name: "legacy.csv", version: 1 }),
  ], [run("run-1")], [
    { id: "subagent-a", parentTurnId: "subagent-b" },
    { id: "subagent-b", parentTurnId: "subagent-a" },
  ] as Subagent[]);

  assert.equal(grouped.size, 0);
});

test("anchors terminal outputs to the active Timeline, replay Timeline, or visible message exactly once", () => {
  const activeRun = run("active", { assistantMessageId: "active-answer" });
  const replayRun = run("replay", { assistantMessageId: "replay-answer" });
  const messageRun = run("message", { assistantMessageId: "message-answer" });
  const runningRun = run("running", { assistantMessageId: "running-answer", status: "running" });
  const outputsByRun = new Map([
    ["active", [output({ artifactId: "active", createdAt: "2026-09-05T00:01:00.000Z", name: "active.csv", turnId: "active", version: 1 })]],
    ["replay", [output({ artifactId: "replay", createdAt: "2026-09-05T00:02:00.000Z", name: "replay.csv", turnId: "replay", version: 1 })]],
    ["message", [output({ artifactId: "message", createdAt: "2026-09-05T00:03:00.000Z", name: "message.csv", turnId: "message", version: 1 })]],
    ["running", [output({ artifactId: "running", createdAt: "2026-09-05T00:04:00.000Z", name: "running.csv", turnId: "running", version: 1 })]],
  ]);

  const anchors = anchorArtifactOutputs(outputsByRun, [activeRun, replayRun, messageRun, runningRun], {
    activeTimelineRunId: activeRun.id,
    // The active Timeline folds this assistant message out of displayedMessages.
    displayedMessageIds: new Set([replayRun.assistantMessageId!, messageRun.assistantMessageId!, runningRun.assistantMessageId!]),
    replayedRunIds: new Set([replayRun.id]),
  });

  assert.deepEqual(anchors.activeTimeline.map((item) => item.artifact.name), ["active.csv"]);
  assert.deepEqual(anchors.byReplayTimeline.get(replayRun.id)?.map((item) => item.artifact.name), ["replay.csv"]);
  assert.deepEqual(anchors.byMessage.get(messageRun.assistantMessageId!)?.map((item) => item.artifact.name), ["message.csv"]);
  assert.equal(anchors.byMessage.has(activeRun.assistantMessageId!), false);
  assert.equal(anchors.byMessage.has(runningRun.assistantMessageId!), false);
  assert.equal(anchors.byReplayTimeline.has(activeRun.id), false);
});

test("shows five Artifact rows by default and offers to expand a longer Run", () => {
  const outputs = Array.from({ length: 6 }, (_, index) => output({
    artifactId: `artifact-${index + 1}`,
    createdAt: `2026-09-05T00:0${index + 1}:00.000Z`,
    name: `result-${index + 1}.csv`,
    turnId: "run-1",
    version: 1,
  }));

  const html = renderToStaticMarkup(createElement(ConversationArtifactList, {
    onOpen: () => undefined,
    outputs,
  }));

  assert.match(html, /result-1\.csv/);
  assert.match(html, /result-5\.csv/);
  assert.doesNotMatch(html, /result-6\.csv/);
  assert.match(html, /Show all 6 artifacts/);
  assert.match(html, /aria-expanded="false"/);
});
