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

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  buildWorkspaceSystemPrompt,
  type WorkspaceAgentOptions,
  WORKSPACE_SYSTEM_PROMPT_VERSION,
} from "@sciencediscovery/context";
import type { AgentConfig } from "@sciencediscovery/model";
import { createMainAgentProfile, createSubagentProfile, resolveSubagentConfig } from "@sciencediscovery/orchestration";
import { createEvidenceReferenceTracer } from "@sciencediscovery/provenance";
import { resolveWorkspaceFile } from "@sciencediscovery/workspace";
import type {
  ArtifactCandidate,
  AnalyzePaperVisionRequest,
  CancelRunResult,
  ChatMessage,
  ComposerReference,
  MemoryGraphEdgeType,
  MemoryGraphNodeLabel,
  MemoryGraphTraceResult,
  CreateEnvironmentRequest,
  CreateSkillDialogueDraftRequest,
  CreateArtifactAnnotationRequest,
  CreateArtifactPlanRequest,
  CreateSkillRequest,
  CreateModelProfileRequest,
  CreateProjectRequest,
  CreatePermissionRequest,
  CreateProxyServerRequest,
  CreateRemoteJobRequest,
  CreateSessionRequest,
  CreateSpecialistRequest,
  DecidePermissionRequest,
  DecideRemoteJobRequest,
  JsonSchema,
  Subagent,
  SubagentInput,
  UpdateSubagentBriefRequest,
  UpdateEnvironmentSourceSettingsRequest,
  UpdateMcpProxyPoliciesRequest,
  UpdateProxyServerRequest,
  UpdateProxySettingsRequest,
  UpdateWebSettingsRequest,
  UpdateMemoryGraphSettingsRequest,
  DistillSessionSkillRequest,
  Environment,
  EffectiveRuntimeSettings,
  DeleteResourceRequest,
  ImportSkillFromGitRequest,
  InstallEnvironmentRequest,
  UninstallEnvironmentRequest,
  RunStreamEvent,
  RuntimeSessionRun,
  RuntimeSettingsOverrides,
  RuntimeStatus,
  SendMessageRequest,
  SessionRun,
  SessionRunEvent,
  SessionRunStatus,
  SessionListState,
  ToolTrace,
  RotatePermissionEpochRequest,
  RunnerHealth,
  SandboxNetworkSettings,
  SystemQuotaSettings,
  SystemTimeoutSettings,
  TimeoutKind,
  ScientificEnvironmentSetup,
  SkillDeletionImpact,
  UpdateSkillRequest,
  UpdateModelProfileRequest,
  UpdateProjectRequest,
  UpdateSessionRequest,
  UploadFileRequest,
  WorkspaceCapabilities,
  WorkspaceUploadResult,
  RegisterRemoteHostRequest,
  PromptManifest,
  ProposePlanRequest,
  RevisePlanRequest,
  SubagentStep,
  UpdateSpecialistRequest,
} from "@sciencediscovery/schema";
import { UNTITLED_SESSION_TITLE } from "@sciencediscovery/schema";

import { SessionStoreHttpError } from "../store.js";
import { resolveEnvironmentInstallRequest } from "../environment-sources.js";
import {
  parseConflictPolicy,
  readMultipartUploads,
  uploadWorkspaceParts,
} from "../workspace-upload.js";
import { sandboxNetworkRevision } from "../store/sandbox-network.js";
import {
  ArtifactDashboardError,
  buildArtifactDashboard,
  buildArtifactVersionPreview,
} from "../artifact-dashboard.js";
import { inferDomain, mgLog } from "@sciencediscovery/memory";
import { apiLog, runLog } from "../logging.js";
import { shortErrorMessage } from "@sciencediscovery/operational-logging";
import { createPromptManifest } from "../prompt-manifest.js";
import { createMcpWorkspaceTools } from "@sciencediscovery/artifact-manager";
import { createWebWorkspaceTools } from "@sciencediscovery/data-source";
import {
  createDialogueSkillDraft,
  createSessionSkillDraft,
  SkillCatalogError,
  type RuntimeSkillSnapshot,
} from "@sciencediscovery/specialist";
import {
  reviewerCheckpointPromptContent,
  runReviewerCheckpoint,
} from "@sciencediscovery/provenance";
import { createReviewAgentOptions } from "../reviewer-specialist/review-agent-executor.js";
import { MAX_PAPER_PDF_BYTES } from "../papers.js";
import { classifySubagentFailure } from "@sciencediscovery/specialist";
import { runMainRequestExecution, runSubagentTask } from "../agent-run/orchestrators.js";
import { createAgentPermissionRuntime } from "@sciencediscovery/governance";
import { createRequestExecutionContext } from "../agent-run/request-execution.js";
import { createWorkspaceExecutionBindings } from "../agent-run/workspace-bindings.js";

import {
  aggregateToolText,
  artifactVersionDiff,
  artifactVersionProvenance,
  listWorkspaceFiles,
  mcpConnectorManifest,
  toolSummary,
} from "../artifacts/index.js";
import {
  advanceResolvedPermissionRequests,
  startApprovedRemoteJob,
  waitForPermissionDecision,
} from "../permissions/index.js";
import {
  formatSubagentExecutionPrompt,
  prepareSubagentHandoff,
  validateSubagentStructuredResult,
} from "../subagents/index.js";
import {
  messagePromptContent,
  resolveComposerReferences,
  searchWorkbench,
} from "../workbench/index.js";
import {
  appendModelUsageForManifest,
  capturedModelUsage,
  unreportedModelUsage,
} from "../model-usage/index.js";
import { timeoutFailure, timeoutMessage } from "../timeouts/index.js";
import { isAuthorized } from "./auth.js";
import { readBytes, readJson, readMultipartSkill } from "./body.js";
import { accessTokenBanner } from "./bootstrap-tokens.js";
import { loadServerConfig, repositoryRoot, type ServerConfig } from "../bootstrap/config.js";
import { isKnownClientInputError } from "./error-classification.js";
import { send, sendError, sendJson } from "./response.js";
import { contentTypeForPath, serveStatic } from "./static.js";
import {
  ApiStatusError,
  cancelCurrentSessionRun,
  cancelSessionRun,
  createQueuedRun,
  emptyMatch,
  emptyTrace,
  getActiveSessionRun,
  scheduleSessionRuns,
  sessionHasActiveRun,
  streamAgentRun,
  streamStoredRunEvents,
} from "../runs/index.js";
import { syncScientificEnvironmentCatalog } from "../scientific-environment-catalog.js";
import {
  createPlatformServices,
  initializePlatformServices,
  type ApiServerDependencies,
} from "../bootstrap/platform.js";

export { aggregateToolText } from "../artifacts/index.js";
export { waitForPermissionDecision } from "../permissions/index.js";
export { prepareSubagentHandoff } from "../subagents/index.js";
export { loadServerConfig, type ServerConfig } from "../bootstrap/config.js";
export * from "../runs/index.js";

export type { ApiServerDependencies } from "../bootstrap/platform.js";

export function createApiServer(config = loadServerConfig(), dependencies: ApiServerDependencies = {}): Server {
  const platform = createPlatformServices(config, repositoryRoot, dependencies);
  const {
    artifactManager,
    mcpBroker,
    mcpCatalog,
    mcpRegistry,
    memoryGraphClient,
    memoryGraphEnabled,
    memoryGraphSink,
    paperService,
    permissionDecisions,
    provenanceRecorder,
    remoteCompute,
    runnerClient,
    skillCatalog,
    store,
    webBroker,
  } = platform;
  const patchEphemeralCallback = (server: Server) => {
    // With an ephemeral port (tests), the configured tool-callback URL cannot
    // know the real port in advance; rewrite it from the bound address.
    server.on("listening", () => {
      const address = server.address();
      if (config.port === 0 && typeof address === "object" && address) {
      }
    });
  };
  const ready = initializePlatformServices(platform, config);

  const server = createServer(async (request, response) => {
    const requestPath = (request.url ?? "/").split("?", 1)[0] || "/";
    try {
      await ready;
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
        const runner = await runnerClient.health().catch(() => undefined);
        // Toggle off → disabled (the System Settings switch is off). Toggle on
        // but sidecar/Neo4j down → degraded. The client always exists now.
        const memoryGraph = store.getMemoryGraphSettings().enabled
          ? await memoryGraphClient.health().catch(() => "degraded")
          : "disabled";
        const quotas = store.getQuotaSettings();
        const workspace: WorkspaceCapabilities = {
          maxFileBytes: quotas.uploadMaxFileBytes,
          maxRequestBytes: quotas.uploadMaxRequestBytes,
          maxWorkspaceBytes: quotas.runnerMaxWorkspaceBytes,
        };
        const sandboxNetworkSettings = store.getSandboxNetworkSettings();
        sendJson(response, 200, {
          memoryGraph,
          milestone: "M4",
          sandboxNetwork: {
            ...sandboxNetworkSettings,
            revision: sandboxNetworkRevision(sandboxNetworkSettings),
            runner: runner?.sandboxNetwork,
          },
          runner: runner ?? { status: "unavailable" },
          service: "sciencediscovery-api",
          status: runner ? "ok" : "degraded",
          workspace,
        });
        return;
      }
      if (url.pathname.startsWith("/api/") && !isAuthorized(request, config.authToken)) {
        sendError(response, 401, "Unauthorized");
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/projects") {
        sendJson(response, 200, store.listProjects());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/mcp/sources") {
        sendJson(response, 200, mcpRegistry.listManifests().map((manifest) => ({
          manifest,
          status: mcpCatalog.getStatus(manifest.id),
        })));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/mcp/sources/reload") {
        sendJson(response, 200, {
          catalog: await mcpCatalog.reload(),
          sources: mcpCatalog.listStatuses(),
        });
        return;
      }
      const mcpSourceMatch = url.pathname.match(/^\/api\/mcp\/sources\/([^/]+)$/);
      if (mcpSourceMatch && request.method === "GET") {
        if (!mcpRegistry.has(mcpSourceMatch[1]!)) return sendError(response, 404, "MCP source not found");
        sendJson(response, 200, {
          manifest: mcpRegistry.get(mcpSourceMatch[1]!).manifest,
          status: mcpCatalog.getStatus(mcpSourceMatch[1]!),
        });
        return;
      }
      const mcpSourceStatusMatch = url.pathname.match(/^\/api\/mcp\/sources\/([^/]+)\/status$/);
      if (mcpSourceStatusMatch && request.method === "GET") {
        if (!mcpRegistry.has(mcpSourceStatusMatch[1]!)) return sendError(response, 404, "MCP source not found");
        sendJson(response, 200, mcpCatalog.getStatus(mcpSourceStatusMatch[1]!));
        return;
      }
      const mcpSourceToolsMatch = url.pathname.match(/^\/api\/mcp\/sources\/([^/]+)\/tools$/);
      if (mcpSourceToolsMatch && request.method === "GET") {
        if (!mcpRegistry.has(mcpSourceToolsMatch[1]!)) return sendError(response, 404, "MCP source not found");
        sendJson(response, 200, Object.values(mcpRegistry.get(mcpSourceToolsMatch[1]!).manifest.tools));
        return;
      }
      const mcpInvocationsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/mcp\/invocations$/);
      if (mcpInvocationsMatch && request.method === "GET") {
        if (!store.getSession(mcpInvocationsMatch[1]!)) return sendError(response, 404, "Session not found");
        sendJson(response, 200, await store.listMcpInvocations(mcpInvocationsMatch[1]!));
        return;
      }
      const mcpInvocationMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/mcp\/invocations\/([^/]+)$/);
      if (mcpInvocationMatch && request.method === "GET") {
        const invocation = (await store.listMcpInvocations(mcpInvocationMatch[1]!))
          .find((item) => item.id === mcpInvocationMatch[2]);
        if (!invocation) return sendError(response, 404, "MCP invocation not found");
        sendJson(response, 200, invocation);
        return;
      }
      const artifactPlansMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/mcp\/artifact-plans$/);
      if (artifactPlansMatch && request.method === "GET") {
        if (!store.getSession(artifactPlansMatch[1]!)) return sendError(response, 404, "Session not found");
        sendJson(response, 200, await store.listArtifactPlans(artifactPlansMatch[1]!));
        return;
      }
      const artifactCandidatesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/mcp\/artifact-candidates$/);
      if (artifactCandidatesMatch && request.method === "GET") {
        const sessionId = artifactCandidatesMatch[1]!;
        if (!store.getSession(sessionId)) return sendError(response, 404, "Session not found");
        const candidates: Array<{ candidate: ArtifactCandidate; invocationId: string }> = [];
        for (const invocation of await store.listMcpInvocations(sessionId)) {
          if (invocation.status !== "succeeded" || !invocation.normalizedResult) continue;
          try {
            const result = JSON.parse(
              (await mcpBroker.cas.read(invocation.normalizedResult.hash)).toString("utf8"),
            ) as import("@sciencediscovery/schema").McpToolResult;
            for (const candidate of result.artifacts ?? []) candidates.push({ candidate, invocationId: invocation.id });
          } catch {
            // The immutable invocation remains auditable; malformed result objects are not offered for download.
          }
        }
        sendJson(response, 200, candidates);
        return;
      }
      if (artifactPlansMatch && request.method === "POST") {
        if (!store.getSession(artifactPlansMatch[1]!)) return sendError(response, 404, "Session not found");
        sendJson(response, 201, await artifactManager.prepare(
          artifactPlansMatch[1]!,
          await readJson<CreateArtifactPlanRequest>(request),
        ));
        return;
      }
      const artifactPlanMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/mcp\/artifact-plans\/([^/]+)$/);
      if (artifactPlanMatch && request.method === "GET") {
        const plan = (await store.listArtifactPlans(artifactPlanMatch[1]!))
          .find((item) => item.id === artifactPlanMatch[2]);
        if (!plan) return sendError(response, 404, "Artifact plan not found");
        sendJson(response, 200, plan);
        return;
      }
      const artifactPlanApprovalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/mcp\/artifact-plans\/([^/]+)\/approve$/);
      if (artifactPlanApprovalMatch && request.method === "POST") {
        sendJson(response, 200, await artifactManager.approve(
          artifactPlanApprovalMatch[1]!,
          artifactPlanApprovalMatch[2]!,
        ));
        return;
      }
      const artifactJobsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/mcp\/artifact-jobs$/);
      if (artifactJobsMatch && request.method === "GET") {
        if (!store.getSession(artifactJobsMatch[1]!)) return sendError(response, 404, "Session not found");
        sendJson(response, 200, await store.listArtifactJobs(artifactJobsMatch[1]!));
        return;
      }
      const artifactJobMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/mcp\/artifact-jobs\/([^/]+)$/);
      if (artifactJobMatch && request.method === "GET") {
        const job = (await store.listArtifactJobs(artifactJobMatch[1]!))
          .find((item) => item.id === artifactJobMatch[2]);
        if (!job) return sendError(response, 404, "Artifact job not found");
        sendJson(response, 200, job);
        return;
      }
      const artifactJobActionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/mcp\/artifact-jobs\/([^/]+)\/(cancel|retry)$/);
      if (artifactJobActionMatch && request.method === "POST") {
        const job = artifactJobActionMatch[3] === "cancel"
          ? await artifactManager.cancel(artifactJobActionMatch[1]!, artifactJobActionMatch[2]!)
          : await artifactManager.retry(artifactJobActionMatch[1]!, artifactJobActionMatch[2]!);
        sendJson(response, 200, job);
        return;
      }
      const artifactExtractionJobsMatch = url.pathname.match(
        /^\/api\/sessions\/([^/]+)\/mcp\/artifact-extraction-jobs$/,
      );
      if (artifactExtractionJobsMatch && request.method === "GET") {
        if (!store.getSession(artifactExtractionJobsMatch[1]!)) {
          return sendError(response, 404, "Session not found");
        }
        sendJson(response, 200, await store.listArtifactExtractionJobs(artifactExtractionJobsMatch[1]!));
        return;
      }
      const artifactExtractionJobMatch = url.pathname.match(
        /^\/api\/sessions\/([^/]+)\/mcp\/artifact-extraction-jobs\/([^/]+)$/,
      );
      if (artifactExtractionJobMatch && request.method === "GET") {
        const job = (await store.listArtifactExtractionJobs(artifactExtractionJobMatch[1]!))
          .find((item) => item.id === artifactExtractionJobMatch[2]);
        if (!job) return sendError(response, 404, "Artifact extraction job not found");
        sendJson(response, 200, job);
        return;
      }
      const evidenceItemsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/evidence-items$/);
      if (evidenceItemsMatch && request.method === "GET") {
        if (!store.getSession(evidenceItemsMatch[1]!)) return sendError(response, 404, "Session not found");
        sendJson(response, 200, await store.listEvidenceItems(evidenceItemsMatch[1]!));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/search") {
        sendJson(response, 200, await searchWorkbench(store, url.searchParams.get("q") ?? ""));
        return;
      }
      if (url.pathname === "/api/settings" && request.method === "GET") {
        sendJson(response, 200, store.getGlobalSettings());
        return;
      }
      if (url.pathname === "/api/settings" && request.method === "PUT") {
        sendJson(response, 200, await store.replaceGlobalSettings(await readJson<RuntimeSettingsOverrides>(request)));
        return;
      }
      if (url.pathname === "/api/reviewer-specialist/settings" && request.method === "GET") {
        sendJson(response, 200, store.getReviewerSpecialistSettings());
        return;
      }
      if (url.pathname === "/api/reviewer-specialist/settings" && request.method === "PUT") {
        sendJson(response, 200, await store.updateReviewerSpecialistSettings(await readJson(request)));
        return;
      }
      if (url.pathname === "/api/timeout-settings" && request.method === "GET") {
        sendJson(response, 200, store.getTimeoutSettings());
        return;
      }
      if (url.pathname === "/api/timeout-settings" && request.method === "PUT") {
        sendJson(response, 200, await store.replaceTimeoutSettings(await readJson<SystemTimeoutSettings>(request)));
        return;
      }
      if (url.pathname === "/api/quota-settings" && request.method === "GET") {
        sendJson(response, 200, store.getQuotaSettings());
        return;
      }
      if (url.pathname === "/api/quota-settings" && request.method === "PUT") {
        sendJson(response, 200, await store.replaceQuotaSettings(await readJson<SystemQuotaSettings>(request)));
        return;
      }
      if (url.pathname === "/api/sandbox-network-settings" && request.method === "GET") {
        sendJson(response, 200, store.getSandboxNetworkSettings());
        return;
      }
      if (url.pathname === "/api/sandbox-network-settings" && request.method === "PUT") {
        const saved = await store.replaceSandboxNetworkSettings(await readJson<SandboxNetworkSettings>(request));
        // The policy is frozen into each Permission Epoch, so sessions that
        // rotated must drop the persistent kernels and shells started under
        // the previous policy. Best-effort: the runner's reuse key already
        // contains the epoch id, so a failed teardown cannot leak the old
        // policy into a later execution.
        for (const sessionId of saved.rotatedSessionIds) {
          await runnerClient
            .teardownKernels(sessionId, "Sandbox network access policy changed; persistent memory was lost")
            .catch((error: unknown) => {
              runLog.warn("sandbox_network_teardown_failed", {
                errorMessage: shortErrorMessage(error),
                sessionId,
              });
            });
        }
        sendJson(response, 200, saved.settings);
        return;
      }
      if (url.pathname === "/api/environment-source-settings" && request.method === "GET") {
        sendJson(response, 200, store.getEnvironmentSourceSettings());
        return;
      }
      if (url.pathname === "/api/environment-source-settings" && request.method === "PUT") {
        const body = await readJson<UpdateEnvironmentSourceSettingsRequest>(request);
        sendJson(response, 200, await store.updateEnvironmentSourceSettings(body));
        return;
      }
      if (url.pathname === "/api/proxy/settings" && request.method === "GET") {
        sendJson(response, 200, store.getProxySettings());
        return;
      }
      if (url.pathname === "/api/proxy/settings" && request.method === "PUT") {
        sendJson(response, 200, await store.updateProxySettings(await readJson<UpdateProxySettingsRequest>(request)));
        return;
      }
      if (url.pathname === "/api/proxy/servers" && request.method === "POST") {
        sendJson(response, 201, await store.createProxyServer(await readJson<CreateProxyServerRequest>(request)));
        return;
      }
      const proxyServerMatch = url.pathname.match(/^\/api\/proxy\/servers\/([^/]+)$/);
      if (proxyServerMatch && request.method === "PUT") {
        sendJson(response, 200, await store.updateProxyServer(
          decodeURIComponent(proxyServerMatch[1]!),
          await readJson<UpdateProxyServerRequest>(request),
        ));
        return;
      }
      if (proxyServerMatch && request.method === "DELETE") {
        const serverId = decodeURIComponent(proxyServerMatch[1]!);
        await store.deleteProxyServer(serverId);
        sendJson(response, 200, { deleted: serverId });
        return;
      }
      if (url.pathname === "/api/mcp/proxy-policies" && request.method === "GET") {
        sendJson(response, 200, { policies: store.getMcpProxyPolicies() });
        return;
      }
      if (url.pathname === "/api/mcp/proxy-policies" && request.method === "PUT") {
        const policies = await store.updateMcpProxyPolicies(await readJson<UpdateMcpProxyPoliciesRequest>(request));
        sendJson(response, 200, { policies });
        return;
      }
      if (url.pathname === "/api/web/settings" && request.method === "GET") {
        sendJson(response, 200, store.getWebSettings());
        return;
      }
      if (url.pathname === "/api/web/settings" && request.method === "PUT") {
        sendJson(response, 200, await store.updateWebSettings(await readJson<UpdateWebSettingsRequest>(request)));
        return;
      }
      if (url.pathname === "/api/memory/settings" && request.method === "GET") {
        // 1C: merge the live sidecar health so the settings editor's badge
        // needs no independent polling. 3A: if a password is stored but the
        // sidecar is not healthy, best-effort re-push it once (self-heal the
        // "password saved but sidecar never received it" case — e.g. the
        // sidecar restarted after the API). Toggle off → disabled, no push.
        const details = store.getMemoryGraphSettings();
        let health = details.enabled
          ? await memoryGraphClient.health().catch(() => "degraded")
          : "disabled";
        if (details.enabled && details.hasNeo4jPassword && health !== "healthy") {
          const password = store.getMemoryGraphNeo4jPassword();
          if (password) {
            mgLog.info("GET /api/memory/settings: auto-repushing stored password (health=%s)", health);
            await memoryGraphClient.pushNeo4jPassword(password).catch((error: unknown) => {
              mgLog.warn("GET /api/memory/settings: auto-repush failed (non-fatal): %s",
                error instanceof Error ? error.message : String(error));
            });
            health = await memoryGraphClient.health().catch(() => "degraded");
          }
        }
        sendJson(response, 200, { ...details, memoryGraphStatus: health });
        return;
      }
      if (url.pathname === "/api/memory/settings" && request.method === "PUT") {
        const body = await readJson<UpdateMemoryGraphSettingsRequest>(request);
        const details = await store.updateMemoryGraphSettings(body);
        // 2B: storing the password does NOT flip enabled; the user toggles it
        // explicitly. Push to the sidecar when the password changed OR the
        // HTTP/user connection changed — either rebuilds the driver. The store
        // is the source of truth; send the stored http/user so the sidecar's
        // env-only http/user is overridden. Best-effort, non-fatal.
        const passwordChanged = body.neo4jPassword !== undefined;
        const connectionChanged = body.neo4jHttp !== undefined || body.neo4jUser !== undefined;
        if (passwordChanged || connectionChanged) {
          // Resolve the password to push: the new value if provided (incl. null
          // = clear), else the stored one so a connection-only change rebuilds
          // the driver from the existing credential.
          const password: string | null = body.neo4jPassword !== undefined
            ? (body.neo4jPassword === null ? null : (body.neo4jPassword as string).trim() || null)
            : store.getMemoryGraphNeo4jPassword() ?? null;
          // Skip when there's nothing to push (no stored password and none set).
          if (passwordChanged || password !== null) {
            await memoryGraphClient
              .pushNeo4jPassword(password, {
                httpUri: connectionChanged ? details.neo4jHttp : undefined,
                user: connectionChanged ? details.neo4jUser : undefined,
              })
              .catch((error: unknown) => {
                mgLog.warn("PUT /api/memory/settings: credential push failed (non-fatal): %s",
                  error instanceof Error ? error.message : String(error));
              });
          }
        }
        const health = details.enabled
          ? await memoryGraphClient.health().catch(() => "degraded")
          : "disabled";
        sendJson(response, 200, { ...details, memoryGraphStatus: health });
        return;
      }
      if (url.pathname === "/api/web/usage" && request.method === "GET") {
        sendJson(response, 200, webBroker.usage());
        return;
      }
      if (url.pathname === "/api/runtime-status" && request.method === "GET") {
        const runner = await runnerClient.status().catch((error: unknown) => ({
          activeExecutions: [] as [],
          error: error instanceof Error ? error.message : "Runner status is unavailable",
          kernels: [] as [],
          status: "unavailable" as const,
        }));
        const sessions: RuntimeSessionRun[] = [];
        for (const project of store.listProjects()) {
          for (const session of store.listSessions(project.id, "all")) {
            for (const run of await store.listSessionRuns(session.id)) {
              if (run.status !== "queued" && run.status !== "running" && run.status !== "blocked") continue;
              const active = getActiveSessionRun(session.id);
              sessions.push({
                lastActivityAt: active?.runId === run.id
                  ? active.lastActivityAt
                  : run.startedAt ?? run.createdAt,
                projectId: project.id,
                runId: run.id,
                sessionId: session.id,
                startedAt: run.startedAt ?? run.createdAt,
                status: run.status,
                title: session.title,
              });
            }
          }
        }
        sendJson(response, 200, {
          capturedAt: new Date().toISOString(),
          runner,
          sessions,
        } satisfies RuntimeStatus);
        return;
      }
      const legacyCancelRunMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/run\/cancel$/);
      if (legacyCancelRunMatch && request.method === "POST") {
        await cancelCurrentSessionRun(response, store, decodeURIComponent(legacyCancelRunMatch[1]!), true);
        return;
      }
      const teardownKernelMatch = url.pathname.match(/^\/api\/runtime-status\/kernels\/([^/]+)\/teardown$/);
      if (teardownKernelMatch && request.method === "POST") {
        const kernelId = decodeURIComponent(teardownKernelMatch[1]!);
        sendJson(response, 200, await runnerClient.teardownKernel(
          kernelId,
          "User cleared the persistent Kernel from Runtime status",
        ));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/models") {
        sendJson(response, 200, store.listModels());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/remote-hosts") {
        sendJson(response, 200, store.listRemoteHosts());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/remote-hosts") {
        const body = await readJson<RegisterRemoteHostRequest>(request);
        try {
          const capabilities = await remoteCompute.probe(body.alias ?? "");
          sendJson(response, 201, await store.registerRemoteHost(body.alias, capabilities));
        } catch (error) {
          const message = error instanceof Error ? error.message : "SSH probe failed";
          sendJson(response, 201, await store.registerRemoteHost(body.alias ?? "", undefined, message));
        }
        return;
      }
      const remoteHostProbeMatch = url.pathname.match(/^\/api\/remote-hosts\/([^/]+)\/probe$/);
      if (remoteHostProbeMatch && request.method === "POST") {
        const host = store.getRemoteHost(remoteHostProbeMatch[1]!);
        if (!host) return sendError(response, 404, "Remote host not found");
        try {
          sendJson(response, 200, await store.registerRemoteHost(host.alias, await remoteCompute.probe(host.alias)));
        } catch (error) {
          sendJson(response, 200, await store.registerRemoteHost(
            host.alias,
            undefined,
            error instanceof Error ? error.message : "SSH probe failed",
          ));
        }
        return;
      }
      const remoteHostMatch = url.pathname.match(/^\/api\/remote-hosts\/([^/]+)$/);
      if (remoteHostMatch && request.method === "DELETE") {
        await store.deleteRemoteHost(remoteHostMatch[1]!);
        sendJson(response, 200, { deleted: remoteHostMatch[1] });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/connectors") {
        sendJson(response, 200, mcpRegistry.listManifests().map(mcpConnectorManifest));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/skills") {
        sendJson(response, 200, skillCatalog.list());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/specialists") {
        sendJson(response, 200, store.listSpecialists());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/specialists") {
        sendJson(response, 201, await store.createSpecialist(await readJson<CreateSpecialistRequest>(request)));
        return;
      }
      const specialistMatch = url.pathname.match(/^\/api\/specialists\/([^/]+)$/);
      if (specialistMatch && request.method === "PUT") {
        sendJson(response, 200, await store.updateSpecialist(
          specialistMatch[1]!,
          await readJson<UpdateSpecialistRequest>(request),
        ));
        return;
      }
      if (specialistMatch && request.method === "DELETE") {
        await store.deleteSpecialist(specialistMatch[1]!);
        sendJson(response, 200, { deleted: specialistMatch[1] });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/skills") {
        const detail = await skillCatalog.create(await readJson<CreateSkillRequest>(request));
        store.setAvailableSkillIds(skillCatalog.ids());
        sendJson(response, 201, detail);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/skills/import") {
        const upload = await readMultipartSkill(request);
        const detail = await skillCatalog.import(upload.filename, upload.bytes);
        store.setAvailableSkillIds(skillCatalog.ids());
        sendJson(response, 201, detail);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/skills/import-git") {
        const detail = await skillCatalog.importFromGit(await readJson<ImportSkillFromGitRequest>(request));
        store.setAvailableSkillIds(skillCatalog.ids());
        sendJson(response, 201, detail);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/skills/drafts/dialogue") {
        sendJson(response, 200, createDialogueSkillDraft(await readJson<CreateSkillDialogueDraftRequest>(request)));
        return;
      }
      const sessionSkillDraftMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/skills\/distill$/);
      if (sessionSkillDraftMatch && request.method === "POST") {
        const sessionId = sessionSkillDraftMatch[1]!;
        const session = await store.getSessionDetail(sessionId);
        if (!session) return sendError(response, 404, "Session not found");
        sendJson(response, 200, createSessionSkillDraft({
          messages: session.messages,
          request: await readJson<DistillSessionSkillRequest>(request),
          runs: await store.listExecutionRuns(sessionId),
          sessionTitle: session.title,
        }));
        return;
      }

      const skillDeletionImpactMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/deletion-impact$/);
      if (skillDeletionImpactMatch && request.method === "GET") {
        const skillId = decodeURIComponent(skillDeletionImpactMatch[1]!);
        if (!skillCatalog.get(skillId)) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill not found: ${skillId}`);
        sendJson(response, 200, store.getSkillDeletionImpact(skillId));
        return;
      }

      const skillResourceMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/resources\/(.+)$/);
      if (skillResourceMatch && request.method === "GET") {
        sendJson(response, 200, skillCatalog.readCurrentResource(
          decodeURIComponent(skillResourceMatch[1]!),
          decodeURIComponent(skillResourceMatch[2]!),
        ));
        return;
      }

      const skillMatch = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
      if (skillMatch && request.method === "GET") {
        const skillId = decodeURIComponent(skillMatch[1]!);
        const detail = skillCatalog.get(skillId);
        if (!detail) throw new SkillCatalogError("SKILL_NOT_FOUND", `Skill not found: ${skillId}`);
        sendJson(response, 200, detail);
        return;
      }
      if (skillMatch && request.method === "PUT") {
        const skillId = decodeURIComponent(skillMatch[1]!);
        sendJson(response, 200, await skillCatalog.update(skillId, await readJson<UpdateSkillRequest>(request)));
        return;
      }
      if (skillMatch && request.method === "DELETE") {
        const skillId = decodeURIComponent(skillMatch[1]!);
        const impact: SkillDeletionImpact = store.getSkillDeletionImpact(skillId);
        if (impact.references.length) {
          throw new SkillCatalogError("SKILL_CONFLICT", `Skill is referenced by ${impact.references.length} runtime settings document(s)`);
        }
        await skillCatalog.delete(skillId);
        store.setAvailableSkillIds(skillCatalog.ids());
        sendJson(response, 200, { deleted: skillId });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/environment-revisions") {
        const health = await runnerClient.health().catch(() => undefined);
        if (health?.scientificEnvs?.available) {
          await syncScientificEnvironmentCatalog(store, runnerClient, provenanceRecorder);
        }
        sendJson(response, 200, store.listEnvironmentRevisions());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/environment-setup") {
        sendJson(response, 200, await runnerClient.getEnvironmentSetup());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/environment-setup") {
        const setup: ScientificEnvironmentSetup = await runnerClient.setupScientificEnvironments();
        if (setup.state === "ready") await syncScientificEnvironmentCatalog(store, runnerClient, provenanceRecorder);
        sendJson(response, 200, setup);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/environments") {
        const health = await runnerClient.health();
        if (!health.scientificEnvs?.available) return sendError(response, 503, health.scientificEnvs?.unavailableReason ?? "Scientific environments are unavailable");
        await syncScientificEnvironmentCatalog(store, runnerClient, provenanceRecorder);
        sendJson(response, 200, store.listEnvironments());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/environments") {
        const body = await readJson<CreateEnvironmentRequest>(request);
        const environment = await runnerClient.createEnvironment(body);
        await syncScientificEnvironmentCatalog(store, runnerClient, provenanceRecorder);
        sendJson(response, 201, environment);
        return;
      }
      const environmentInstallMatch = url.pathname.match(/^\/api\/environments\/([^/]+)\/install$/);
      if (environmentInstallMatch && request.method === "POST") {
        const body = await readJson<InstallEnvironmentRequest>(request);
        const environmentId = decodeURIComponent(environmentInstallMatch[1]!);
        if (body.packages.some((value) => value.trim().toLowerCase().endsWith(".whl"))) {
          return sendError(
            response,
            400,
            "Local wheel paths require an Agent Session workspace; settings installs accept package name specifications only",
          );
        }
        // Browser callers have no trusted Session workspace context. Rebuild the
        // public request so an extra workspaceRoot field cannot escape into Runner.
        const revision = await runnerClient.installEnvironment(
          environmentId,
          resolveEnvironmentInstallRequest(body, store.getEnvironmentSourceSettings()),
        );
        await syncScientificEnvironmentCatalog(store, runnerClient, provenanceRecorder);
        const environment = store.listEnvironments().find((candidate) => candidate.id === environmentId);
        if (!environment) throw new Error("Installed environment disappeared from the runner catalog");
        sendJson(response, 201, { environment, revision, status: "succeeded" });
        return;
      }
      const environmentUninstallMatch = url.pathname.match(/^\/api\/environments\/([^/]+)\/uninstall$/);
      if (environmentUninstallMatch && request.method === "POST") {
        const body = await readJson<UninstallEnvironmentRequest>(request);
        const environmentId = decodeURIComponent(environmentUninstallMatch[1]!);
        const revision = await runnerClient.uninstallEnvironment(environmentId, body);
        await syncScientificEnvironmentCatalog(store, runnerClient, provenanceRecorder);
        const environment = store.listEnvironments().find((candidate) => candidate.id === environmentId);
        if (!environment) throw new Error("Updated environment disappeared from the runner catalog");
        sendJson(response, 201, { environment, revision, status: "succeeded" });
        return;
      }
      const environmentMatch = url.pathname.match(/^\/api\/environments\/([^/]+)$/);
      if (environmentMatch && request.method === "DELETE") {
        const environmentId = decodeURIComponent(environmentMatch[1]!);
        await runnerClient.deleteEnvironment(environmentId);
        await syncScientificEnvironmentCatalog(store, runnerClient, provenanceRecorder);
        sendJson(response, 200, { deleted: environmentId });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/models") {
        const body = await readJson<CreateModelProfileRequest>(request);
        sendJson(response, 201, await store.createModel(body));
        return;
      }

      const modelMatch = url.pathname.match(/^\/api\/models\/([^/]+)$/);
      if (modelMatch && request.method === "PUT") {
        const body = await readJson<UpdateModelProfileRequest>(request);
        sendJson(response, 200, await store.updateModel(modelMatch[1]!, body));
        return;
      }
      if (modelMatch && request.method === "DELETE") {
        await store.deleteModel(modelMatch[1]!);
        sendJson(response, 200, { deleted: modelMatch[1] });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/projects") {
        const body = await readJson<CreateProjectRequest>(request);
        const project = await store.createProject(body.name ?? "", body.settingsOverrides);
        try {
          const firstSession = await store.createSession(
            project.id,
            UNTITLED_SESSION_TITLE,
            {},
            {},
            { allowUnconfiguredModel: true },
          );
          sendJson(response, 201, { ...project, firstSession, project });
        } catch (error) {
          await store.deleteProject(project.id, project.id);
          throw error;
        }
        return;
      }

      const projectSettingsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/settings$/);
      if (projectSettingsMatch && request.method === "GET") {
        sendJson(response, 200, store.getProjectSettings(projectSettingsMatch[1]!));
        return;
      }
      if (projectSettingsMatch && request.method === "PUT") {
        sendJson(response, 200, await store.replaceProjectSettings(
          projectSettingsMatch[1]!,
          await readJson<RuntimeSettingsOverrides>(request),
        ));
        return;
      }

      const projectDeletionImpactMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/deletion-impact$/);
      if (projectDeletionImpactMatch && request.method === "GET") {
        sendJson(response, 200, store.getProjectDeletionImpact(projectDeletionImpactMatch[1]!));
        return;
      }

      const projectArtifactsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/artifacts$/);
      if (projectArtifactsMatch && request.method === "GET") {
        sendJson(response, 200, store.listProjectArtifacts(projectArtifactsMatch[1]!));
        return;
      }
      const projectArtifactVersionsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/artifacts\/([^/]+)\/versions$/);
      if (projectArtifactVersionsMatch && request.method === "GET") {
        sendJson(response, 200, store.listProjectArtifactVersions(
          projectArtifactVersionsMatch[1]!,
          projectArtifactVersionsMatch[2]!,
        ));
        return;
      }
      const projectArtifactContentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/artifact-versions\/([^/]+)\/content$/);
      if (projectArtifactContentMatch && request.method === "GET") {
        const version = store.getProjectArtifactVersion(projectArtifactContentMatch[1]!, projectArtifactContentMatch[2]!);
        if (!version) return sendError(response, 404, "Artifact version not found");
        send(response, 200, version.mediaType, await provenanceRecorder.cas.read(version.content.hash));
        return;
      }

      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch && request.method === "PATCH") {
        sendJson(response, 200, await store.updateProject(
          projectMatch[1]!,
          await readJson<UpdateProjectRequest>(request),
        ));
        return;
      }
      if (projectMatch && request.method === "DELETE") {
        const impact = store.getProjectDeletionImpact(projectMatch[1]!);
        for (const sessionId of impact.sessionIds) {
          if (await sessionHasActiveRun(store, sessionId)) {
            return sendError(response, 409, "Cannot delete a Project while one of its Sessions has an active run");
          }
        }
        const body = await readJson<DeleteResourceRequest>(request);
        const health = await runnerClient.health().catch(() => undefined);
        if (health?.scientificEnvs?.available) {
          for (const sessionId of impact.sessionIds) {
            await runnerClient.teardownKernels(sessionId, "Project was deleted; persistent memory was lost");
          }
        }
        await store.deleteProject(projectMatch[1]!, body.confirmationId ?? "");
        sendJson(response, 200, { deleted: projectMatch[1] });
        return;
      }

      const projectSessions = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
      if (projectSessions && request.method === "GET") {
        if (!store.getProject(projectSessions[1]!)) return sendError(response, 404, "Project not found");
        const state = url.searchParams.get("state") ?? "active";
        if (state !== "active" && state !== "archived" && state !== "all") {
          return sendError(response, 400, "Session state must be active, archived, or all");
        }
        sendJson(response, 200, store.listSessions(projectSessions[1]!, state as SessionListState));
        return;
      }
      if (projectSessions && request.method === "POST") {
        const body = await readJson<CreateSessionRequest>(request);
        if (body.modelId && body.settingsOverrides?.modelId && body.modelId !== body.settingsOverrides.modelId) {
          return sendError(response, 400, "modelId conflicts with settingsOverrides.modelId");
        }
        const settingsOverrides: RuntimeSettingsOverrides = {
          ...body.settingsOverrides,
          ...(body.modelId ? { modelId: body.modelId } : {}),
          ...(body.modelId && body.settingsOverrides?.reviewModelId === undefined
            ? { reviewModelId: body.modelId }
            : {}),
        };
        sendJson(response, 201, await store.createSession(
          projectSessions[1]!,
          body.title ?? UNTITLED_SESSION_TITLE,
          settingsOverrides,
          {
            approvalMode: body.approvalMode,
            reviewCriteria: body.reviewCriteria,
            reviewMode: body.reviewMode,
            specialistId: body.specialistId,
          },
          {
            allowUnconfiguredModel: body.modelId === undefined && body.settingsOverrides?.modelId === undefined,
          },
        ));
        return;
      }

      const sessionPlansMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/plans$/);
      if (sessionPlansMatch && request.method === "GET") {
        sendJson(response, 200, store.listSessionPlans(sessionPlansMatch[1]!));
        return;
      }
      if (sessionPlansMatch && request.method === "POST") {
        const plan = await store.proposeSessionPlan(
          sessionPlansMatch[1]!,
          await readJson<ProposePlanRequest>(request),
        );
        // Correct the goal's domain/scope from plan.scope, same as the
        // streaming propose path. Never blocks the response.
        memoryGraphSink.observeSessionPlan({
          sessionId: sessionPlansMatch[1]!,
          goalId: `goal:session:${sessionPlansMatch[1]!}`,
          planId: plan.id,
          scope: plan.scope,
          domain: inferDomain(plan.scope),
          steps: plan.steps.map((step) => ({ id: step.id, description: step.description })),
        });
        sendJson(response, 201, plan);
        return;
      }
      const sessionPlanMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/plans\/([^/]+)$/);
      if (sessionPlanMatch && request.method === "PUT") {
        const plan = await store.reviseSessionPlan(
          sessionPlanMatch[1]!,
          sessionPlanMatch[2]!,
          await readJson<RevisePlanRequest>(request),
        );
        // Re-mirror a revised plan (steps may have changed). Idempotent: MERGE
        // on step.id updates the objective without rebuilding the chain. Never
        // blocks the response.
        memoryGraphSink.observeSessionPlan({
          sessionId: sessionPlanMatch[1]!,
          goalId: `goal:session:${sessionPlanMatch[1]!}`,
          planId: plan.id,
          scope: plan.scope,
          domain: inferDomain(plan.scope),
          steps: plan.steps.map((step) => ({ id: step.id, description: step.description })),
        });
        sendJson(response, 200, plan);
        return;
      }
      const sessionSubagentsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/subagents$/);
      if (sessionSubagentsMatch && request.method === "GET") {
        sendJson(response, 200, store.listSubagents(sessionSubagentsMatch[1]!));
        return;
      }
      const sessionSubagentBriefMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/subagents\/([^/]+)\/brief$/);
      if (sessionSubagentBriefMatch && request.method === "PATCH") {
        const sessionId = sessionSubagentBriefMatch[1]!;
        const subagentId = sessionSubagentBriefMatch[2]!;
        try {
          const updated = await store.updateSubagentBrief(
            sessionId,
            subagentId,
            await readJson<UpdateSubagentBriefRequest>(request),
          );
          sendJson(response, 200, updated);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Subagent brief update failed";
          const status = error instanceof SessionStoreHttpError ? error.statusCode : 400;
          sendError(response, status, message);
        }
        return;
      }
      const sessionRemoteJobsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/remote-jobs$/);
      if (sessionRemoteJobsMatch && request.method === "GET") {
        sendJson(response, 200, store.listRemoteJobs(sessionRemoteJobsMatch[1]!));
        return;
      }
      if (sessionRemoteJobsMatch && request.method === "POST") {
        const job = await store.createRemoteJob(
          sessionRemoteJobsMatch[1]!,
          await readJson<CreateRemoteJobRequest>(request),
        );
        sendJson(response, 201, await startApprovedRemoteJob(job, store, remoteCompute, provenanceRecorder));
        return;
      }
      const remoteJobDecisionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/remote-jobs\/([^/]+)\/decision$/);
      if (remoteJobDecisionMatch && request.method === "POST") {
        const sessionId = remoteJobDecisionMatch[1]!;
        const body = await readJson<DecideRemoteJobRequest>(request);
        const existingJob = store.getRemoteJob(sessionId, remoteJobDecisionMatch[2]!);
        if (!existingJob) return sendError(response, 404, "Remote job not found");
        if (existingJob.state !== "awaiting_approval") {
          return sendError(response, 400, "Remote job is not awaiting approval");
        }
        if (existingJob.version !== body.expectedVersion) {
          return sendError(response, 409, "Remote job version changed; refresh before deciding");
        }
        if (!existingJob.permissionRequestId) {
          return sendError(response, 409, "Remote job has no pending permission request");
        }
        const teardown = (await runnerClient.health().catch(() => undefined))?.scientificEnvs?.available
          ? await runnerClient.teardownKernels(sessionId, "Remote job permission changed; persistent memory was lost")
          : undefined;
        const permissionDecision = await store.decidePermissionRequest(
          existingJob.permissionRequestId,
          body.decision,
          teardown?.count ? teardown.reason : undefined,
        );
        const advanced = await advanceResolvedPermissionRequests(
          permissionDecision.resolvedRequests,
          store,
          artifactManager,
          remoteCompute,
          provenanceRecorder,
        );
        const job = advanced.remoteJobs.find((candidate) => candidate.id === existingJob.id)
          ?? store.getRemoteJob(sessionId, existingJob.id);
        if (!job) return sendError(response, 404, "Remote job not found after permission decision");
        sendJson(response, 200, job);
        return;
      }
      const remoteJobRefreshMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/remote-jobs\/([^/]+)\/refresh$/);
      if (remoteJobRefreshMatch && request.method === "POST") {
        const sessionId = remoteJobRefreshMatch[1]!;
        const job = store.getRemoteJob(sessionId, remoteJobRefreshMatch[2]!);
        if (!job) return sendError(response, 404, "Remote job not found");
        sendJson(response, 200, await store.updateRemoteJob(
          await remoteCompute.refresh(job, store.workspacePath(sessionId)),
        ));
        return;
      }

      const sessionSettingsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/settings$/);
      if (sessionSettingsMatch && request.method === "GET") {
        sendJson(response, 200, store.getSessionSettings(sessionSettingsMatch[1]!));
        return;
      }
      if (sessionSettingsMatch && request.method === "PUT") {
        sendJson(response, 200, await store.replaceSessionSettings(
          sessionSettingsMatch[1]!,
          await readJson<RuntimeSettingsOverrides>(request),
        ));
        return;
      }

      const sessionArchiveMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(archive|restore)$/);
      if (sessionArchiveMatch && request.method === "POST") {
        if (await sessionHasActiveRun(store, sessionArchiveMatch[1]!)) {
          return sendError(response, 409, "Cannot change archive state during an active run");
        }
        const isArchive = sessionArchiveMatch[2] === "archive";
        if (isArchive && (await runnerClient.health().catch(() => undefined))?.scientificEnvs?.available) {
          await runnerClient.teardownKernels(sessionArchiveMatch[1]!, "Session was archived; persistent memory was lost");
        }
        const updated = isArchive
          ? await store.archiveSession(sessionArchiveMatch[1]!)
          : await store.restoreSession(sessionArchiveMatch[1]!);
        sendJson(response, 200, updated);
        return;
      }

      const sessionDeletionImpactMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/deletion-impact$/);
      if (sessionDeletionImpactMatch && request.method === "GET") {
        sendJson(response, 200, store.getSessionDeletionImpact(sessionDeletionImpactMatch[1]!));
        return;
      }

      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch && request.method === "GET") {
        const session = await store.getSessionDetail(sessionMatch[1]!);
        if (!session) return sendError(response, 404, "Session not found");
        sendJson(response, 200, session);
        return;
      }
      if (sessionMatch && request.method === "PATCH") {
        const body = await readJson<UpdateSessionRequest>(request);
        const sessionId = sessionMatch[1]!;
        const requestedApprovalMode = body.approvalMode;
        const { approvalMode: _approvalMode, ...remaining } = body;
        const hasRemainingChanges = Object.values(remaining).some((value) => value !== undefined);
        if (requestedApprovalMode && hasRemainingChanges) {
          return sendError(response, 400, "approvalMode must be changed in a dedicated request");
        }
        if (requestedApprovalMode && store.getSession(sessionId)?.approvalMode !== requestedApprovalMode) {
          const teardown = (await runnerClient.health().catch(() => undefined))?.scientificEnvs?.available
            ? await runnerClient.teardownKernels(sessionId, "Approval mode changed; persistent memory was lost")
            : undefined;
          const modeChange = await store.setApprovalMode(
            sessionId,
            requestedApprovalMode,
            teardown?.count ? teardown.reason : undefined,
          );
          await advanceResolvedPermissionRequests(
            modeChange.resolvedPendingRequests,
            store,
            artifactManager,
            remoteCompute,
            provenanceRecorder,
          );
        }
        sendJson(response, 200, hasRemainingChanges
          ? await store.updateSession(sessionId, remaining)
          : store.getSession(sessionId));
        return;
      }
      if (sessionMatch && request.method === "DELETE") {
        if (await sessionHasActiveRun(store, sessionMatch[1]!)) {
          return sendError(response, 409, "Cannot delete a Session during an active run");
        }
        const body = await readJson<DeleteResourceRequest>(request);
        if ((await runnerClient.health().catch(() => undefined))?.scientificEnvs?.available) {
          await runnerClient.teardownKernels(sessionMatch[1]!, "Session was deleted; persistent memory was lost");
        }
        await store.deleteSession(sessionMatch[1]!, body.confirmationId ?? "");
        sendJson(response, 200, { deleted: sessionMatch[1] });
        return;
      }

      const papersMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/papers$/);
      if (papersMatch && request.method === "GET") {
        if (!store.getSession(papersMatch[1]!)) return sendError(response, 404, "Session not found");
        sendJson(response, 200, await store.listPaperAcquisitions(papersMatch[1]!));
        return;
      }

      const paperUploadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/papers\/upload$/);
      if (paperUploadMatch && request.method === "POST") {
        if (!store.getSession(paperUploadMatch[1]!)) return sendError(response, 404, "Session not found");
        if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/pdf") {
          return sendError(response, 415, "Paper upload requires application/pdf");
        }
        sendJson(response, 201, await paperService.upload({
          bytes: await readBytes(request, MAX_PAPER_PDF_BYTES, "PDF"),
          sessionId: paperUploadMatch[1]!,
          title: url.searchParams.get("title") ?? undefined,
        }));
        return;
      }

      const paperVisionRunsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/papers\/vision-runs$/);
      if (paperVisionRunsMatch && request.method === "GET") {
        if (!store.getSession(paperVisionRunsMatch[1]!)) return sendError(response, 404, "Session not found");
        sendJson(response, 200, await store.listPaperVisionRuns(paperVisionRunsMatch[1]!));
        return;
      }

      const paperVisionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/papers\/([^/]+)\/vision$/);
      if (paperVisionMatch && request.method === "POST") {
        if (!store.getSession(paperVisionMatch[1]!)) return sendError(response, 404, "Session not found");
        const body = await readJson<AnalyzePaperVisionRequest>(request);
        const startedAt = new Date().toISOString();
        const run = await paperService.analyzeVision({
          modelId: body.modelId ?? "",
          paperId: paperVisionMatch[2]!,
          prompt: body.prompt,
          sessionId: paperVisionMatch[1]!,
        });
        const model = store.getModel(run.modelId);
        const session = store.getSession(run.sessionId);
        await store.appendModelInvocationUsage({
          attemptIndex: 0,
          cacheReadTokens: run.modelUsage?.cacheReadTokens ?? null,
          cacheWriteTokens: run.modelUsage?.cacheWriteTokens ?? null,
          costUsd: null,
          finishedAt: run.completedAt,
          id: randomUUID(),
          inputTokens: run.modelUsage?.inputTokens ?? null,
          invocationId: run.id,
          invocationKind: "paper-vision",
          model: model?.model ?? run.modelName,
          modelProfileId: run.modelId,
          modelProfileName: run.modelName,
          outputTokens: run.modelUsage?.outputTokens ?? null,
          ...(session?.projectId ? { projectId: session.projectId } : {}),
          sessionId: run.sessionId,
          startedAt,
          totalTokens: run.modelUsage?.totalTokens ?? null,
          usageStatus: run.modelUsage ? "reported" : "provider-not-reported",
        });
        sendJson(response, 201, run);
        return;
      }

      const epochMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/permission-epoch$/);
      if (epochMatch && request.method === "GET") {
        const epoch = store.getSessionPermissionEpoch(epochMatch[1]!);
        if (!epoch) return sendError(response, 404, "Permission Epoch not found");
        sendJson(response, 200, epoch);
        return;
      }
      if (epochMatch && request.method === "POST") {
        if (await sessionHasActiveRun(store, epochMatch[1]!)) return sendError(response, 409, "Cannot rotate permissions during an active run");
        const body = await readJson<RotatePermissionEpochRequest>(request);
        const health = await runnerClient.health().catch(() => undefined);
        const teardown = health?.scientificEnvs?.available
          ? await runnerClient.teardownKernels(epochMatch[1]!, "Permission Epoch changed; persistent memory was lost")
          : undefined;
        sendJson(response, 201, await store.rotatePermissionEpoch(
          epochMatch[1]!,
          body.reason ?? "Permission policy changed",
          teardown?.count ? teardown.reason : undefined,
        ));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/permission-requests") {
        sendJson(response, 200, store.listPermissionRequests(url.searchParams.get("sessionId") ?? undefined));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/permission-grants") {
        sendJson(response, 200, store.listPermissionGrants());
        return;
      }
      const sessionPermissionRequestMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/permission-requests$/);
      if (sessionPermissionRequestMatch && request.method === "POST") {
        const body = await readJson<CreatePermissionRequest>(request);
        sendJson(response, 201, await store.requestPermission(
          sessionPermissionRequestMatch[1]!,
          body.action,
          body.resource,
          body.summary,
          { executionId: body.executionId, toolCallId: body.toolCallId },
        ));
        return;
      }
      const permissionDecisionMatch = url.pathname.match(/^\/api\/permission-requests\/([^/]+)\/decision$/);
      if (permissionDecisionMatch && request.method === "POST") {
        const body = await readJson<DecidePermissionRequest>(request);
        const existingRequest = store.getPermissionRequest(permissionDecisionMatch[1]!);
        if (!existingRequest) return sendError(response, 404, "Permission request not found");
        if (!body.decision) {
          return sendError(response, 400, "Permission decision is required");
        }
        if (!new Set(["allow_once", "allow_matching", "deny"]).has(body.decision)) {
          return sendError(response, 400, "Invalid permission decision");
        }
        if (!existingRequest.sessionId) return sendError(response, 400, "Permission decisions require a Session");
        const outcome = await permissionDecisions.run(existingRequest.sessionId, async () => {
          const current = store.getPermissionRequest(permissionDecisionMatch[1]!);
          if (!current) return { kind: "not_found" as const };
          if (current.state !== "pending") return { kind: "already_resolved" as const, request: current };
          const teardown = (await runnerClient.health().catch(() => undefined))?.scientificEnvs?.available
            ? await runnerClient.teardownKernels(existingRequest.sessionId!, "Permission decision changed; persistent memory was lost")
            : undefined;
          const latest = store.getPermissionRequest(permissionDecisionMatch[1]!);
          if (!latest) return { kind: "not_found" as const };
          if (latest.state !== "pending") return { kind: "already_resolved" as const, request: latest };
          const decision = await store.decidePermissionRequest(
            permissionDecisionMatch[1]!,
            body.decision,
            teardown?.count ? teardown.reason : undefined,
          );
          return { decision, kind: "decided" as const };
        });
        if (outcome.kind === "not_found") return sendError(response, 404, "Permission request not found");
        if (outcome.kind === "already_resolved") {
          sendJson(response, 409, {
            code: "PERMISSION_ALREADY_RESOLVED",
            details: { request: outcome.request },
            error: "Permission request was already resolved",
          });
          return;
        }
        const advanced = await advanceResolvedPermissionRequests(
          outcome.decision.resolvedRequests,
          store,
          artifactManager,
          remoteCompute,
          provenanceRecorder,
        );
        sendJson(response, 200, {
          ...outcome.decision,
          ...(advanced.artifactApprovals.length ? { artifactApprovals: advanced.artifactApprovals } : {}),
          ...(advanced.remoteJobs.length ? { remoteJobs: advanced.remoteJobs } : {}),
        });
        return;
      }
      const permissionAuthorizationsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/permission-authorizations$/);
      if (permissionAuthorizationsMatch && request.method === "GET") {
        sendJson(response, 200, store.listPermissionAuthorizations(
          permissionAuthorizationsMatch[1]!,
          { executionId: url.searchParams.get("executionId") ?? undefined },
        ));
        return;
      }
      const permissionGrantMatch = url.pathname.match(/^\/api\/permission-grants\/([^/]+)$/);
      if (permissionGrantMatch && request.method === "DELETE") {
        const grant = store.getPermissionGrant(permissionGrantMatch[1]!);
        if (!grant) return sendError(response, 404, "Permission grant not found");
        const sessionId = grant.sessionId;
        const teardown = sessionId && (await runnerClient.health().catch(() => undefined))?.scientificEnvs?.available
          ? await runnerClient.teardownKernels(sessionId, "Permission grant revoked; persistent memory was lost")
          : undefined;
        const revoked = await store.revokePermissionGrant(
          grant.id,
          teardown?.count ? teardown.reason : undefined,
        );
        sendJson(response, 200, revoked);
        return;
      }

      const filesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/files$/);
      if (filesMatch && request.method === "GET") {
        if (!store.getSession(filesMatch[1]!)) return sendError(response, 404, "Session not found");
        sendJson(response, 200, await listWorkspaceFiles(store, filesMatch[1]!));
        return;
      }

      const workspaceUploadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/workspace\/upload$/);
      if (workspaceUploadMatch && request.method === "POST") {
        const sessionId = workspaceUploadMatch[1]!;
        store.assertSessionWritable(sessionId);
        const conflict = parseConflictPolicy(url.searchParams.get("conflict"));
        const quotas = store.getQuotaSettings();
        const uploadLimits = {
          maxFileBytes: quotas.uploadMaxFileBytes,
          maxRequestBytes: quotas.uploadMaxRequestBytes,
          maxWorkspaceBytes: quotas.runnerMaxWorkspaceBytes,
        };
        const parts = await readMultipartUploads(request, uploadLimits.maxRequestBytes);
        const result: WorkspaceUploadResult = await uploadWorkspaceParts({
          conflict,
          limits: uploadLimits,
          listFiles: () => listWorkspaceFiles(store, sessionId),
          parts,
          registerArtifact: async (path) => {
            await provenanceRecorder.registerWorkspaceArtifact({
              origin: "user_upload",
              originMeta: { uploadedFilename: path },
              path,
              sessionId,
              workspaceRoot: store.workspacePath(sessionId),
            });
          },
          workspaceRoot: store.workspacePath(sessionId),
        });
        sendJson(response, 201, result);
        return;
      }

      const sessionRunsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runs$/);
      if (sessionRunsMatch && request.method === "GET") {
        if (!store.getSession(sessionRunsMatch[1]!)) return sendError(response, 404, "Session not found");
        sendJson(response, 200, await store.listSessionRuns(sessionRunsMatch[1]!));
        return;
      }
      if (sessionRunsMatch && request.method === "POST") {
        const sessionId = sessionRunsMatch[1]!;
        if (!store.getSession(sessionId)) return sendError(response, 404, "Session not found");
        const run = await createQueuedRun(store, skillCatalog, sessionId, await readJson<SendMessageRequest>(request));
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
          sessionId,
          config,
          memoryGraphClient,
        );
        sendJson(response, 201, run);
        return;
      }

      const sessionRunMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runs\/([^/]+)$/);
      if (sessionRunMatch && request.method === "GET") {
        const run = await store.getSessionRun(sessionRunMatch[1]!, sessionRunMatch[2]!);
        if (!run) return sendError(response, 404, "Run not found");
        sendJson(response, 200, run);
        return;
      }

      const sessionRunEventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runs\/([^/]+)\/events$/);
      if (sessionRunEventsMatch && request.method === "GET") {
        const sessionId = sessionRunEventsMatch[1]!;
        const runId = sessionRunEventsMatch[2]!;
        const after = Number(url.searchParams.get("after") ?? request.headers["last-event-id"] ?? "0");
        if (!Number.isFinite(after) || after < 0) return sendError(response, 400, "after must be a non-negative number");
        const wantsSse = /\btext\/event-stream\b/.test(request.headers.accept ?? "");
        if (wantsSse) {
          await streamStoredRunEvents(response, store, sessionId, runId, Math.floor(after), true);
        } else {
          if (!await store.getSessionRun(sessionId, runId)) return sendError(response, 404, "Run not found");
          sendJson(response, 200, await store.listSessionRunEvents(sessionId, runId, Math.floor(after)));
        }
        return;
      }

      const runStreamEventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runs\/([^/]+)\/streams\/([^/]+)\/events$/);
      if (runStreamEventsMatch && request.method === "GET") {
        const sessionId = runStreamEventsMatch[1]!;
        const runId = runStreamEventsMatch[2]!;
        const after = Number(url.searchParams.get("after") ?? "0");
        if (!Number.isFinite(after) || after < 0) return sendError(response, 400, "after must be a non-negative number");
        if (!await store.getSessionRun(sessionId, runId)) return sendError(response, 404, "Run not found");
        sendJson(response, 200, await store.listRunStreamEvents(sessionId, runId, runStreamEventsMatch[3]!, Math.floor(after)));
        return;
      }

      const sessionRunCancelMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runs\/([^/]+)\/cancel$/);
      if (sessionRunCancelMatch && request.method === "POST") {
        const sessionId = sessionRunCancelMatch[1]!;
        const runId = sessionRunCancelMatch[2]!;
        if (runId === "current") {
          await cancelCurrentSessionRun(response, store, sessionId);
          return;
        }
        await cancelSessionRun(response, store, sessionId, runId);
        return;
      }

      const artifactsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifacts$/);
      if (artifactsMatch && request.method === "GET") {
        sendJson(response, 200, store.listArtifacts(artifactsMatch[1]!));
        return;
      }
      const artifactReviewsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifact-reviews$/);
      if (artifactReviewsMatch && request.method === "GET") {
        const sessionId = artifactReviewsMatch[1]!;
        if (!store.getSession(sessionId)) return sendError(response, 404, "Session not found");
        sendJson(response, 200, await store.listArtifactReviews(sessionId));
        return;
      }
      const manualReviewerMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/reviewer-specialist\/review$/);
      if (manualReviewerMatch && request.method === "POST") {
        const sessionId = manualReviewerMatch[1]!;
        if (!store.getSession(sessionId)) return sendError(response, 404, "Session not found");
        const reviewerSettings = store.getReviewerSpecialistSettings();
        if (!reviewerSettings.enabled) return sendError(response, 409, "Reviewer Specialist is off");
        const body = await readJson<{ messageId?: string }>(request);
        const messageId = body.messageId?.trim() ?? "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)) {
          return sendError(response, 400, "A valid reviewer message id is required");
        }
        const toolCallId = `manual-review:${messageId}`;
        await store.appendReviewerCheckpointMessage(sessionId, messageId, toolCallId);
        try {
          const versions = store.listArtifacts(sessionId)
            .filter((artifact) => artifact.createdInSessionId === sessionId)
            .flatMap((artifact) => store.listArtifactVersions(sessionId, artifact.id)
              .filter((version) => version.sessionId === sessionId)
              .at(-1) ?? [])
            .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
          if (!versions.length) throw new Error("No Artifacts to review");
          let semanticReview: ReturnType<typeof createReviewAgentOptions> | undefined;
          if (reviewerSettings.level === "deep") {
            const session = store.getSession(sessionId)!;
            const runtimeSettings = store.resolveRuntimeSettings(sessionId).effective;
            const selectedModel = store.getModel(runtimeSettings.modelId);
            const apiToken = selectedModel ? store.getModelApiToken(selectedModel.id) : undefined;
            if (!selectedModel || !apiToken) throw new Error("The selected Reviewer model is unavailable");
            const permission = {
              getEpoch: () => store.getSessionPermissionEpoch(sessionId)!,
              requirePrivilege: async (privilege: {
                action: "code" | "connector" | "host";
                executionId?: string;
                resource: string;
                signal?: AbortSignal;
                summary: string;
                toolCallId?: string;
              }) => {
                const check = await store.requestPermission(sessionId, privilege.action, privilege.resource, privilege.summary, {
                  ...(privilege.executionId ? { executionId: privilege.executionId } : {}),
                  ...(privilege.toolCallId ? { toolCallId: privilege.toolCallId } : {}),
                });
                if (!check.allowed) throw new Error("Reviewer connector access requires an existing permission grant");
                return check.authorization;
              },
            };
            const reviewerSkills = skillCatalog.resolve(["citation-reviewer", "computation-reviewer", "literature-searcher"]);
            const reviewerWorkspace: WorkspaceAgentOptions = {
              config: { apiToken, baseUrl: selectedModel.baseUrl, dataDir: store.dataDir, model: selectedModel.model },
              enabledConnectorIds: runtimeSettings.enabledConnectorIds,
              executePython: async () => { throw new Error("Reviewer Specialist cannot execute code"); },
              executeShell: async () => { throw new Error("Reviewer Specialist cannot execute code"); },
              ...createMcpWorkspaceTools({
                artifactManager, broker: mcpBroker, catalog: mcpCatalog,
                enabledSourceIds: runtimeSettings.enabledConnectorIds,
                emitPermissionRequest: () => undefined, paperService, pauseExternalWait: () => () => undefined,
                permission, projectId: session.projectId, registry: mcpRegistry, sessionId, store,
                suppressMemoryGraphMirror: true, turnId: toolCallId,
              }),
              ...createWebWorkspaceTools({
                broker: webBroker,
                context: { forceRefresh: false, projectId: session.projectId, sessionId, turnId: toolCallId },
                permission,
              }),
              approvalMode: session.approvalMode,
              skills: reviewerSkills,
              workspaceRoot: store.workspacePath(sessionId),
            };
            semanticReview = createReviewAgentOptions({
              modelIdentity: `${selectedModel.id}:${selectedModel.model}`,
              runIdleTimeoutMs: config.gatewayIdleTimeoutMs,
              skills: reviewerSkills,
              workspace: reviewerWorkspace,
            });
          }
          const result = await runReviewerCheckpoint({
            artifactVersionIds: versions.map((version) => version.id),
            cas: provenanceRecorder.cas,
            parentRunId: toolCallId,
            reason: "Manual Reviewer Specialist request",
            reviewLevel: reviewerSettings.level,
            sessionId,
            store,
            toolCallId,
            ...(memoryGraphEnabled() ? {
              traceEvidenceReference: createEvidenceReferenceTracer(memoryGraphClient, sessionId, memoryGraphEnabled),
              traceArtifactProvenance: async (reference, signal) => {
                if (signal?.aborted) throw new DOMException("Review cancelled", "AbortError");
                return memoryGraphClient.traceProvenance({ nodeId: reference.artifactId }, sessionId);
              },
            } : {}),
            onProgress: async (progress) => {
              await store.updateReviewerCheckpointProgress(sessionId, messageId, progress);
            },
            onArtifactCompleted: async (completedReviews) => {
              await store.updateReviewerCheckpointMessage(sessionId, messageId, {
                content: reviewerCheckpointPromptContent(completedReviews, undefined, true), status: "running",
              });
            },
            ...(semanticReview ? { semanticReview } : {}),
          });
          const message = await store.updateReviewerCheckpointMessage(sessionId, messageId, {
            content: reviewerCheckpointPromptContent(result.reviews),
            status: "completed",
          });
          sendJson(response, 200, { ...result, message });
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Reviewer Specialist failed";
          const message = await store.updateReviewerCheckpointMessage(sessionId, messageId, {
            content: reviewerCheckpointPromptContent([], detail),
            error: detail,
            status: "failed",
          });
          const reviews = (await store.listArtifactReviews(sessionId))
            .filter((review) => review.toolCallId === toolCallId);
          sendJson(response, 200, { error: detail, message, reviews });
        }
        return;
      }
      const artifactVersionsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifacts\/([^/]+)\/versions$/);
      if (artifactVersionsMatch && request.method === "GET") {
        sendJson(response, 200, store.listArtifactVersions(artifactVersionsMatch[1]!, artifactVersionsMatch[2]!));
        return;
      }
      const artifactVersionContentMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifact-versions\/([^/]+)\/content$/);
      if (artifactVersionContentMatch && request.method === "GET") {
        const version = store.getArtifactVersion(artifactVersionContentMatch[1]!, artifactVersionContentMatch[2]!);
        if (!version) return sendError(response, 404, "Artifact version not found");
        send(response, 200, version.mediaType, await provenanceRecorder.cas.read(version.content.hash));
        return;
      }
      const artifactVersionProvenanceMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifact-versions\/([^/]+)\/provenance$/);
      if (artifactVersionProvenanceMatch && request.method === "GET") {
        sendJson(response, 200, await artifactVersionProvenance(
          store,
          provenanceRecorder,
          memoryGraphClient,
          artifactVersionProvenanceMatch[1]!,
          artifactVersionProvenanceMatch[2]!,
        ));
        return;
      }
      const artifactVersionDiffMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifact-versions\/([^/]+)\/diff$/);
      if (artifactVersionDiffMatch && request.method === "GET") {
        sendJson(response, 200, await artifactVersionDiff(
          store,
          provenanceRecorder,
          artifactVersionDiffMatch[1]!,
          artifactVersionDiffMatch[2]!,
          url.searchParams.get("against") ?? undefined,
        ));
        return;
      }
      const artifactDashboardMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifact-dashboard$/);
      if (artifactDashboardMatch && request.method === "GET") {
        const sid = artifactDashboardMatch[1]!;
        const session = store.getSession(sid);
        if (!session) return sendError(response, 404, "Session not found");
        sendJson(response, 200, await buildArtifactDashboard(store, sid, store.getProject(session.projectId), session));
        return;
      }
      const artifactVersionPreviewMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifact-versions\/([^/]+)\/preview$/);
      if (artifactVersionPreviewMatch && request.method === "GET") {
        try {
          sendJson(response, 200, await buildArtifactVersionPreview(
            store,
            provenanceRecorder,
            artifactVersionPreviewMatch[1]!,
            artifactVersionPreviewMatch[2]!,
            url.searchParams.get("maxRows") ?? undefined,
            url.searchParams.get("maxChars") ?? undefined,
            url.searchParams.get("maxCells") ?? undefined,
          ));
        } catch (error) {
          if (error instanceof ArtifactDashboardError) {
            sendError(response, error.code === "ARTIFACT_NOT_FOUND" ? 404 : 422, error.message);
            return;
          }
          throw error;
        }
        return;
      }
      const artifactAnnotationsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifact-versions\/([^/]+)\/annotations$/);
      if (artifactAnnotationsMatch && request.method === "GET") {
        sendJson(response, 200, store.listArtifactAnnotations(artifactAnnotationsMatch[1]!, artifactAnnotationsMatch[2]!));
        return;
      }
      const memorySubgraphMatch = url.pathname === "/api/memory/subgraph";
      if (memorySubgraphMatch && request.method === "GET") {
        const sid = url.searchParams.get("session_id") ?? "";
        mgLog.info("GET /api/memory/subgraph in: session=%s (toggle=%s)", sid, memoryGraphEnabled() ? "on" : "off");
        if (!sid || !store.getSession(sid)) {
          mgLog.info("GET /api/memory/subgraph 404: session=%s not found", sid);
          return sendError(response, 404, "Session not found");
        }
        // Reverse-proxy to the memory-graph service; on any failure return an
        // empty subgraph with a reason so the frontend degrades gracefully.
        // - memory_graph_disabled: the toggle is off → render nothing.
        // - memory_graph_unreachable: the toggle is on but the sidecar/Neo4j
        //   is down → render a degraded notice pointing at the real prerequisites.
        const subgraph = memoryGraphEnabled()
          ? await memoryGraphClient.getSubgraph(sid).catch((error: unknown) => {
              mgLog.warn("GET /api/memory/subgraph proxy error: session=%s: %s",
                sid, error instanceof Error ? error.message : String(error));
              return { nodes: [], edges: [], total: 0, truncated: false, reason: "memory_graph_unreachable" as const };
            })
          : { nodes: [], edges: [], total: 0, truncated: false, reason: "memory_graph_disabled" as const };
        sendJson(response, 200, subgraph);
        return;
      }
      // --- Memory-graph cross-session read endpoints --------------------------
      // All reverse-proxy to the Python sidecar; when the feature is off
      // (toggle off) or the sidecar/Neo4j is down, each returns an empty
      // result carrying a `reason` so the frontend degrades without errors.
      if (request.method === "POST" && url.pathname === "/api/memory/query/match") {
        const body = await readJson<{ query: string; session_id?: string }>(request);
        if (!body.query?.trim()) return sendError(response, 400, "query must be non-empty");
        const result = memoryGraphEnabled()
          ? await memoryGraphClient.queryMatch(body.query, body.session_id).catch(() => emptyMatch("memory_graph_unreachable"))
          : emptyMatch("memory_graph_disabled");
        sendJson(response, 200, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/memory/query/by-node-type") {
        const body = await readJson<{ node_types: MemoryGraphNodeLabel[]; session_id?: string }>(request);
        if (!body.node_types?.length) return sendError(response, 400, "node_types must be a non-empty list");
        const result = memoryGraphEnabled()
          ? await memoryGraphClient.byNodeType(body.node_types, body.session_id).catch(() => emptyMatch("memory_graph_unreachable"))
          : emptyMatch("memory_graph_disabled");
        sendJson(response, 200, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/memory/query/by-edge-type") {
        const body = await readJson<{ edge_types: MemoryGraphEdgeType[]; session_id?: string }>(request);
        if (!body.edge_types?.length) return sendError(response, 400, "edge_types must be a non-empty list");
        const result = memoryGraphEnabled()
          ? await memoryGraphClient.byEdgeType(body.edge_types, body.session_id).catch(() => ({
              edges: [], nodes: [], total: 0, truncated: false, reason: "memory_graph_unreachable",
            }))
          : { edges: [], nodes: [], total: 0, truncated: false, reason: "memory_graph_disabled" as const };
        sendJson(response, 200, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/memory/query/chain") {
        const body = await readJson<{
          node_id: string;
          session_id?: string;
          version?: number;
          chain_kind?: "full" | "task" | "artifact";
        }>(request);
        if (!body.node_id?.trim()) return sendError(response, 400, "node_id must be non-empty");
        if (body.chain_kind && !["full", "task", "artifact"].includes(body.chain_kind)) {
          return sendError(response, 400, "chain_kind must be 'full', 'task', or 'artifact'");
        }
        const result = memoryGraphEnabled()
          ? await memoryGraphClient
              .getChain(body.node_id, body.session_id, body.version, body.chain_kind)
              .catch(() => ({
                nodes: [], edges: [], total: 0, truncated: false, reason: "memory_graph_unreachable",
              }))
          : { nodes: [], edges: [], total: 0, truncated: false, reason: "memory_graph_disabled" as const };
        sendJson(response, 200, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/memory/trace/provenance") {
        // Reviewer authenticity trace: ordered provenance chain + broken/
        // truncated/reason. Same reverse-proxy three-step as query/chain —
        // toggle off or sidecar down → empty trace with a reason, never a 500.
        const body = await readJson<{
          node_id?: string;
          target_label?: string;
          max_hops?: number;
          session_id?: string;
        }>(request);
        if (!body.node_id?.trim()) return sendError(response, 400, "node_id must be non-empty");
        const result = memoryGraphEnabled()
          ? await memoryGraphClient.traceProvenance(
              { nodeId: body.node_id, targetLabel: body.target_label, maxHops: body.max_hops },
              body.session_id,
            ).catch(() => emptyTrace("memory_graph_unreachable"))
          : emptyTrace("memory_graph_disabled");
        sendJson(response, 200, result as MemoryGraphTraceResult);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/memory/query/artifact-provenance") {
        const artifactId = url.searchParams.get("artifact_id") ?? "";
        const version = Number(url.searchParams.get("version"));
        if (!artifactId || !Number.isFinite(version) || version < 1) {
          return sendError(response, 400, "artifact_id + version required");
        }
        const sessionId = url.searchParams.get("session_id") ?? undefined;
        // Reverse-proxy to the sidecar's provenance aggregation endpoint (graph
        // = directory: hashes / routing keys only). The Node handler turns
        // these into bodies, falling back to the legacy SessionStore endpoint
        // when the graph is off/unreachable or the version was not mirrored.
        const result = memoryGraphEnabled()
          ? await memoryGraphClient.getArtifactProvenance(artifactId, version, sessionId).catch(() => null)
          : null;
        if (!result) {
          sendJson(response, 200, { reason: "memory_graph_disabled" });
        } else {
          sendJson(response, 200, result);
        }
        return;
      }
      if (artifactAnnotationsMatch && request.method === "POST") {
        sendJson(response, 201, await store.createArtifactAnnotation(
          artifactAnnotationsMatch[1]!,
          artifactAnnotationsMatch[2]!,
          await readJson<CreateArtifactAnnotationRequest>(request),
        ));
        return;
      }

      const executionRunsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/execution-runs$/);
      if (executionRunsMatch && request.method === "GET") {
        if (!store.getSession(executionRunsMatch[1]!)) return sendError(response, 404, "Session not found");
        sendJson(response, 200, await store.listExecutionRuns(executionRunsMatch[1]!));
        return;
      }

      const derivationsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifact-derivations$/);
      if (derivationsMatch && request.method === "GET") {
        if (!store.getSession(derivationsMatch[1]!)) return sendError(response, 404, "Session not found");
        sendJson(response, 200, await store.listArtifactDerivations(derivationsMatch[1]!));
        return;
      }

      const claimsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/claims$/);
      if (claimsMatch && request.method === "GET") {
        if (!store.getSession(claimsMatch[1]!)) return sendError(response, 404, "Session not found");
        sendJson(response, 200, await store.listClaims(claimsMatch[1]!));
        return;
      }

      const evidenceLinksMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/evidence-links$/);
      if (evidenceLinksMatch && request.method === "GET") {
        if (!store.getSession(evidenceLinksMatch[1]!)) return sendError(response, 404, "Session not found");
        sendJson(response, 200, await store.listEvidenceLinks(evidenceLinksMatch[1]!));
        return;
      }

      const manifestsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt-manifests$/);
      if (manifestsMatch && request.method === "GET") {
        if (!store.getSession(manifestsMatch[1]!)) return sendError(response, 404, "Session not found");
        sendJson(response, 200, await store.listPromptManifests(manifestsMatch[1]!));
        return;
      }

      const usageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/usage$/);
      if (usageMatch && request.method === "GET") {
        if (!store.getSession(usageMatch[1]!)) return sendError(response, 404, "Session not found");
        sendJson(response, 200, await store.getSessionUsageSummary(usageMatch[1]!));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/usage/models") {
        sendJson(response, 200, await store.getGlobalModelUsageSummary());
        return;
      }

      const casMatch = url.pathname.match(/^\/api\/cas\/([a-f0-9]{64})$/);
      if (casMatch && request.method === "GET") {
        send(response, 200, "application/octet-stream", await provenanceRecorder.cas.read(casMatch[1]!));
        return;
      }
      if (filesMatch && request.method === "POST") {
        store.assertSessionWritable(filesMatch[1]!);
        const body = await readJson<UploadFileRequest>(request);
        const target = resolveWorkspaceFile(store.workspacePath(filesMatch[1]!), body.path ?? "");
        if (Buffer.byteLength(body.content ?? "") > 1_000_000) return sendError(response, 413, "File exceeds 1 MB");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, body.content ?? "", "utf8");
        await provenanceRecorder.registerWorkspaceArtifact({
          origin: "user_upload",
          originMeta: { uploadedFilename: body.path },
          path: body.path,
          sessionId: filesMatch[1]!,
          workspaceRoot: store.workspacePath(filesMatch[1]!),
        });
        sendJson(response, 201, (await listWorkspaceFiles(store, filesMatch[1]!)).find((file) => file.path === body.path));
        return;
      }

      const fileMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/file$/);
      if (fileMatch && request.method === "GET") {
        if (!store.getSession(fileMatch[1]!)) return sendError(response, 404, "Session not found");
        const requestedPath = url.searchParams.get("path") ?? "";
        const target = resolveWorkspaceFile(store.workspacePath(fileMatch[1]!), requestedPath);
        send(response, 200, contentTypeForPath(target), await readFile(target));
        return;
      }

      const cancelRunMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runs\/current\/cancel$/);
      if (cancelRunMatch && request.method === "POST") {
        await cancelCurrentSessionRun(response, store, cancelRunMatch[1]!);
        return;
      }

      const messagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (messagesMatch && request.method === "POST") {
        if (!store.getSession(messagesMatch[1]!)) return sendError(response, 404, "Session not found");
        await streamAgentRun(
          request,
          response,
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
          messagesMatch[1]!,
          await readJson<SendMessageRequest>(request),
          config,
          memoryGraphClient,
        );
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        sendError(response, 404, "Not found");
        return;
      }
      if (request.method === "GET") {
        await serveStatic(response, config.staticDir, url.pathname);
        return;
      }
      sendError(response, 404, "Not found");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const message = error instanceof Error ? error.message : "Request failed";
      if (error instanceof ApiStatusError) sendError(response, error.statusCode, message);
      else if (code === "ENOENT") sendError(response, 404, "File not found");
      else if (code === "PAYLOAD_TOO_LARGE" || code === "QUOTA_EXCEEDED") {
        sendError(response, 413, error instanceof Error ? error.message : "Payload too large");
      }
      else if (code === "CONFLICT") sendError(response, 409, message);
      else if (code === "UNSUPPORTED_MEDIA_TYPE") sendError(response, 415, message);
      else if (code === "SKILL_NOT_FOUND") sendError(response, 404, message);
      else if (code === "SKILL_CONFLICT" || code === "SKILL_READ_ONLY") sendError(response, 409, message);
      else if (/^(Project|Session|Proxy server) not found$/.test(message)) sendError(response, 404, message);
      else if (message === "Session is archived and read-only") sendError(response, 409, message);
      else if (message.startsWith("Proxy server is referenced by ")) sendError(response, 409, message);
      else if (isKnownClientInputError(error)) sendError(response, 400, message);
      else {
        apiLog.error("unclassified_request_error", {
          errorMessage: shortErrorMessage(error),
          method: request.method ?? "UNKNOWN",
          path: requestPath,
          status: 500,
        });
        sendError(response, 500, "Internal server error");
      }
    }
  });
  patchEphemeralCallback(server);
  return server;
}

export async function startApiServer(config = loadServerConfig()): Promise<Server> {
  const server = createApiServer(config);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  apiLog.info("service_started", { host: config.host, port });
  console.log(`ScienceDiscovery listening on http://${config.host}:${port}`);
  for (const line of accessTokenBanner(config)) console.log(line);
  if (config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
    console.warn("Warning: M0 authentication and Python execution are not safe for untrusted networks.");
  }
  return server;
}
