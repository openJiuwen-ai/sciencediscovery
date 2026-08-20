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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { reviewerLog } from "./review-log.js";

test("Reviewer execution log preserves trace context and redacts credentials", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "sciencediscovery-reviewer-log-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  reviewerLog.setLogDir(directory);

  reviewerLog.event({
    artifactLogicalName: "report.md",
    artifactVersionId: "artifact-v1",
    checkpointId: "checkpoint-1",
    executionId: "execution-1",
    sessionId: "session-1",
  }, "tool.finished", {
    output: "Authorization: Bearer secret-value\napi_key=another-secret",
    provenanceRefs: ["artifact-1#v1"],
    toolName: "search",
  });

  const lines = (await readFile(resolve(directory, "reviewer-specialist.ndjson"), "utf8")).trim().split("\n");
  const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(entry.event, "tool.finished");
  assert.equal(entry.sessionId, "session-1");
  assert.match(JSON.stringify(entry), /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(entry), /secret-value|another-secret/);
  assert.match(JSON.stringify(entry), /artifact-1#v1/);
});

test("Reviewer execution log writes stage progress synchronously", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "sciencediscovery-reviewer-log-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  reviewerLog.setLogDir(directory);
  const logContext = {
    artifactLogicalName: "report.md",
    artifactVersionId: "artifact-v1",
    checkpointId: "checkpoint-1",
    executionId: "execution-1",
    sessionId: "session-1",
  };

  reviewerLog.event(logContext, "deep.computation.started");
  const started = await readFile(resolve(directory, "reviewer-specialist.ndjson"), "utf8");
  reviewerLog.event(logContext, "deep.computation.finished", { status: "COMPLETED" });
  const finished = await readFile(resolve(directory, "reviewer-specialist.ndjson"), "utf8");

  assert.match(started, /deep\.computation\.started/);
  assert.match(finished, /deep\.computation\.finished/);
});
