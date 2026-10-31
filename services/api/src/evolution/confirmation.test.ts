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
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { SessionStore } from "../store.js";
import {
  confirmEvolveSearch,
  evolveSearchResource,
  type EvolveConfirmationRequest,
} from "./confirmation.js";

test("a turn with no approval path refuses the search instead of allowing it", async () => {
  // Unreachable for typed callers (the callback is required), reachable for a
  // caller outside the type system. A search that cannot ask must not spend,
  // not even in a session whose approval mode allows everything: the gate
  // decides, not the session mode.
  const result = await confirmEvolveSearch(
    { sessionId: "session-without-approval" },
    { expansions: 2, howScored: "held-out accuracy" },
    "call-1",
  );
  assert.equal(result.confirmed, false, "a turn that cannot ask must not start a budget-spending search");
  if (result.confirmed) throw new Error("unreachable");
  assert.match(result.refusedBecause, /^confirmation unavailable/);
});

test("each search attempt gets its own grant key, even for a repeated call", () => {
  // The permission runtime matches a standing grant by action + resource; a
  // key shared by a session, or by a tool call that is retried, is a silent
  // allow for the next search.
  assert.notEqual(evolveSearchResource("session-1"), evolveSearchResource("session-1"));
  assert.notEqual(evolveSearchResource("session-1"), evolveSearchResource("session-2"));
});

test("a grant from one search does not authorize the next search in the same session", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `evolve-confirmation-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "synthetic-confirmation-token",
    baseUrl: "https://models.example.test/v1",
    model: "science-model",
    name: "Evolution confirmation model",
  });
  const project = await store.createProject("Evolution confirmation", { modelId: model.id, reviewModelId: model.id });
  const session = await store.createSession(project.id, "Evolution confirmation", {}, { approvalMode: "ask_for_dangerous" });

  const first = evolveSearchResource(session.id);
  const second = evolveSearchResource(session.id);
  assert.notEqual(first, second);

  const pending = await store.requestPermission(session.id, "code", first, "First search", { executionId: "run-1", toolCallId: "call-1" });
  assert.equal(pending.allowed, false, "ask mode must raise a card for the first search");
  if (pending.allowed) throw new Error("expected a pending permission request");
  // The broadest answer the card offers: "allow matching". It may cover this
  // search, never the next one.
  await store.decidePermissionRequest(pending.request.id, "allow_matching");
  assert.equal((await store.requestPermission(session.id, "code", first, "First search", { executionId: "run-1", toolCallId: "call-1" })).allowed, true);

  const next = await store.requestPermission(session.id, "code", second, "Second search", { executionId: "run-2", toolCallId: "call-2" });
  assert.equal(next.allowed, false, "the next search must raise its own card");
});

test("the gate asks with the call's identity and the search it is paying for", async () => {
  const asked: EvolveConfirmationRequest[] = [];
  const result = await confirmEvolveSearch(
    {
      requestConfirmation: async (input) => {
        asked.push(input);
        return false;
      },
      sessionId: "session-3",
    },
    { expansions: 7, howScored: "held-out BLEU" },
    "call-42",
  );
  assert.equal(result.confirmed, false);
  if (result.confirmed) throw new Error("unreachable");
  assert.equal(result.refusedBecause, "the evolution search was not confirmed by the user");
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.toolCallId, "call-42");
  assert.match(asked[0]!.summary, /7 expansions/);
  assert.match(asked[0]!.summary, /held-out BLEU/);
  assert.ok(asked[0]!.resource.startsWith("evolve-search:session-3:"));
});
