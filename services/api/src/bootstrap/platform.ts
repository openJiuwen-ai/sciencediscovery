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

import { resolve } from "node:path";

import { McpSourceCatalog, type McpTransportClient } from "@science-agent/data-source";
import { RemoteComputeClient } from "@science-agent/executor";
import { createBuiltinMcpSourceRegistry } from "@science-agent/mcp-sources";
import { shortErrorMessage } from "@science-agent/operational-logging";
import { reviewerLog } from "@science-agent/provenance";
import type { ResolvedProxy } from "@science-agent/schema";

import { apiLog, configureApiLogging } from "../logging.js";
import { MemoryGraphClient, MemoryGraphSink, mgLog } from "@science-agent/memory";
import { GovernedDownloadManager } from "@science-agent/artifact-manager";
import { McpGovernanceBroker } from "@science-agent/data-source";
import { McpNodeClient } from "../mcp/node-client.js";
import { PaperService } from "../papers.js";
import { PermissionDecisionQueue } from "@science-agent/governance";
import { ProvenanceRecorder } from "@science-agent/provenance";
import { RunnerClient } from "@science-agent/executor";
import { recoverSessionRuns, scheduleSessionRuns } from "../runs/index.js";
import { SkillCatalog } from "@science-agent/specialist";
import { SessionStore } from "../store.js";
import { NativeWebProviderClient, WebBroker } from "@science-agent/data-source";
import type { ServerConfig } from "./config.js";

export interface ApiServerDependencies {
  connectorFetch?: typeof fetch;
  /** Test seam: drive MCP through a stub transport instead of live servers. */
  mcpTransport?: McpTransportClient;
}

/**
 * The API composition root. It selects concrete adapters and wires domain
 * components, while the HTTP layer is limited to protocol translation.
 */
export function createPlatformServices(
  config: ServerConfig,
  repositoryRoot: string,
  dependencies: ApiServerDependencies = {},
) {
  configureApiLogging(config.dataDir);
  const store = new SessionStore(config.dataDir, {
    gatewayIdleTimeoutMs: config.gatewayIdleTimeoutMs,
    gatewayTurnTimeoutMs: config.gatewayTurnTimeoutMs,
    kernelIdleTimeoutMs: config.kernelIdleTimeoutMs,
    permissionWaitTimeoutMs: config.permissionWaitTimeoutMs,
    runnerExecTimeoutMs: config.runnerExecTimeoutMs,
  }, {
    runnerMaxOutputBytes: config.runnerMaxOutputBytes,
    runnerMaxWorkspaceBytes: config.runnerMaxWorkspaceBytes,
    uploadMaxFileBytes: config.workspaceUpload.maxFileBytes,
    uploadMaxRequestBytes: config.workspaceUpload.maxRequestBytes,
  }, config.memoryGraph.neo4jPassword);
  const skillCatalog = new SkillCatalog(config.dataDir, repositoryRoot);
  const runnerClient = new RunnerClient(config.runnerUrl, config.runnerToken);

  mgLog.setDataDir(config.dataDir);
  reviewerLog.setLogDir(resolve(config.dataDir, "logs"));
  mgLog.setToggle(() => store.getMemoryGraphSettings().enabled);

  const memoryGraphClient = new MemoryGraphClient({
    url: config.memoryGraph.url,
    token: config.memoryGraph.internalToken,
  });
  const memoryGraphSink = new MemoryGraphSink(memoryGraphClient, () => store.getMemoryGraphSettings().enabled);
  const memoryGraphEnabled = () => store.getMemoryGraphSettings().enabled;
  const provenanceRecorder = new ProvenanceRecorder(config.dataDir, store, memoryGraphSink);
  const mcpRegistry = createBuiltinMcpSourceRegistry();
  const mcpGateway: McpTransportClient = dependencies.mcpTransport ?? new McpNodeClient();
  const mcpProxyMap = (): Record<string, ResolvedProxy> => {
    const serverIds = new Set<string>();
    for (const manifest of mcpRegistry.listManifests()) serverIds.add(manifest.transport.mcpServerId);
    for (const serverId of Object.keys(store.getMcpProxyPolicies())) serverIds.add(serverId);
    const map: Record<string, ResolvedProxy> = {};
    for (const serverId of serverIds) {
      try {
        map[serverId] = store.resolveProxy(store.mcpProxyPolicy(serverId));
      } catch {
        // Resolution errors are surfaced on invoke instead of blocking startup.
      }
    }
    return map;
  };
  const mcpCatalog = new McpSourceCatalog(mcpRegistry, mcpGateway, mcpProxyMap);
  const webBroker = new WebBroker(config.dataDir, store, new NativeWebProviderClient());
  const mcpBroker = new McpGovernanceBroker(
    config.dataDir,
    store,
    mcpRegistry,
    mcpCatalog,
    mcpGateway,
    { memoryGraphSink },
  );
  const paperService = new PaperService(store, config.paperPythonPath, config.paperWorkerPath);
  const artifactManager = new GovernedDownloadManager(
    store,
    mcpRegistry,
    mcpBroker,
    dependencies.connectorFetch ?? fetch,
  );
  artifactManager.setCompletedHandler(async ({ candidate, job, plan }) => {
    await provenanceRecorder.registerWorkspaceArtifact({
      logicalName: candidate.logicalName,
      origin: "mcp_download",
      originMeta: {
        artifactJobId: job.id,
        license: candidate.license,
        sourceId: candidate.sourceId,
        sourceRecordId: candidate.sourceRecordId,
        sourceUrl: candidate.sourceUrl,
      },
      path: plan.destination.path,
      sessionId: job.sessionId,
      sourcePath: plan.destination.path,
      title: candidate.logicalName,
      workspaceRoot: store.workspacePath(job.sessionId),
    });
  });

  return {
    artifactManager,
    mcpBroker,
    mcpCatalog,
    mcpGateway,
    mcpRegistry,
    memoryGraphClient,
    memoryGraphEnabled,
    memoryGraphSink,
    paperService,
    permissionDecisions: new PermissionDecisionQueue(),
    provenanceRecorder,
    remoteCompute: new RemoteComputeClient(config.sshConfigPath),
    runnerClient,
    skillCatalog,
    store,
    webBroker,
  };
}

export type PlatformServices = ReturnType<typeof createPlatformServices>;

/** Restore durable work and make the composed platform ready for requests. */
export async function initializePlatformServices(
  services: PlatformServices,
  config: ServerConfig,
): Promise<void> {
  const {
    artifactManager,
    mcpBroker,
    mcpCatalog,
    mcpRegistry,
    memoryGraphClient,
    memoryGraphSink,
    paperService,
    provenanceRecorder,
    remoteCompute,
    runnerClient,
    skillCatalog,
    store,
    webBroker,
  } = services;
  await skillCatalog.load();
  store.setAvailableSkillIds(skillCatalog.ids());
  await store.load();
  await mcpCatalog.refresh().catch((error) => {
    apiLog.warn("mcp_catalog_startup_failed", { errorMessage: shortErrorMessage(error) });
    console.warn("MCP catalog was unavailable during API startup:", error);
  });
  await artifactManager.resumeInterrupted();
  await recoverSessionRuns(store, memoryGraphClient);

  const storedNeo4jPassword = store.getMemoryGraphNeo4jPassword();
  if (storedNeo4jPassword) {
    mgLog.info("startup: pushing stored Neo4j credential to memory-graph");
    const connection = store.getMemoryGraphSettings();
    await memoryGraphClient
      .pushNeo4jPassword(storedNeo4jPassword, { httpUri: connection.neo4jHttp, user: connection.neo4jUser })
      .then(() => mgLog.info("startup: credential push complete"))
      .catch((error) => {
        mgLog.warn(
          "startup: credential push failed (non-fatal): %s",
          error instanceof Error ? error.message : String(error),
        );
      });
  } else {
    mgLog.info("startup: no stored Neo4j password, skipping push (set it in System Settings → Memory graph)");
  }

  for (const project of store.listProjects()) {
    for (const session of store.listSessions(project.id, "all")) {
      if (!(await store.listSessionRuns(session.id)).some((run) => run.status === "queued")) continue;
      scheduleSessionRuns(
        store,
        runnerClient,
        provenanceRecorder,
        mcpBroker,
        webBroker,
        mcpRegistry,
        mcpCatalog,
        artifactManager,
        paperService,
        remoteCompute,
        skillCatalog,
        memoryGraphSink,
        session.id,
        config,
        memoryGraphClient,
      );
    }
  }
}
