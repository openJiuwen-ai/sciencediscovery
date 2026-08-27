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
import { test } from "node:test";

import type { EvolveGoal } from "@sciencediscovery/schema";

import { evolveArtifactName } from "./platform.js";

function goalWith(target: EvolveGoal["target"]): EvolveGoal {
  return { target } as EvolveGoal;
}

test("每个 run 的结果 artifact 有自己的名字，不跨 run 归并", () => {
  // Measured before the fix: every scripted search's entrypoint is the literal
  // `candidate.py`, so compression, peak-detection and enzyme-kinetics runs in
  // one project piled into a single artifact ten versions deep — interleaved
  // with versions the sessions' own agents had declared under that name.
  const enzyme = evolveArtifactName({
    goal: goalWith({ entrypoint: "candidate.py", kind: "program", programId: "x" }),
    id: "23601271-aaaa-bbbb-cccc-000000000000",
  });
  const peaks = evolveArtifactName({
    goal: goalWith({ entrypoint: "candidate.py", kind: "program", programId: "y" }),
    id: "1181371b-aaaa-bbbb-cccc-000000000000",
  });
  assert.equal(enzyme, "evolve/23601271/candidate.py");
  assert.notEqual(enzyme, peaks);
});

test("文本目标和不合法的入口路径也各有落点", () => {
  const text = evolveArtifactName({
    goal: goalWith({ contentCas: "sha256:x", kind: "text", label: "摘要" }),
    id: "abcd1234-0000-0000-0000-000000000000",
  });
  assert.equal(text, "evolve/abcd1234/evolved.md");
  const dodgy = evolveArtifactName({
    goal: goalWith({ entrypoint: "../../etc/passwd", kind: "program", programId: "z" }),
    id: "deadbeef-0000-0000-0000-000000000000",
  });
  assert.equal(dodgy, "evolve/deadbeef/result.txt");
});
