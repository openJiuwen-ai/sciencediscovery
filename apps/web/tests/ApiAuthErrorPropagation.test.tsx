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


import { ApiClient, ApiRequestError } from "../src/api.js";
import { isAuthFailure } from "../src/api/auth.js";

const signal = new AbortController().signal;
const requests: Record<string, (client: ApiClient) => Promise<unknown>> = {
  projects: (client) => client.listProjects(),
  usageExport: (client) => client.exportModelUsageAnalytics("csv"),
  runEvents: (client) => client.subscribeRunEvents("session", "run", 0, () => undefined),
  messageStream: (client) => client.streamMessage("session", { content: "hello" }, () => undefined),
  evolveEvents: (client) => client.subscribeEvolveEvents("run", 0, () => undefined),
  ideaEvents: (client) => client.subscribeIdeaResearch("session", "research", () => undefined, signal),
  pluginEvents: (client) => client.subscribePlugins({ projectId: "project" }, () => undefined, signal),
  artifact: (client) => client.readArtifactVersion("session", "version"),
  projectArtifact: (client) => client.readProjectArtifactVersion("project", "version"),
  file: (client) => client.readFile("session", "file.txt"),
  webPage: (client) => client.readWebPageContent("session", "page"),
  casText: (client) => client.readCas("hash"),
  trajectoryExport: (client) => client.trajectory.export("session", signal),
};

for (const [name, request] of Object.entries(requests)) {
  for (const status of [401, 500] as const) {
    test(`${name} preserves HTTP ${status} for the final error reporter`, async () => {
      const previousFetch = globalThis.fetch;
      let prompts = 0;
      globalThis.fetch = async () => Response.json({ error: "request rejected" }, { status });
      try {
        await assert.rejects(request(new ApiClient("token", () => { prompts += 1; })), (reason: unknown) => {
          assert.ok(reason instanceof ApiRequestError);
          assert.equal(reason.status, status);
          assert.equal(isAuthFailure(reason), status === 401);
          assert.ok(reason.message);
          return true;
        });
        assert.equal(prompts, status === 401 ? 1 : 0);
      } finally {
        globalThis.fetch = previousFetch;
      }
    });
  }
}
