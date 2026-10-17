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

import type { WorkspaceAgentOptions } from "@sciencediscovery/workspace";
import type {
  ArtifactDownloadResult,
  ArtifactCandidate,
  ArtifactExtractionJob,
  JsonValue,
  McpToolResult,
  McpInvocation,
  PaperAcquisition,
  PermissionRequest,
} from "@sciencediscovery/schema";
import type { McpSourceRegistry } from "@sciencediscovery/mcp-sources";

import type { AgentPermissionRuntime } from "@sciencediscovery/governance";
import type { GovernedDownloadManager } from "./governed-download-manager.js";
import type { McpGovernanceBroker } from "@sciencediscovery/data-source";
import type { McpSourceCatalog } from "@sciencediscovery/data-source";

type McpWorkspaceTools = Pick<
  WorkspaceAgentOptions,
  "artifactDownload" | "mcpTools" | "paperExtractPdf" | "mcpReadiness"
>;

export interface McpInvocationStore {
  listMcpInvocations(sessionId: string): Promise<McpInvocation[]>;
  executionBlocks?: { wait(input: Omit<import("@sciencediscovery/schema").ExecutionBlock, "id" | "createdAt">, signal?: AbortSignal): Promise<import("@sciencediscovery/schema").ExecutionBlockDecision> };
}

export interface PaperExtractionPort {
  extractArtifact(input: {
    artifactJobId: string;
    candidate: ArtifactCandidate;
    outputPathPrefix?: string;
    path: string;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<{ acquisition: PaperAcquisition; job: ArtifactExtractionJob }>;
  extractWorkspacePdf(input: {
    outputPathPrefix?: string;
    path: string;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<PaperAcquisition>;
}

export interface McpWorkspaceToolOptions {
  artifactManager: GovernedDownloadManager;
  broker: McpGovernanceBroker;
  catalog: McpSourceCatalog;
  enabledSourceIds: readonly string[];
  reportReadiness?(summary: string): void;
  emitPermissionRequest(request: PermissionRequest): void;
  pauseExternalWait(): () => void;
  paperService: PaperExtractionPort;
  permission: AgentPermissionRuntime;
  projectId: string;
  registry: McpSourceRegistry;
  sessionId: string;
  store: McpInvocationStore;
  /** Keep Reviewer searches out of the session Memory Graph. */
  suppressMemoryGraphMirror?: boolean;
  turnId: string;
  workspacePathPrefix?: string;
  /** When set, this workspace runs inside a subagent: passed through to
   * broker.invoke so products hang off the subagent's child SubTask. Absent
   * in main-agent context — behavior unchanged. */
  parentSubagentId?: string;
}

function safeLogicalName(value: string, fallback: string): string {
  return value.replaceAll(/[^A-Za-z0-9._/-]/g, "_") || fallback;
}

function prefixedWorkspacePath(path: string, prefix: string | undefined): string {
  const cleaned = path.trim().replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!prefix) return cleaned;
  const cleanedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  if (!cleanedPrefix || cleaned === cleanedPrefix || cleaned.startsWith(`${cleanedPrefix}/`)) return cleaned;
  return `${cleanedPrefix}/${cleaned}`;
}

function unprefixedWorkspacePath(path: string | undefined, prefix: string | undefined): string | undefined {
  if (!path || !prefix) return path;
  const cleanedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  if (path === cleanedPrefix) return "";
  return path.startsWith(`${cleanedPrefix}/`) ? path.slice(cleanedPrefix.length + 1) : path;
}

export function createMcpWorkspaceTools(options: McpWorkspaceToolOptions): McpWorkspaceTools {
  const enabledSourceIds = new Set(options.enabledSourceIds);
  const statuses = () => options.registry.list()
    .filter((adapter) => enabledSourceIds.has(adapter.manifest.id))
    .map((adapter) => options.catalog.getStatus(adapter.manifest.id));
  const unhealthy = () => statuses().filter((status) => status.status !== "ready" || !status.availableTools.length);
  const guidance = "Inspect MCP settings and /api/mcp/sources. Repair or enable the configured server, then reload the catalog via POST /api/mcp/sources/reload. Host changes require user authorization; sandbox scripts cannot repair control-plane MCP.";
  const diagnostics = () => ({ sources: statuses(), guidance,
    omittedTools: unhealthy().map(status => ({ sourceId: status.sourceId, tools: status.missingTools })) });
  const buildTools = (): NonNullable<WorkspaceAgentOptions["mcpTools"]> => options.registry.list()
    .filter((adapter) => enabledSourceIds.has(adapter.manifest.id))
    .flatMap((adapter) => {
      return Object.values(adapter.manifest.tools)
        .map((tool) => ({
          description: [
            tool.description,
            tool.promptFragment,
            adapter.manifest.prompt.summary,
            adapter.manifest.prompt.citationPolicy,
            ...adapter.manifest.prompt.caveats,
          ].filter(Boolean).join(" "),
          displayName: `${adapter.manifest.displayName}: ${tool.displayName}`,
          execute: async (toolCallId: string, input: JsonValue, signal?: AbortSignal) => {
            const response = await options.broker.invoke({
              allowedSourceIds: [...enabledSourceIds],
              authorize: (action, resource, summary, permissionSignal) => {
                if (action !== "connector") {
                  throw new Error(`MCP tools cannot request ${action} permission`);
                }
                return options.permission.requirePrivilege({
                  action,
                  executionId: options.turnId,
                  resource,
                  signal: permissionSignal,
                  summary,
                  toolCallId,
                });
              },
              input,
              projectId: options.projectId,
              sessionId: options.sessionId,
              signal,
              sourceId: adapter.manifest.id,
              ...(options.suppressMemoryGraphMirror ? { suppressMemoryGraphMirror: true } : {}),
              toolCallId,
              toolId: tool.id,
              turnId: options.turnId,
              parentSubagentId: options.parentSubagentId,
            });
            return {
              ...response.result,
              invocationId: response.invocation.id,
            };
          },
          inputSchema: tool.inputSchema,
          name: `mcp__${adapter.manifest.id.replace(/[^A-Za-z0-9_-]/g, "_")}__${tool.id.replace(/[^A-Za-z0-9_-]/g, "_")}`,
          routing: tool.routing,
          sourceId: adapter.manifest.id,
          toolId: tool.id,
        }));
    });

  const initiallyUnhealthy = new Set(unhealthy().map(status => status.sourceId));
  if (initiallyUnhealthy.size) options.reportReadiness?.(unhealthy().map(status =>
    `${status.sourceId}: ${status.status}; ${status.missingTools.length
      ? `omitted tools: ${status.missingTools.join(", ")}`
      : "no tools injected; tool list unavailable until discovery succeeds"}.`).join("\n"));
  const mcpTools = buildTools().filter(tool => options.catalog.getStatus(tool.sourceId).availableTools.includes(tool.toolId));
  // Custom servers can have no manifest tools at setup. Rebuild from discovery
  // after repair, but never expand beyond the initially affected source selection
  // or expose an already mounted tool through the recovery entry point.
  const recoveredTools = () => buildTools().filter(tool => initiallyUnhealthy.has(tool.sourceId)
    && !mcpTools.some(mounted => mounted.sourceId === tool.sourceId && mounted.toolId === tool.toolId)
    && options.catalog.getStatus(tool.sourceId).availableTools.includes(tool.toolId));
  return {
    ...(unhealthy().length ? { mcpReadiness: {
      summary: JSON.stringify(diagnostics()),
      decide: async (action, reason, sourceIds, signal, toolCallId) => {
        signal?.throwIfAborted();
        if (action === "check") await options.catalog.refresh(signal);
        if (action === "wait") {
          if (!sourceIds.length || sourceIds.some(id => !enabledSourceIds.has(id))) throw new Error("Choose enabled MCP sources that block this task");
          const affected = unhealthy().filter(status => sourceIds.includes(status.sourceId));
          if (affected.length) {
            if (!options.store.executionBlocks) throw new Error("Interactive MCP repair is unavailable; provide repair guidance and stop this task");
            const release = options.pauseExternalWait();
            try {
              const decision = await options.store.executionBlocks.wait({
                kind: "mcp", sessionId: options.sessionId, executionId: options.turnId,
                runnerId: "MCP", operationId: toolCallId, toolCallId,
                agentId: options.parentSubagentId ?? "main", summary: reason,
                reason: affected.map(status => `${status.sourceId}: ${status.status}; omitted tools: ${status.missingTools.join(", ")}`).join("; "),
                suggestions: [guidance], alternatives: [],
              }, signal);
              signal?.throwIfAborted();
              if (decision.action !== "retry") return { ...diagnostics(), action: "cancel", instruction: "Repair wait cancelled or expired. Stop the blocked task; do not silently substitute another source." };
              await options.catalog.refresh(signal);
            } finally { release(); }
          }
        }
        return { ...diagnostics(), action, reason,
          recoveredTools: recoveredTools()
            .map(({ sourceId, toolId, inputSchema }) => ({ sourceId, toolId, inputSchema })),
          instruction: "Assess current status. If an important source is still unavailable, wait again or explain and stop. Recovered omitted tools can be invoked with mcp_recovered_call; normal permissions apply. Never claim an omitted tool ran." };
      },
      invoke: async (sourceId, toolId, input, signal, toolCallId) => {
        const tool = recoveredTools().find(tool => tool.sourceId === sourceId && tool.toolId === toolId);
        if (!tool) throw new Error("Tool is not a recovered MCP tool from this run's selection");
        return tool.execute(toolCallId, input, signal);
      },
    } satisfies NonNullable<WorkspaceAgentOptions["mcpReadiness"]> } : {}),
    artifactDownload: async (input, signal): Promise<ArtifactDownloadResult> => {
      const invocation = (await options.store.listMcpInvocations(options.sessionId))
        .find((item) => item.id === input.mcpInvocationId);
      if (!invocation?.normalizedResult) throw new Error("MCP invocation result is unavailable");
      const normalized = JSON.parse(
        (await options.broker.cas.read(invocation.normalizedResult.hash)).toString("utf8"),
      ) as McpToolResult;
      const candidate = normalized.artifacts?.find((item) => item.id === input.candidateId);
      if (!candidate) throw new Error("Artifact candidate was not returned by the selected MCP invocation");
      const creation = await options.artifactManager.prepare(options.sessionId, {
        candidateId: candidate.id,
        destination: {
          path: prefixedWorkspacePath(
            input.destinationPath ?? `downloads/${safeLogicalName(candidate.logicalName, `${candidate.id}.bin`)}`,
            options.workspacePathPrefix,
          ),
          type: "workspace",
        },
        mcpInvocationId: invocation.id,
      });
      if (creation.permissionRequest) options.emitPermissionRequest(creation.permissionRequest);

      const releaseExternalWait = options.pauseExternalWait();
      try {
        const terminal = await options.artifactManager.waitForPlanTerminal(
          options.sessionId,
          creation.plan.id,
          signal,
        );
        if (terminal.status === "completed" && terminal.job) {
          return {
            actualChecksum: terminal.job.actualChecksum,
            bytesDownloaded: terminal.job.progress.bytesDownloaded,
            candidateId: candidate.id,
            finalPath: unprefixedWorkspacePath(terminal.job.finalPath, options.workspacePathPrefix),
            jobId: terminal.job.id,
            planId: creation.plan.id,
            sourceId: candidate.sourceId,
            sourceRecordId: candidate.sourceRecordId,
            status: "completed",
          };
        }
        const error = terminal.status === "denied"
          ? {
              code: "PERMISSION_DENIED" as const,
              message: `Artifact download was denied for ${candidate.logicalName}`,
              retryable: false,
            }
          : terminal.job?.error ?? {
              code: terminal.status === "cancelled" ? "CANCELLED" as const : "NOT_FOUND" as const,
              message: `Artifact download ${terminal.status} for ${candidate.logicalName}`,
              retryable: false,
            };
        return {
          bytesDownloaded: terminal.job?.progress.bytesDownloaded ?? 0,
          candidateId: candidate.id,
          error,
          ...(terminal.job ? { jobId: terminal.job.id } : {}),
          planId: creation.plan.id,
          sourceId: candidate.sourceId,
          sourceRecordId: candidate.sourceRecordId,
          status: terminal.status,
        };
      } finally {
        releaseExternalWait();
      }
    },
    mcpTools,
    paperExtractPdf: async ({ artifactJobId, path: workspacePath }, signal) => {
      if (!artifactJobId) {
        const relative = (workspacePath ?? "").trim().replace(/^\/workspace\//, "");
        if (!/\.pdf$/i.test(relative)) throw new Error("paper_extract_pdf path must name a .pdf file in the workspace");
        const releaseExternalWait = options.pauseExternalWait();
        try {
          const acquisition = await options.paperService.extractWorkspacePdf({
            outputPathPrefix: options.workspacePathPrefix,
            path: prefixedWorkspacePath(relative, options.workspacePathPrefix),
            sessionId: options.sessionId,
            signal,
          });
          const analysisRoot = acquisition.manifestPath.slice(0, acquisition.manifestPath.lastIndexOf("/"));
          return {
            manifestPath: unprefixedWorkspacePath(acquisition.manifestPath, options.workspacePathPrefix),
            pageCount: acquisition.extraction.pageCount,
            paperAcquisitionId: acquisition.id,
            sourcePdfPath: relative,
            textPath: unprefixedWorkspacePath(`${analysisRoot}/${acquisition.extraction.textPath}`, options.workspacePathPrefix),
            warnings: acquisition.extraction.warnings,
          };
        } finally {
          releaseExternalWait();
        }
      }
      const artifact = await options.artifactManager.getCompletedArtifact(
        options.sessionId,
        artifactJobId,
      );
      const path = artifact.job.finalPath ?? "";
      const prefix = options.workspacePathPrefix?.replace(/^\/+|\/+$/g, "");
      if (prefix ? !path.startsWith(`${prefix}/`) : path.startsWith("subagents/")) {
        throw new Error("Paper input belongs to another Agent Workspace; request explicit file delivery");
      }
      if (artifact.candidate.kind !== "paper" || artifact.candidate.format.toLowerCase() !== "pdf") {
        throw new Error("paper_extract_pdf accepts only completed PDF paper artifacts");
      }
      const releaseExternalWait = options.pauseExternalWait();
      try {
        const { acquisition, job } = await options.paperService.extractArtifact({
          artifactJobId,
          candidate: artifact.candidate,
          outputPathPrefix: options.workspacePathPrefix,
          path: artifact.job.finalPath!,
          sessionId: options.sessionId,
          signal,
        });
        const analysisRoot = acquisition.manifestPath.slice(0, acquisition.manifestPath.lastIndexOf("/"));
        return {
          artifactJobId,
          extractionJobId: job.id,
          manifestPath: unprefixedWorkspacePath(acquisition.manifestPath, options.workspacePathPrefix),
          pageCount: acquisition.extraction.pageCount,
          paperAcquisitionId: acquisition.id,
          sourcePdfPath: unprefixedWorkspacePath(artifact.job.finalPath, options.workspacePathPrefix),
          textPath: unprefixedWorkspacePath(`${analysisRoot}/${acquisition.extraction.textPath}`, options.workspacePathPrefix),
          warnings: acquisition.extraction.warnings,
        };
      } finally {
        releaseExternalWait();
      }
    },
  };
}
