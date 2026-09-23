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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import { createEvolveTools, type EvolveToolRuntime } from "./index.js";

function runtime(overrides: Partial<EvolveToolRuntime> = {}): EvolveToolRuntime {
  return {
    createEvolveRun: async () => ({ refusedBecause: "probe" }),
    getEvolveRun: async () => ({
      baselineScore: null, bestChange: undefined, bestScore: null, bestTestScore: null,
      candidates: 0, id: "run-1", status: "running" as const, tokens: 0,
    }),
    ...overrides,
  };
}

test("no runtime means no tools at all", () => {
  // The point of the package: a deployment that never builds an evolve runtime
  // exposes nothing, and it does so by construction rather than by every call
  // site remembering to leave a dependency out.
  assert.deepEqual(createEvolveTools(undefined).map((tool) => tool.name), []);
});

test("a runtime contributes both tools, visible from the first step", () => {
  const names = createEvolveTools(runtime()).map((tool) => tool.name);
  assert.deepEqual(names.sort(), ["create_evolve_run", "get_evolve_run"]);
});

test("the create tool names the approval the user will actually see", () => {
  // The card is the user's, so the description has to match the deployment:
  // "starts immediately" and "creates an approval card" are different promises.
  const auto = createEvolveTools(runtime({ approvalMode: "always_allow" }))
    .find((tool) => tool.name === "create_evolve_run");
  const asks = createEvolveTools(runtime({ approvalMode: "ask_for_dangerous" }))
    .find((tool) => tool.name === "create_evolve_run");
  assert.match(auto!.description, /Starts immediately/);
  assert.match(asks!.description, /approval card/);
});

test("the algorithm the user picked reaches the proposal", async () => {
  // The picker writes `--algorithm openevolve` into the command and the skill says to set
  // `algorithm`; without it in the schema OpenEvolve could never be chosen from a conversation.
  const proposals: unknown[] = [];
  const create = createEvolveTools(runtime({
    createEvolveRun: async (proposal) => { proposals.push(proposal); return { refusedBecause: "probe" }; },
  })).find((tool) => tool.name === "create_evolve_run")!;
  const algorithm = (create.parameters as { properties: Record<string, { anyOf?: Array<{ const: string }> }> }).properties.algorithm;
  assert.deepEqual(algorithm?.anyOf?.map((option) => option.const), ["puct", "openevolve"]);
  await create.execute("call", { algorithm: "openevolve" } as never, new AbortController().signal);
  assert.equal((proposals[0] as { algorithm?: string }).algorithm, "openevolve");
});

test("the tools reach the runtime they were built with", async () => {
  const calls: string[] = [];
  const tools = createEvolveTools(runtime({
    getEvolveRun: async (runId?: string) => {
      calls.push(`get:${runId ?? "latest"}`);
      return {
        baselineScore: null, bestChange: undefined, bestScore: null, bestTestScore: null,
        candidates: 0, id: "run-1", status: "running" as const, tokens: 0,
      };
    },
  }));
  const get = tools.find((tool) => tool.name === "get_evolve_run")!;
  await get.execute("call-1", { runId: "run-1" } as never, new AbortController().signal);
  assert.deepEqual(calls, ["get:run-1"]);
});

test("a finished search hands the agent the winning text as its own block, not as escaped JSON", async () => {
  const winner = "第一段。\n第二段带\"引号\"。";
  const finished = {
    baselineScore: 0.03, bestChange: "补入可核实事实", bestCodeHash: "a".repeat(64), bestScore: 0.0938,
    bestSource: winner, bestTestScore: 0.09, candidates: 13, id: "run-1",
    resultArtifact: "evolve/run-1/evolved.md", status: "succeeded" as const, tokens: 28_147,
  };
  const get = createEvolveTools(runtime({ getEvolveRun: async () => finished }))
    .find((tool) => tool.name === "get_evolve_run")!;
  const result = await get.execute("call", {} as never, new AbortController().signal);
  const text = (result.content[0] as { text: string }).text;
  const [figures, ...block] = text.split("\n");
  assert.equal(JSON.parse(figures!).resultArtifact, "evolve/run-1/evolved.md");
  assert.ok(!("bestSource" in JSON.parse(figures!)), "the text is not duplicated inside the JSON");
  assert.equal(block.join("\n"), `<best_candidate>\n${winner}\n</best_candidate>`);
  assert.deepEqual(result.details, finished);
});

test("a cut winner says how much was cut and where the rest is", async () => {
  const get = createEvolveTools(runtime({ getEvolveRun: async () => ({
    baselineScore: 0.1, bestScore: 0.5, bestSource: "x".repeat(10), bestSourceTruncated: { chars: 50_000 },
    bestTestScore: null, candidates: 3, id: "run-2", resultArtifact: "evolve/run-2/candidate.py",
    status: "succeeded" as const, tokens: 1,
  }) })).find((tool) => tool.name === "get_evolve_run")!;
  const text = ((await get.execute("call", {} as never, new AbortController().signal)).content[0] as { text: string }).text;
  assert.match(text, /<best_candidate truncated="true"> \(first 10 of 50000 characters; the rest is in evolve\/run-2\/candidate\.py\)/);
});

test("a search with no winner returns just the figures", async () => {
  const get = createEvolveTools(runtime()).find((tool) => tool.name === "get_evolve_run")!;
  const text = ((await get.execute("call", {} as never, new AbortController().signal)).content[0] as { text: string }).text;
  assert.ok(!text.includes("<best_candidate"));
  assert.equal(JSON.parse(text).status, "running");
});

test("Idea Tree status reader returns the actual background research to the agent", async () => {
  const summary = {id: "research-1", status: "running", activities: [{role: "activity", status: "running"}]};
  const calls: Array<string | undefined> = [];
  const tool = createEvolveTools(runtime({getIdeaResearch: async id => { calls.push(id); return summary; }}))
    .find(tool => tool.name === "get_idea_research")!;
  const result = await tool.execute("read", {} as never, new AbortController().signal);
  assert.deepEqual(calls, [undefined]);
  assert.deepEqual(result.details, summary);
});

test("Idea Tree handoff sends prepared evidence to Python and returns its run id", async () => {
  let received: unknown;
  const input = {objective: "Compare Fe/Mn catalysts", materials: "Supplied study: leaching is unresolved; source: study-A."};
  const tool = createEvolveTools(runtime({createIdeaResearch: async args => {
    received = args;
    return {researchId: "research-new", status: "running"};
  }})).find(tool => tool.name === "create_idea_research")!;
  const result = await tool.execute("create", input as never, new AbortController().signal);
  assert.deepEqual(received, input);
  assert.deepEqual(result.details, {researchId: "research-new", status: "running"});
});
