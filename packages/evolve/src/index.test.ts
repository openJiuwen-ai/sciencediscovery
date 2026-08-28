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
