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

import { createBuiltinMcpSourceRegistry } from "@science-agent/mcp-sources";

import type { AgentPermissionRuntime } from "../agent-run/permission-runtime.js";
import type { PaperService } from "../papers.js";
import type { SessionStore } from "../store.js";
import type { ArtifactManager } from "./artifact-manager.js";
import type { McpGovernanceBroker } from "./broker.js";
import type { McpSourceCatalog } from "./source-catalog.js";
import { createMcpWorkspaceTools } from "./workspace-tools.js";

test("Reviewer MCP tools suppress Memory Graph mirroring", async () => {
  const requests: Array<{ suppressMemoryGraphMirror?: boolean }> = [];
  const tools = createMcpWorkspaceTools({
    artifactManager: {} as ArtifactManager,
    broker: {
      async invoke(request: { suppressMemoryGraphMirror?: boolean }) {
        requests.push(request);
        return { invocation: { id: "reviewer-search" }, result: {} };
      },
    } as unknown as McpGovernanceBroker,
    catalog: {
      getStatus() { return { availableTools: ["search"] }; },
    } as unknown as McpSourceCatalog,
    enabledSourceIds: ["uniprot"],
    emitPermissionRequest() {},
    pauseExternalWait: () => () => undefined,
    paperService: {} as PaperService,
    permission: {} as AgentPermissionRuntime,
    projectId: "project-1",
    registry: createBuiltinMcpSourceRegistry(),
    sessionId: "session-1",
    store: {} as SessionStore,
    suppressMemoryGraphMirror: true,
    turnId: "reviewer-checkpoint-1",
  });

  const search = tools.mcpTools?.find((tool) => tool.sourceId === "uniprot" && tool.toolId === "search");
  assert.ok(search);
  await search.execute("tool-call-1", { query: "TP53" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.suppressMemoryGraphMirror, true);
});

test("artifact download waits for its terminal job and releases the AgentRun deadline", async () => {
  const candidate = {
    attribution: "Example",
    format: "pdf",
    id: "candidate-1",
    kind: "paper",
    license: "open",
    logicalName: "paper.pdf",
    mimeType: "application/pdf",
    sourceId: "pubmed",
    sourceRecordId: "123",
    sourceUrl: "https://example.test/paper.pdf",
  };
  const normalizedResult = Buffer.from(JSON.stringify({
    artifacts: [candidate],
    citations: [],
    records: [],
  }));
  const emitted: string[] = [];
  let pauseCount = 0;
  let releaseCount = 0;
  const tools = createMcpWorkspaceTools({
    artifactManager: {
      async prepare() {
        return {
          permissionRequest: { id: "permission-1" },
          plan: { id: "plan-1" },
        };
      },
      async waitForPlanTerminal() {
        return {
          job: {
            actualChecksum: "sha256:abc",
            finalPath: "downloads/paper.pdf",
            id: "job-1",
            progress: { bytesDownloaded: 42 },
          },
          status: "completed",
        };
      },
    } as unknown as ArtifactManager,
    broker: {
      cas: {
        async read() {
          return normalizedResult;
        },
      },
    } as unknown as McpGovernanceBroker,
    catalog: {} as McpSourceCatalog,
    enabledSourceIds: [],
    emitPermissionRequest: (request) => emitted.push(request.id),
    pauseExternalWait: () => {
      pauseCount += 1;
      return () => {
        releaseCount += 1;
      };
    },
    paperService: {} as PaperService,
    permission: {} as AgentPermissionRuntime,
    projectId: "project-1",
    registry: { list: () => [] } as never,
    sessionId: "session-1",
    store: {
      async listMcpInvocations() {
        return [{
          id: "invocation-1",
          normalizedResult: { hash: "a".repeat(64), size: normalizedResult.length },
        }];
      },
    } as unknown as SessionStore,
    turnId: "turn-1",
  });

  const result = await tools.artifactDownload!({
    candidateId: candidate.id,
    mcpInvocationId: "invocation-1",
  });
  assert.deepEqual(emitted, ["permission-1"]);
  assert.equal(pauseCount, 1);
  assert.equal(releaseCount, 1);
  assert.deepEqual(result, {
    actualChecksum: "sha256:abc",
    bytesDownloaded: 42,
    candidateId: "candidate-1",
    finalPath: "downloads/paper.pdf",
    jobId: "job-1",
    planId: "plan-1",
    sourceId: "pubmed",
    sourceRecordId: "123",
    status: "completed",
  });
});

test("artifact download scopes subagent workspace paths to the private prefix", async () => {
  const candidate = {
    attribution: "Example",
    format: "pdf",
    id: "candidate-1",
    kind: "paper",
    license: "open",
    logicalName: "paper.pdf",
    mimeType: "application/pdf",
    sourceId: "pubmed",
    sourceRecordId: "123",
    sourceUrl: "https://example.test/paper.pdf",
  };
  const normalizedResult = Buffer.from(JSON.stringify({
    artifacts: [candidate],
    citations: [],
    records: [],
  }));
  let preparedPath = "";
  const tools = createMcpWorkspaceTools({
    artifactManager: {
      async prepare(_sessionId: string, input: { destination: { path: string } }) {
        preparedPath = input.destination.path;
        return { plan: { id: "plan-1" } };
      },
      async waitForPlanTerminal() {
        return {
          job: {
            actualChecksum: "sha256:abc",
            finalPath: "subagents/subagent-1/downloads/paper.pdf",
            id: "job-1",
            progress: { bytesDownloaded: 42 },
          },
          status: "completed",
        };
      },
    } as unknown as ArtifactManager,
    broker: {
      cas: {
        async read() {
          return normalizedResult;
        },
      },
    } as unknown as McpGovernanceBroker,
    catalog: {} as McpSourceCatalog,
    enabledSourceIds: [],
    emitPermissionRequest() {},
    pauseExternalWait: () => () => undefined,
    paperService: {} as PaperService,
    permission: {} as AgentPermissionRuntime,
    projectId: "project-1",
    registry: { list: () => [] } as never,
    sessionId: "session-1",
    store: {
      async listMcpInvocations() {
        return [{
          id: "invocation-1",
          normalizedResult: { hash: "a".repeat(64), size: normalizedResult.length },
        }];
      },
    } as unknown as SessionStore,
    turnId: "turn-1",
    workspacePathPrefix: "subagents/subagent-1",
  });

  const result = await tools.artifactDownload!({
    candidateId: candidate.id,
    mcpInvocationId: "invocation-1",
  });

  assert.equal(preparedPath, "subagents/subagent-1/downloads/paper.pdf");
  assert.equal(result.finalPath, "downloads/paper.pdf");
});
