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

// #1251's F5: an artifact result's `artifact:<id>` must reach the exact
// SessionArtifactOutput the dialog opens, and a missing one must be reported
// rather than silently ignored.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { SessionArtifactOutput } from "../src/api/types.js";
import { openArtifactResultAction, openSearchArtifact } from "../src/app/open-artifact-result.js";
import { TEXT } from "../src/text.js";
import { StubClient } from "./api-stub.js";

function output(id: string): SessionArtifactOutput {
  return { artifact: { id, name: `${id}.pdf` }, version: { id: `version-${id}` } } as unknown as SessionArtifactOutput;
}

async function run(outputs: SessionArtifactOutput[] | Error): Promise<{ events: string[]; opened: SessionArtifactOutput[] }> {
  const client = new StubClient();
  if (outputs instanceof Error) client.fail(outputs);
  else client.reply(outputs);
  const events: string[] = [];
  const opened: SessionArtifactOutput[] = [];
  await openSearchArtifact({
    artifactId: "a1",
    client: client.asClient(),
    onError: () => events.push("error"),
    onMissing: () => events.push("missing"),
    onOpen: (value) => { opened.push(value); },
    sessionId: "s1",
  });
  return { events, opened };
}

test("a matching artifact output is handed to the opener", async () => {
  const { events, opened } = await run([output("other"), output("a1")]);
  assert.deepEqual(events, []);
  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.artifact.id, "a1");
});

test("a vanished artifact is reported instead of being ignored", async () => {
  const { events, opened } = await run([output("other")]);
  assert.deepEqual(events, ["missing"]);
  assert.deepEqual(opened, []);
});

test("a failed read is reported as an error", async () => {
  const { events, opened } = await run(new Error("artifact-outputs failed"));
  assert.deepEqual(events, ["error"]);
  assert.deepEqual(opened, []);
});

test("the production action turns a vanished artifact and a failed read into toasts", async () => {
  const toasts: Array<{ message: string; tone: string }> = [];
  const missing = new StubClient().reply([]);
  await openArtifactResultAction({
    artifactId: "a1",
    client: missing.asClient(),
    describeError: () => "boom",
    onOpen: () => {},
    sessionId: "s1",
    toast: (message, tone) => toasts.push({ message, tone }),
  });
  assert.deepEqual(toasts, [{ message: TEXT.search.artifactUnavailable, tone: "error" }]);

  const failing = new StubClient().fail(new Error("outputs failed"));
  await openArtifactResultAction({
    artifactId: "a1",
    client: failing.asClient(),
    describeError: () => "boom",
    onOpen: () => {},
    sessionId: "s1",
    toast: (message, tone) => toasts.push({ message, tone }),
  });
  assert.deepEqual(toasts.at(-1), { message: "boom", tone: "error" });

  const opened: string[] = [];
  const matching = new StubClient().reply([output("a1")]);
  await openArtifactResultAction({
    artifactId: "a1",
    client: matching.asClient(),
    describeError: () => "boom",
    onOpen: (value) => { opened.push(value.artifact.id); },
    sessionId: "s1",
    toast: (message, tone) => toasts.push({ message, tone }),
  });
  assert.deepEqual(opened, ["a1"]);
  assert.equal(toasts.length, 2, "a successful open must not toast");
});
