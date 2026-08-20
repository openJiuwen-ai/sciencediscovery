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

import type { WorkspaceAgentOptions } from "@sciencediscovery/context";
import type {
  ArtifactDownloadResult,
  JsonValue,
  McpToolResult,
  PermissionRequest,
} from "@sciencediscovery/schema";
import type { McpSourceRegistry } from "@sciencediscovery/mcp-sources";

import type { AgentPermissionRuntime } from "../agent-run/permission-runtime.js";
import type { PaperService } from "../papers.js";
import type { SessionStore } from "../store.js";
import type { ArtifactManager } from "./artifact-manager.js";
import type { McpGovernanceBroker } from "./broker.js";
import type { McpSourceCatalog } from "./source-catalog.js";

type McpWorkspaceTools = Pick<
  WorkspaceAgentOptions,
  "artifactDownload" | "mcpTools" | "paperExtractPdf"
>;

export interface McpWorkspaceToolOptions {
  artifactManager: ArtifactManager;
  broker: McpGovernanceBroker;
  catalog: McpSourceCatalog;
  enabledSourceIds: readonly string[];
  emitPermissionRequest(request: PermissionRequest): void;
  pauseExternalWait(): () => void;
  paperService: PaperService;
  permission: AgentPermissionRuntime;
  projectId: string;
  registry: McpSourceRegistry;
  sessionId: string;
  store: SessionStore;
  /** Keep Reviewer searches out of the session Memory Graph. */
  suppressMemoryGraphMirror?: boolean;
  turnId: string;
  workspacePathPrefix?: string;
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
  const mcpTools: NonNullable<WorkspaceAgentOptions["mcpTools"]> = options.registry.list()
    .filter((adapter) => enabledSourceIds.has(adapter.manifest.id))
    .flatMap((adapter) => {
      const availableTools = new Set(options.catalog.getStatus(adapter.manifest.id).availableTools);
      return Object.values(adapter.manifest.tools)
        .filter((tool) => availableTools.has(tool.id))
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

  return {
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
    paperExtractPdf: async ({ artifactJobId }, signal) => {
      const artifact = await options.artifactManager.getCompletedArtifact(
        options.sessionId,
        artifactJobId,
      );
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
