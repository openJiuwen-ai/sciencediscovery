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
import { runIdeaResearchProtocolJourney } from "../../../../test/api/idea-research-protocol-journey.mjs";

test("public IdeaTree entry completes actual Python research through all three native protocol families", async () => {
  // UT prepares the locked evolve venv; independent ST deliberately does not.
  await runIdeaResearchProtocolJourney();
});

// A missing prerequisite must reject readably, close its fixture, and leave no hung child.
test("public research journey reports and cleans up a child launch failure", async () => {
  const { default: assert } = await import("node:assert/strict");
  await assert.rejects(runIdeaResearchProtocolJourney({ pythonExecutable: "/nonexistent/issue-388-python" }), /sidecar could not start:.*ENOENT/);
});
