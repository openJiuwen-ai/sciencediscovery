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


import type { ModelProfile } from "@sciencediscovery/schema";

import { describeEvolveBudget, perCallCeiling } from "./call-budget.js";

function model(over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    baseUrl: "http://127.0.0.1:1/v1", createdAt: "", hasApiToken: true, id: "m1",
    model: "some-gateway-model", name: "Gateway", proxyPolicy: "inherit" as never,
    updatedAt: "", vision: false, ...over,
  };
}

test("a reasoning ceiling clears each algorithm's own floor", () => {
  // The proposal path used to write one number for both algorithms while
  // pre-flight demanded a higher one for OpenEvolve, so an OpenEvolve run that
  // asked for thinking was refused by the default it had just written itself.
  assert.equal(perCallCeiling("puct", "enabled"), 96_000);
  assert.equal(perCallCeiling("openevolve", "enabled"), 128_000);
});

test("a quiet run keeps the working ceiling, not the bare floor", () => {
  // 8k is the PUCT floor, but a quiet call does not need to be run at it: the
  // floor only has to be satisfied.
  assert.equal(perCallCeiling("puct", "disabled"), 16_000);
  assert.equal(perCallCeiling("openevolve", "disabled"), 16_000);
});

test("an endpoint that cannot stop thinking is priced as a thinking run", () => {
  // The number the agent shows the user before spending. Reporting "disabled"
  // here would promise a 16k ceiling the run will never get.
  const plan = describeEvolveBudget(model());
  assert.equal(plan.thinking.effective, "enabled");
  assert.match(plan.thinking.note ?? "", /no thinking-control field/);
  assert.deepEqual(plan.perCallCeiling, { openevolve: 128_000, puct: 96_000 });
  assert.equal(plan.totalTokenCap, 600_000);
});

test("a dialect with a toggle but no disabled stop is priced as a thinking run", () => {
  // The PR's original defect, on a dialect that maps a field: the request is
  // heard, but there is no stop to ask for.
  for (const apiVariant of ["gemini", "kimi-k3"] as const) {
    const plan = describeEvolveBudget(model({ apiVariant }));
    assert.equal(plan.thinking.effective, "enabled");
    assert.match(plan.thinking.note ?? "", /no "disabled" mode/);
    assert.deepEqual(plan.perCallCeiling, { openevolve: 128_000, puct: 96_000 });
  }
});

test("the note names the cause when the profile says thinking cannot be stopped", () => {
  // A fact is the operator's own statement; saying "no thinking-control field"
  // would point them at a dialect when the thing they configured is the cause.
  const plan = describeEvolveBudget(model({ apiVariant: "deepseek", facts: { thinkingSupported: false } }));
  assert.equal(plan.thinking.effective, "enabled");
  assert.match(plan.thinking.note ?? "", /recorded as not honoring thinking control/);
});

test("an endpoint that can stop thinking is priced as asked", () => {
  const plan = describeEvolveBudget(model({ apiVariant: "deepseek" }));
  assert.equal(plan.thinking.effective, "disabled");
  assert.equal(plan.thinking.note, undefined);
  assert.deepEqual(plan.perCallCeiling, { openevolve: 16_000, puct: 16_000 });
});

test("an explicitly requested thinking run says nothing was overridden", () => {
  const plan = describeEvolveBudget(model({ apiVariant: "deepseek" }), "enabled");
  assert.equal(plan.thinking.effective, "enabled");
  assert.equal(plan.thinking.note, undefined);
  assert.deepEqual(plan.perCallCeiling, { openevolve: 128_000, puct: 96_000 });
});
