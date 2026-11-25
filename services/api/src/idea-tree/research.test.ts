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

import { createIdeaResearchClient } from "./research.js";

const GLOBAL = {
  templateId: "scientific-hypothesis-general/v1",
  explorationIntensity: "standard",
  maxDepth: 5,
  maxNodes: 100,
  scoreDirection: "maximize",
  maxTokens: null,
};

/** A store whose Session differs from the deployment in exactly one field. */
function storeWith(sessionValues: Record<string, unknown>) {
  return {
    assertSessionWritable: () => ({ id: "s1", projectId: "p1" }),
    getSession: () => ({ id: "s1", projectId: "p1" }),
    resolveRuntimeSettings: () => ({ effective: { modelId: "m1" } }),
    getModel: () => ({ id: "m1", model: "model", name: "Model" }),
    getModelApiToken: () => "token",
    getIdeaTreeSettings: () => GLOBAL,
    resolveIdeaTreeSettings: () => ({ ...GLOBAL, ...sessionValues }),
  };
}

const tokens = { issue: () => "t", revoke: () => {} } as never;

/** Run one command and hand back the body that would leave for the engine. */
async function createdPayload(store: unknown) {
  const sent: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ items: [] }) } as never;
  }) as never;
  try {
    const client = createIdeaResearchClient({
      url: "http://127.0.0.1:1",
      apiOrigin: "http://127.0.0.1:2",
      store: store as never,
      tokens,
    });
    await client.command("s1", "create", { objective: "Compare treatments", materials: "Prepared evidence" });
    assert.equal(sent.length, 1, "the engine was called once");
    return sent[0];
  } finally {
    globalThis.fetch = original;
  }
}

test("a research is created with the Session's Idea Tree parameters", async () => {
  const payload = await createdPayload(storeWith({ maxDepth: 3 }));
  assert.equal(payload.settings.maxDepth, 3, "the Session value is what the engine gets");
  // The fields the Session did not override still come from the deployment.
  assert.equal(payload.settings.templateId, GLOBAL.templateId);
  assert.equal(payload.settings.maxNodes, GLOBAL.maxNodes);
});

test("with no override a research gets the deployment parameters unchanged", async () => {
  const payload = await createdPayload(storeWith({}));
  assert.deepEqual(payload.settings, GLOBAL);
});

function researchView(status: string) {
  return {
    research: {
      id: "research-1", objective: "Compare treatments", status, phase: "ideate", round: 0,
      batch: [], batchCompleted: 0, tokens: 10, usageKnown: true, reason: null, modelId: "m1",
      currentNodeId: null, settings: GLOBAL,
    },
    graph: { edges: [], nodes: [], objective: "Compare treatments", revision: 0, treeId: "research-1", updatedAt: "" },
  };
}

/** Send one continue and keep the engine payloads and issued model grants. */
async function continueAttempt(status: string) {
  const sent: Array<{ operation: string }> = [];
  const issued: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const payload = JSON.parse(init.body) as { operation: string };
    sent.push(payload);
    return { ok: true, json: async () => (payload.operation === "continue" ? researchView("running") : researchView(status)) } as never;
  }) as never;
  const client = createIdeaResearchClient({
    url: "http://127.0.0.1:1",
    apiOrigin: "http://127.0.0.1:2",
    store: storeWith({}) as never,
    tokens: { issue: (id: string) => { issued.push(id); return "t"; }, revoke: () => undefined } as never,
  });
  let error: unknown;
  try {
    await client.command("s1", "continue", { researchId: "research-1" });
  } catch (reason: unknown) {
    error = reason;
  } finally {
    client.close();
    globalThis.fetch = original;
  }
  return { error, issued, sent };
}

test("continue refuses a research whose token budget is spent", async () => {
  const attempt = await continueAttempt("budget_exhausted");
  assert.match(String(attempt.error), /increase the token limit and start a new research/);
  assert.deepEqual(attempt.sent.map((payload) => payload.operation), ["get"], "only the status read reached the engine; nothing was started");
  assert.deepEqual(attempt.issued, [], "no model grant was issued for a terminal research");
});

test("continue still restarts a paused research", async () => {
  const attempt = await continueAttempt("paused");
  assert.equal(attempt.error, undefined);
  assert.deepEqual(attempt.sent.map((payload) => payload.operation), ["get", "continue"]);
  assert.deepEqual(attempt.issued, ["research-1"]);
});
