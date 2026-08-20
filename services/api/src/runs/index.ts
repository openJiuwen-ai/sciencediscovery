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
import { dirname, join, resolve } from "node:path";

import { shortErrorMessage } from "@science-agent/operational-logging";

import {
  buildWorkspaceSystemPrompt,
  DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  DEFAULT_MAX_TOTAL_SUBAGENTS,
  type WorkspaceAgentOptions,
  WORKSPACE_SYSTEM_PROMPT_VERSION,
} from "@science-agent/context";
import type { AgentConfig } from "@science-agent/model";
import {
  createMainAgentProfile,
  createSubagentProfile,
  resolveSubagentConfig,
  type AgentHistoryMessage,
} from "@science-agent/orchestration";
import { normalizeWorkspaceRelativePath, resolveWorkspaceFile } from "@science-agent/workspace";
import { resolveProxyForUrl } from "../proxy/index.js";
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
  CreateRemoteJobRequest,
  CreateSessionRequest,
  CreateSpecialistRequest,
  DecidePermissionRequest,
  DecideRemoteJobRequest,
  JsonSchema,
  Subagent,
  SubagentInput,
  UpdateSubagentBriefRequest,
  UpdateWebSettingsRequest,
  DistillSessionSkillRequest,
  Environment,
  EffectiveRuntimeSettings,
  DeleteResourceRequest,
  ImportSkillFromGitRequest,
  InstallEnvironmentRequest,
  RunStreamEvent,
  WorkspaceFile,
  RuntimeSessionRun,
  RuntimeSettingsOverrides,
  RuntimeStatus,
  SendMessageRequest,
  Session,
  SessionRun,
  SessionRunEvent,
  SessionRunStatus,
  SessionListState,
  Specialist,
  ToolTrace,
  RotatePermissionEpochRequest,
  RunnerHealth,
  SystemTimeoutSettings,
  TimeoutKind,
  ScientificEnvironmentSetup,
  SkillDeletionImpact,
  UpdateSkillRequest,
  UpdateModelProfileRequest,
  UpdateProjectRequest,
  UpdateSessionRequest,
  UploadFileRequest,
  RegisterRemoteHostRequest,
  PromptManifest,
  ProposePlanRequest,
  RevisePlanRequest,
  SubagentStep,
  UpdateSpecialistRequest,
} from "@science-agent/schema";
import { createLocalSessionTitle, UNTITLED_SESSION_TITLE } from "@science-agent/schema";
import { reviewerSpecialistSupportsLevel } from "@science-agent/schema";

import { SessionStore, SessionStoreHttpError } from "../store.js";
import { RunnerClient } from "../runner-client.js";
import { classifyRunFailure, runFailureMessage } from "../run-failure.js";
import { ProvenanceRecorder } from "../provenance.js";
import { syncScientificEnvironmentCatalog } from "../scientific-environment-catalog.js";
import {
  ArtifactDashboardError,
  buildArtifactDashboard,
  buildArtifactVersionPreview,
} from "../artifact-dashboard.js";
import { inferDomain, MemoryGraphClient, MemoryGraphSink } from "../memory-graph.js";
import { mgLog } from "../memory-graph-log.js";
import { runLog } from "../logging.js";
import { createPromptManifest } from "../prompt-manifest.js";
import { createBuiltinMcpSourceRegistry } from "@science-agent/mcp-sources";
import { ArtifactManager } from "../mcp/artifact-manager.js";
import { McpGovernanceBroker } from "../mcp/broker.js";
import { McpSourceCatalog } from "../mcp/source-catalog.js";
import { createMcpWorkspaceTools } from "../mcp/workspace-tools.js";
import { WebBroker } from "../web-providers/broker.js";
import { createWebWorkspaceTools } from "../web-providers/workspace-tools.js";
import {
  createDialogueSkillDraft,
  createSessionSkillDraft,
  SkillCatalog,
  SkillCatalogError,
  type RuntimeSkillSnapshot,
} from "../skills.js";
import { MAX_PAPER_PDF_BYTES, PaperService } from "../papers.js";
import { RemoteComputeClient } from "../remote-compute.js";
import { classifySubagentFailure } from "../subagent-lifecycle.js";
import { runMainRequestExecution, runSubagentTask } from "../agent-run/orchestrators.js";
import { createAgentPermissionRuntime } from "../agent-run/permission-runtime.js";
import { createRequestExecutionContext } from "../agent-run/request-execution.js";
import { createWorkspaceExecutionBindings } from "../agent-run/workspace-bindings.js";
import {
  reviewerSpecialistAvailable,
} from "../reviewer-specialist/citation-review.js";
import {
  cancelReviewerCheckpoints,
  reviewerCheckpointPromptContent,
  runReviewerCheckpoint,
} from "../reviewer-specialist/review-checkpoint.js";
import { createEvidenceReferenceTracer } from "../reviewer-specialist/computation-review.js";
import { createReviewAgentOptions } from "../reviewer-specialist/review-agent-executor.js";

import {
  aggregateToolText,
  artifactVersionDiff,
  artifactVersionProvenance,
  listWorkspaceFiles,
  mcpConnectorManifest,
} from "../artifacts/index.js";
import {
  advanceResolvedPermissionRequests,
  startApprovedRemoteJob,
  waitForPermissionDecision,
} from "../permissions/index.js";
import {
  formatSubagentExecutionPrompt,
  isSubagentPrivateWorkspacePath,
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

const PRIMARY_TOOL_INPUT_FIELDS = ["code", "command", "query", "path", "url", "prompt", "content", "text", "input"];

function compactToolInputValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

/** Match the raw-input semantics used by the Web tool cards. */
function formatSubagentToolInput(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 1) return compactToolInputValue(entries[0]![1]);
  const primary = PRIMARY_TOOL_INPUT_FIELDS.find((field) => typeof args[field] === "string");
  if (primary !== undefined) {
    const rest = entries
      .filter(([key]) => key !== primary)
      .map(([key, value]) => `${key}: ${compactToolInputValue(value)}`)
      .join("\n");
    return rest ? `${args[primary] as string}\n${rest}` : args[primary] as string;
  }
  return JSON.stringify(args);
}
import { generateRefinedSessionTitle } from "../session-naming.js";

import { type ServerConfig } from "../http/config.js";
import { sendError, sendJson } from "../http/response.js";

const SUBAGENT_PROGRESS_FLUSH_MS = 250;
const activeSessions = new Map<string, RuntimeSessionRun>();
const scheduledSessions = new Set<string>();
const activeRunAbortControllers = new Map<string, AbortController>();
const cancelledRuns = new Set<string>();

type RunEventSink = (event: RunStreamEvent) => void | Promise<void>;
type RunEventSubscriber = (event: SessionRunEvent) => void;
const runEventSubscribers = new Map<string, Set<RunEventSubscriber>>();

function skillIdForSubagentType(skillCatalog: SkillCatalog, subagentType: string | undefined): string | undefined {
  const requested = subagentType?.trim().toLowerCase();
  if (!requested) return undefined;
  const normalized = requested
    .replace(/[._\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const available = new Set(skillCatalog.ids());
  return [requested, normalized].find((candidate) => available.has(candidate));
}

function resolveSubagentSpecialist(store: SessionStore, sessionSpecialistId: string | undefined, input: SubagentInput): Specialist | undefined {
  const requestedSpecialistId = input.specialistId?.trim();
  if (requestedSpecialistId) return store.getSpecialist(requestedSpecialistId);
  return store.getSpecialist(sessionSpecialistId);
}

export class ApiStatusError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

/** Empty match-response shape with a degradation reason (feature off / unreachable). */
export function emptyMatch(reason: "memory_graph_disabled" | "memory_graph_unreachable") {
  return { hits: [] as unknown[], total: 0, truncated: false, reason };
}

/** Empty trace-response shape with a degradation reason. A disabled or
 * unreachable graph surfaces as ``broken:true`` (chain not verifiable) so the
 * reviewer marks the artifact for manual verification rather than treating an
 * outage as an intact chain. Mirrors the sidecar's degraded-trace shape. */
export function emptyTrace(reason: "memory_graph_disabled" | "memory_graph_unreachable"): MemoryGraphTraceResult {
  return { startNode: null, chain: [], broken: true, truncated: false, reason };
}

function writeSse(response: ServerResponse, event: RunStreamEvent, sequence?: number): void {
  if (!response.destroyed && !response.writableEnded) {
    if (sequence !== undefined) response.write(`id: ${sequence}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function workspaceFileFingerprint(file: WorkspaceFile): string {
  return `${file.size}:${file.modifiedAt}`;
}

export async function emitWorkspaceChanges(options: {
  emit: (event: RunStreamEvent) => void | Promise<void>;
  previous: Map<string, string>;
  sessionId: string;
  store: SessionStore;
}): Promise<Map<string, string>> {
  const files = await listWorkspaceFiles(options.store, options.sessionId);
  const next = new Map(files.map((file) => [file.path, workspaceFileFingerprint(file)]));
  const changedPaths = files
    .filter((file) => options.previous.get(file.path) !== next.get(file.path))
    .map((file) => file.path);
  for (const path of options.previous.keys()) {
    if (!next.has(path) && !changedPaths.includes(path)) changedPaths.push(path);
  }
  if (!changedPaths.length && options.previous.size === next.size) return next;
  // Subagent handoff writes land in the session workspace too; a refresh that only sees those
  // internal paths must stay silent so the user-facing workspace view does not react to them.
  if (!changedPaths.length || changedPaths.some((path) => !isSubagentPrivateWorkspacePath(path))) {
    await options.emit({ changedPaths, files, type: "workspace.changed" });
  }
  const artifacts = options.store.listArtifacts(options.sessionId);
  for (const path of changedPaths) {
    const artifact = artifacts.find((item) => item.logicalName === path);
    if (!artifact) continue;
    const version = options.store.listArtifactVersions(options.sessionId, artifact.id).at(-1);
    await options.emit({
      artifact,
      type: "artifact.upserted",
      ...(version ? { version } : {}),
    });
  }
  return next;
}

/**
 * Strip a trailing ``#vN`` version suffix some models append to the artifact_id
 * in ``cites_artifact_aliases`` (e.g. ``"67c0ce25-…#v1"``). The schema splits
 * the two — ``cites_artifact_aliases`` carries the bare UUID, ``cites_artifact_versions``
 * carries the int — but a model may collapse them into one string. Returns the
 * bare id and, when a ``#vN`` suffix is present, the version it encoded (so the
 * explicit version the LLM intended survives rather than falling back to latest).
 * A bare UUID with no suffix returns ``version: undefined``.
 */
export function splitArtifactVersionSuffix(raw: string): { id: string; version: number | undefined } {
  const match = /^(.*)#v(\d+)$/i.exec(raw);
  if (match) {
    const id = match[1]!;
    const version = Number.parseInt(match[2]!, 10);
    return Number.isFinite(version) ? { id, version } : { id: raw, version: undefined };
  }
  return { id: raw, version: undefined };
}

async function executeAgentRun(
  store: SessionStore,
  runnerClient: RunnerClient,
  provenanceRecorder: ProvenanceRecorder,
  mcpBroker: McpGovernanceBroker,
  webBroker: WebBroker,
  mcpRegistry: ReturnType<typeof createBuiltinMcpSourceRegistry>,
  mcpCatalog: McpSourceCatalog,
  artifactManager: ArtifactManager,
  paperService: PaperService,
  remoteCompute: RemoteComputeClient,
  skillCatalog: SkillCatalog,
  memoryGraphSink: MemoryGraphSink,
  sessionId: string,
  runId: string,
  body: SendMessageRequest,
  requestAbortController: AbortController,
  settingsSnapshot: EffectiveRuntimeSettings,
  emit: RunEventSink,
  serverConfig: ServerConfig,
  memoryGraphClient: MemoryGraphClient | null,
): Promise<SessionRunStatus> {
  if (activeSessions.has(sessionId)) {
    throw new ApiStatusError(409, "A run is already active for this session");
  }
  if (!body.content?.trim()) {
    throw new ApiStatusError(400, "Message content is required");
  }
  let runnerHealth: RunnerHealth;
  try {
    runnerHealth = await runnerClient.health();
  } catch (error) {
    throw new ApiStatusError(503, error instanceof Error ? error.message : "Runner is unavailable");
  }
  const session = store.getSession(sessionId);
  if (!session) {
    throw new ApiStatusError(404, "Session not found");
  }
  if (session.archivedAt) {
    throw new ApiStatusError(409, "Session is archived and read-only");
  }
  const sessionSpecialist = store.getSpecialist(session.specialistId);
  const enabledBuiltinSpecialists = store
    .listSpecialists()
    .filter((specialist) => specialist.builtIn && specialist.enabled !== false);
  const remoteHosts = store.listRemoteHosts().filter((host) => host.status === "ready");
  const selectedModel = store.getModel(settingsSnapshot.modelId);
  const initialPermissionEpoch = store.getSessionPermissionEpoch(sessionId);
  if (!selectedModel) {
    throw new ApiStatusError(400, "The session model is not available");
  }
  if (!initialPermissionEpoch) {
    throw new ApiStatusError(500, "The session Permission Epoch is not available");
  }
  const apiToken = store.getModelApiToken(selectedModel.id);
  if (!apiToken) {
    throw new ApiStatusError(400, "The selected model does not have a saved API token");
  }
  if (cancelledRuns.has(runId) || requestAbortController.signal.aborted) {
    await emit({ reason: "Run cancelled", runId, type: "run.cancelled" });
    activeRunAbortControllers.delete(runId);
    return "cancelled";
  }

  const previousMessages = await store.readMessages(sessionId);
  let composerReferences: ComposerReference[];
  try {
    composerReferences = await resolveComposerReferences(body.references, sessionId, store, skillCatalog);
  } catch (error) {
    throw new ApiStatusError(400, error instanceof Error ? error.message : "Composer references are invalid");
  }
  let activeSkills: RuntimeSkillSnapshot[];
  try {
    // `/` attachments must stay inside the Session's effective skill set: in
    // `selected` mode a skill outside the whitelist is not usable at all.
    const effectiveSkillIds = new Set(settingsSnapshot.enabledSkillIds);
    const blockedSkillIds = composerReferences
      .filter((reference) => reference.kind === "skill" && !effectiveSkillIds.has(reference.id))
      .map((reference) => reference.id);
    if (blockedSkillIds.length) {
      throw new Error(`These skills are not enabled for this Session: ${blockedSkillIds.join(", ")}`);
    }
    activeSkills = skillCatalog.resolve([...effectiveSkillIds]);
  } catch (error) {
    throw new ApiStatusError(400, error instanceof Error ? error.message : "The selected skills are not available");
  }
  const runtimeSkills = activeSkills.map(({ content, description, hash, id, readResource, resources, revision, version }) => ({
    content,
    description,
    hash,
    id,
    readResource,
    resources,
    revision,
    version,
  }));
  let scientificEnvironments: Environment[] | undefined;
  if (runnerHealth.scientificEnvs?.available) {
    await syncScientificEnvironmentCatalog(store, runnerClient, provenanceRecorder);
    scientificEnvironments = store.listEnvironments();
  }
  const systemPrompt = buildWorkspaceSystemPrompt(
    runtimeSkills,
    Boolean(scientificEnvironments),
    {
      approvalMode: session.approvalMode,
      memoryGraphEnabled: memoryGraphSink.enabled,
      remoteHosts,
      ...(sessionSpecialist ? { specialist: { description: sessionSpecialist.description, instructions: sessionSpecialist.instructions, name: sessionSpecialist.name } } : {}),
      ...(enabledBuiltinSpecialists.length
        ? { builtinSpecialists: enabledBuiltinSpecialists.map((specialist) => ({ description: specialist.description, name: specialist.name })) }
        : {}),
      subagentOrchestration: true,
    },
  );
  const runStartedAt = new Date().toISOString();
  const assertRunActive = () => {
    if (cancelledRuns.has(runId) || requestAbortController.signal.aborted) {
      throw new Error("Agent run cancelled");
    }
  };
  const timeoutSettings = store.getTimeoutSettings();
  const quotaSettings = store.getQuotaSettings();
  const userMessage = await store.appendMessage(sessionId, "user", body.content.trim(), undefined, composerReferences, body.annotationIds);
  if (await store.getSessionRun(sessionId, runId)) await store.updateSessionRun(sessionId, runId, { userMessageId: userMessage.id });
  // On a session's first user message, mirror a one-goal-per-session
  // ResearchGoal (domain inferred from message keywords). Never blocks the
  // caller; a disabled/unreachable graph is a no-op.
  if (previousMessages.length === 0) {
    memoryGraphSink.observeSessionFirstMessage({
      sessionId,
      goalId: `goal:session:${sessionId}`,
      coreObjective: body.content.trim(),
      domain: inferDomain(body.content.trim()),
      topicScope: [],
      createdAt: userMessage.createdAt,
    });
  }
  const promptHistory = previousMessages.map((message) => ({ ...message, content: messagePromptContent(message) }));
  const pendingManualNotice = previousMessages.at(-1)?.kind === "review_notice" ? previousMessages.at(-1) : undefined;
  const promptUserMessage = {
    ...userMessage,
    content: [
      messagePromptContent(userMessage),
      ...(pendingManualNotice ? [
        "A manual Reviewer notice is pending. Address its findings in this response by correcting the work or explaining why a finding does not apply, with record evidence.",
        pendingManualNotice.content,
      ] : []),
    ].join("\n\n"),
  };
  const promptMessages = [...promptHistory, promptUserMessage];
  if (cancelledRuns.has(runId) || requestAbortController.signal.aborted) {
    await emit({ reason: "Run cancelled", runId, type: "run.cancelled" });
    activeRunAbortControllers.delete(runId);
    return "cancelled";
  }
  activeSessions.set(sessionId, {
    lastActivityAt: runStartedAt,
    projectId: session.projectId,
    runId,
    sessionId,
    startedAt: runStartedAt,
    status: "running",
    title: session.title,
  });

  await emit({
    model: { id: selectedModel.id, model: selectedModel.model, name: selectedModel.name },
    runId,
    settings: settingsSnapshot,
    type: "run.started",
  });
  if (cancelledRuns.has(runId) || requestAbortController.signal.aborted) {
    await emit({ reason: "Run cancelled", runId, type: "run.cancelled" });
    if (activeSessions.get(sessionId)?.runId === runId) activeSessions.delete(sessionId);
    activeRunAbortControllers.delete(runId);
    return "cancelled";
  }
  const traces = new Map<string, ToolTrace>();
  // Chip references + claim ids accumulated during this run by the declare
  // tools (alias → graph node; claim id → states edge). Each entry is tagged
  // with the execution context (turnId) that produced it: the leader run tags
  // with ``runId``; a subagent run tags with its child execution id. Drained
  // onto a report Artifact version when the LLM writes one — but only the
  // entries whose turnId matches the declaring context, so a subagent's claims
  // are not absorbed by a report the leader declares (and vice versa). Deduped
  // by (id, version, label) so a claim cited N times does not push N copies.
  const chipMapBuffer: Array<{ turnId: string; reference: ComposerReference }> = [];
  const claimIds: Array<{ turnId: string; claimId: string }> = [];
  const referenceKey = (reference: ComposerReference): string =>
    `${reference.id}#${reference.version ?? ""}#${reference.label}`;
  const pushChipReference = (turnId: string, reference: ComposerReference): void => {
    // Dedup within the buffer: the same alias→node from multiple declare_claim
    // calls in one context should land once on the report, not N times.
    const key = `${turnId}#${referenceKey(reference)}`;
    if (chipMapBuffer.some((entry) => `${entry.turnId}#${referenceKey(entry.reference)}` === key)) return;
    chipMapBuffer.push({ turnId, reference });
  };
  const pushClaimId = (turnId: string, claimId: string): void => {
    const key = `${turnId}#${claimId}`;
    if (claimIds.some((entry) => `${entry.turnId}#${entry.claimId}` === key)) return;
    claimIds.push({ turnId, claimId });
  };
  // Per-run drain closure: returns + clears only the entries tagged with this
  // turnId, leaving other execution contexts buffered for a later report in
  // that context. Without a turnId (legacy callers / non-contextual drain),
  // drain everything to preserve prior behavior. Passed per-call into
  // declareWorkspaceArtifact so concurrent runs in one process never overwrite
  // each other's accumulator (the prior singleton instance field was stomped
  // by whichever run called setReferencesProvider last).
  const drainReferences = (turnId?: string): { references: ComposerReference[]; claimIds: string[] } => {
    const drainAll = turnId === undefined;
    const matching = (entry: { turnId: string }): boolean => drainAll || entry.turnId === turnId;
    const references = chipMapBuffer.filter(matching).map((entry) => entry.reference);
    const claimIdsDrained = claimIds.filter(matching).map((entry) => entry.claimId);
    // Keep only the entries that did NOT match; rebuild so the index access is
    // well-typed under noUncheckedIndexedAccess (splice-by-index widens to
    // ``T | undefined``).
    const keepRefs = chipMapBuffer.filter((entry) => !matching(entry));
    const keepClaims = claimIds.filter((entry) => !matching(entry));
    chipMapBuffer.length = 0;
    chipMapBuffer.push(...keepRefs);
    claimIds.length = 0;
    claimIds.push(...keepClaims);
    return { references, claimIds: claimIdsDrained };
  };
  let assistantText = "";
  let workspaceSnapshot = new Map<string, string>();
  let workspaceRefreshQueue = Promise.resolve();
  const flushWorkspaceRefresh = async () => {
    await workspaceRefreshQueue;
  };
  let promptManifest: PromptManifest | undefined;
  const taskInvocationId = randomUUID();
  let lastAgentUsage = unreportedModelUsage();
  let turnNumber = 0;
  const observedTimeouts = new Map<string, { kind: TimeoutKind; reason: string; timeoutMs: number }>();
  const persistedTimeouts = new Set<string>();
  const rememberTimeout = (timeout: { kind: TimeoutKind; reason: string; timeoutMs: number } | undefined) => {
    if (timeout) observedTimeouts.set(`${timeout.kind}:${timeout.timeoutMs}:${timeout.reason}`, timeout);
  };
  const persistObservedTimeouts = async () => {
    for (const [key, timeout] of observedTimeouts) {
      if (persistedTimeouts.has(key)) continue;
      await store.appendTimeoutMessage(sessionId, timeoutMessage(timeout), timeout, selectedModel);
      persistedTimeouts.add(key);
    }
  };

  const agentConfig: AgentConfig = {
    apiToken,
    baseUrl: selectedModel.baseUrl,
    dataDir: store.dataDir,
    model: selectedModel.model,
    // Resolve the profile's proxy policy up front so a broken policy fails
    // the run start with a diagnosable message instead of a hung request.
    // The Gateway receives the one effective URL/direct decision instead of
    // independently re-reading a potentially contradictory environment.
    proxy: resolveProxyForUrl(store.resolveProxy(selectedModel.proxyPolicy), selectedModel.baseUrl),
  };
  const responseSink = {
    emit: (event: RunStreamEvent) => {
      void emit(event);
    },
  };
  let mainExecution: ReturnType<typeof runMainRequestExecution> | undefined;
  const externalWaitByExecution = new Map<string, () => () => void>();
  const permissionRuntime = createAgentPermissionRuntime(initialPermissionEpoch, {
    beginExternalWait: (executionId) => {
      const begin = executionId ? externalWaitByExecution.get(executionId) : undefined;
      if (begin) return begin();
      if (!mainExecution) throw new Error("No main AgentRun is active");
      return mainExecution.beginExternalWait();
    },
    emitRequired: (permissionRequest) => {
      responseSink.emit({ request: permissionRequest, type: "permission.required" });
    },
    readEpoch: () => store.getSessionPermissionEpoch(sessionId),
    readAuthorization: (authorizationId) => store.getPermissionAuthorization(authorizationId),
    requestPermission: (action, resource, summary, context) =>
      store.requestPermission(sessionId, action, resource, summary, context),
    waitForDecision: (permissionRequest, signal) =>
      waitForPermissionDecision(
        store,
        permissionRequest,
        timeoutSettings.permissionWaitTimeoutMs,
        signal,
        { emit, runId, sessionId },
      ),
  });
  const requestExecution = createRequestExecutionContext({
    abortSignal: requestAbortController.signal,
    identity: { executionId: runId, ownerSessionId: sessionId },
    permission: permissionRuntime,
    responseSink,
  });
  const reviewerSpecialistSettings = store.getReviewerSpecialistSettings();
  let activeSubagentCalls = 0;
  let launchedSubagentCalls = 0;
  const reserveSubagentSlot = (description: string): (() => void) => {
    if (activeSubagentCalls >= DEFAULT_MAX_CONCURRENT_SUBAGENTS) {
      throw new Error(
        `Subagent concurrency limit reached: at most ${DEFAULT_MAX_CONCURRENT_SUBAGENTS} task calls may run at once. `
        + `The rejected task was "${description}". Wait for the current batch to finish before launching another batch.`,
      );
    }
    if (launchedSubagentCalls >= DEFAULT_MAX_TOTAL_SUBAGENTS) {
      throw new Error(
        `Subagent total limit reached: at most ${DEFAULT_MAX_TOTAL_SUBAGENTS} task calls may be launched for this run. `
        + `The rejected task was "${description}". Synthesize existing results or continue directly.`,
      );
    }
    activeSubagentCalls += 1;
    launchedSubagentCalls += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeSubagentCalls = Math.max(0, activeSubagentCalls - 1);
    };
  };
  const createArtifactBindings = (
    workspaceRoot: string,
    turnId: string,
    sourcePathPrefix?: string,
  ): Pick<WorkspaceAgentOptions, "declareArtifact" | "listArtifacts" | "readArtifact"> => ({
    declareArtifact: async (input) => {
      const defaultName = normalizeWorkspaceRelativePath(workspaceRoot, input.path);
      const sourcePath = sourcePathPrefix ? `${sourcePathPrefix}/${input.path}` : input.path;
      const result = await provenanceRecorder.declareWorkspaceArtifact({
        ...(input.description ? { description: input.description } : {}),
        name: input.name?.trim() || defaultName,
        path: input.path,
        referencesProvider: drainReferences,
        sessionId,
        sourcePath,
        turnId,
        workspaceRoot,
      });
      await emit({ artifact: result.artifact, type: "artifact.upserted", version: result.version });
      // Reconcile [alias] tokens written in the report body against the chip
      // references drained onto this version. A token in the body with no
      // matching reference means a declare_claim ran without the alias in its
      // cites_evidence_aliases/cites_artifact_aliases — that chip will render
      // as plain text. Log it so the failure is diagnosable from the run log,
      // and (for report kinds) inject an instruction telling the LLM to
      // re-declare the missing aliases + re-declare the output.
      const kind = result.artifact.kind;
      const isReportKind = kind === "markdown" || kind === "latex" || kind === "report";
      if (isReportKind) {
        const refLabels = new Set((result.version.references ?? []).map((reference) => reference.label));
        let bodyLabels: Set<string> | null = null;
        try {
          const bodyPath = join(workspaceRoot, input.path);
          const body = await readFile(bodyPath, "utf8");
          bodyLabels = new Set(Array.from(body.matchAll(/\[(evidence|artifact)\d+\]/g)).map((match) => match[0].slice(1, -1)));
        } catch {
          // Body unreadable (path moved/deleted/non-text) — skip reconciliation;
          // never block the declare on a read failure.
        }
        if (bodyLabels) {
          const orphan = Array.from(bodyLabels).filter((label) => !refLabels.has(label));
          if (orphan.length) {
            result.instruction =
              `The report body contains ${orphan.map((label) => `[${label}]`).join(", ")} tokens that have no matching entry in any declare_claim's cites_evidence_aliases/cites_artifact_aliases, so they will render as plain text instead of clickable chips. To fix: for each missing artifact alias, call list_artifacts to resolve its artifact_id (or reuse the id an earlier declare_artifact returned), then call declare_claim again passing cites_artifact_aliases={"artifactN": "<artifact_id>"} for each; for a missing evidence alias, pass cites_evidence_aliases={"evidenceN": "<evidence_id>"}. Then call declare_artifact(output) again so the new chip references drain onto a fresh version. Never write a [alias] token in the body without a matching key in the same declare_claim's alias params.`;
          }
        }
      }
      return result;
    },
    listArtifacts: async () => store.listProjectArtifacts(session.projectId),
    readArtifact: async (input) => {
      const artifact = input.artifactId
        ? store.getProjectArtifact(session.projectId, input.artifactId)
        : input.name ? store.getArtifactByName(sessionId, input.name) : undefined;
      if (!artifact) throw new Error("Artifact not found in this Project");
      const versions = store.listProjectArtifactVersions(session.projectId, artifact.id);
      const version = input.version === undefined
        ? versions.at(-1)
        : versions.find((candidate) => candidate.version === input.version);
      if (!version) throw new Error("Artifact version not found");
      const bytes = await provenanceRecorder.cas.read(version.content.hash);
      const limit = 1_000_000;
      const body = bytes.subarray(0, limit);
      const textMedia = version.mediaType.startsWith("text/")
        || /(?:json|javascript|xml|x-ipynb|x-tex)/.test(version.mediaType);
      return {
        artifact,
        content: textMedia ? body.toString("utf8") : body.toString("base64"),
        encoding: textMedia ? "utf8" as const : "base64" as const,
        truncated: bytes.length > limit,
        version,
      };
    },
  });
  const agentOptions: WorkspaceAgentOptions = {
    config: agentConfig,
    enabledConnectorIds: settingsSnapshot.enabledConnectorIds,
    memoryGraphEnabled: memoryGraphSink.enabled,
    ...createArtifactBindings(store.workspacePath(sessionId), runId),
    ...(scientificEnvironments ? { environments: scientificEnvironments } : {}),
    ...createWorkspaceExecutionBindings({
      agentId: "main",
      executionId: runId,
      executionTimeoutMs: timeoutSettings.runnerExecTimeoutMs,
      kernelIdleTimeoutMs: timeoutSettings.kernelIdleTimeoutMs,
      maxOutputBytes: quotaSettings.runnerMaxOutputBytes,
      maxWorkspaceBytes: quotaSettings.runnerMaxWorkspaceBytes,
      npuBrokerEnabled: runnerHealth.npuBroker.enabled,
      permission: requestExecution.permission,
      permissionScopeLabel: "in the Session workspace",
      provenanceRecorder,
      runnerClient,
      ...(scientificEnvironments ? { scientificEnvironments } : {}),
      sessionId,
      store,
      workspaceRoot: store.workspacePath(sessionId),
    }),
    ...createMcpWorkspaceTools({
      artifactManager,
      broker: mcpBroker,
      catalog: mcpCatalog,
      enabledSourceIds: settingsSnapshot.enabledConnectorIds,
      emitPermissionRequest: (permissionRequest) => {
        responseSink.emit({ request: permissionRequest, type: "permission.required" });
      },
      pauseExternalWait: () => {
        if (!mainExecution) throw new Error("No main AgentRun is active");
        return mainExecution.beginExternalWait();
      },
      paperService,
      permission: requestExecution.permission,
      projectId: session.projectId,
      registry: mcpRegistry,
      sessionId,
      store,
      turnId: runId,
    }),
    ...createWebWorkspaceTools({
      broker: webBroker,
      context: {
        forceRefresh: body.webForceRefresh === true,
        projectId: session.projectId,
        sessionId,
        turnId: runId,
      },
      permission: requestExecution.permission,
    }),
    approvalMode: session.approvalMode,
    remoteHosts,
    proposePlan: async (input) => {
      const plan = await store.proposeSessionPlan(sessionId, input);
      await emit({ plan, type: "plan.proposed" });
      // Let plan.scope correct the goal's fallback domain (steps are not
      // mirrored into SubTask nodes — the framework doesn't advance step
      // status, so a skeleton would stay PENDING and clutter the graph).
      // Never blocks; plan flow stays unblocked on a down graph.
      memoryGraphSink.observeSessionPlan({
        sessionId,
        goalId: `goal:session:${sessionId}`,
        planId: plan.id,
        scope: plan.scope,
        domain: inferDomain(plan.scope),
        steps: plan.steps.map((step) => ({ id: step.id, description: step.description })),
      });
      return plan;
    },
    queryGraph: async (query: string) => {
      // Degraded when the toggle is off or the sidecar is unreachable —
      // matches getSubgraph's contract so the agent loop never breaks.
      if (!memoryGraphClient || !memoryGraphSink.enabled) {
        return { hits: [], total: 0, truncated: false, reason: "memory_graph_disabled" };
      }
      // Scope the read to this session so the LLM only sees its own nodes when
      // resolving ids to cite; cross-session search stays on the user-facing
      // search box (which sends no session filter).
      return memoryGraphClient.queryMatch(query, sessionId);
    },
    declareEvidence: async (input) => {
      if (!memoryGraphClient || !memoryGraphSink.enabled) {
        return { status: "error", code: "memory_graph_disabled", message: "memory graph not available" };
      }
      // The Evidence is registered as a chip only when a subsequent
      // declare_claim cites it via an alias (the claim's chip_map carries the
      // alias → evidence_id mapping); declare_evidence itself has no alias to
      // register, so it does not push to chipMapBuffer here.
      return memoryGraphClient.declareEvidence(input, sessionId);
    },
    declareClaim: async (input) => {
      if (!memoryGraphClient || !memoryGraphSink.enabled) {
        return { status: "error", code: "memory_graph_disabled", message: "memory graph not available" };
      }
      const citesArtifactVersions: Record<string, number> = {};
      const citesArtifactAliases: Record<string, string> = {};
      for (const [alias, rawArtifactId] of Object.entries(input.citesArtifactAliases)) {
        // Some models collapse the artifact_id and version into one string
        // ("uuid#v1"). Split the suffix so the bare id is used to look up the
        // version and reaches the sidecar's composite-key MATCH (which keys
        // on a bare artifact_id), and so the version the LLM intended is
        // honored instead of silently falling back to latest.
        const { id: artifactId, version: suffixVersion } = splitArtifactVersionSuffix(rawArtifactId);
        citesArtifactAliases[alias] = artifactId;
        try {
          const latest = store.listArtifactVersions(sessionId, artifactId).at(-1);
          if (latest) {
            // Prefer the explicit version the model encoded; fall back to the
            // store's latest when the model passed a bare id or an out-of-range
            // version, so the cite still pins a real version node.
            const resolved = suffixVersion != null && suffixVersion >= 1 && suffixVersion <= latest.version
              ? suffixVersion
              : latest.version;
            citesArtifactVersions[alias] = resolved;
          } else if (suffixVersion != null) {
            citesArtifactVersions[alias] = suffixVersion;
          }
        } catch (error) {
          console.debug(
            "declareClaim: could not resolve version for alias=%s artifact=%s: %s",
            alias,
            artifactId,
            error instanceof Error ? error.message : String(error),
          );
          if (suffixVersion != null) citesArtifactVersions[alias] = suffixVersion;
        }
      }
      const result = await memoryGraphClient.declareClaim(
        { ...input, citesArtifactAliases, citesArtifactVersions },
        sessionId,
      );
      if (result.status === "ok") {
        // The cited nodes are registered with the alias the LLM chose as the
        // label, so the report's [alias] tokens match these entries and render
        // as clickable chips. The claim_id is held separately so the report
        // version links to its claims via ``states`` edges once the report
        // version lands later this run (provenance recorder drains both the
        // references and the claim ids onto the report version then, because
        // declare_claim runs in an earlier turn than the report-write run).
        // Tagged with this run's id so the report this leader declares drains
        // only the leader's claims, not a subagent's.
        for (const [alias, entry] of Object.entries(result.chipMap)) {
          pushChipReference(
            runId,
            entry.version != null
              ? { id: entry.id, kind: entry.kind, label: alias, version: entry.version }
              : { id: entry.id, kind: entry.kind, label: alias },
          );
        }
        pushClaimId(runId, result.claimId);
      }
      return result;
    },
    ...(reviewerSpecialistAvailable(reviewerSpecialistSettings.enabled, body.content)
      && reviewerSpecialistSupportsLevel(reviewerSpecialistSettings.level, "quick") ? {
      reviewCheckpoint: async (input, signal, toolCallId) => {
        const checkpointToolCallId = toolCallId ?? randomUUID();
        const checkpointMessageId = checkpointToolCallId;
        const publishCheckpoint = async (message: ChatMessage): Promise<void> => {
          await emit({ message, type: "reviewer_checkpoint.updated" });
        };
        const initialCheckpoint = await store.appendReviewerCheckpointMessage(
          sessionId,
          checkpointMessageId,
          checkpointToolCallId,
        );
        await publishCheckpoint(initialCheckpoint);
        const reviewerMcpTools = createMcpWorkspaceTools({
          artifactManager,
          broker: mcpBroker,
          catalog: mcpCatalog,
          enabledSourceIds: settingsSnapshot.enabledConnectorIds,
          emitPermissionRequest: (permissionRequest) => {
            responseSink.emit({ request: permissionRequest, type: "permission.required" });
          },
          pauseExternalWait: () => () => undefined,
          paperService,
          permission: requestExecution.permission,
          projectId: session.projectId,
          registry: mcpRegistry,
          sessionId,
          store,
          suppressMemoryGraphMirror: true,
          turnId: toolCallId ?? runId,
        });
        const semanticReview = reviewerSpecialistSupportsLevel(reviewerSpecialistSettings.level, "deep")
          ? createReviewAgentOptions({
              modelIdentity: `${selectedModel.id}:${selectedModel.model}`,
              runIdleTimeoutMs: timeoutSettings.gatewayIdleTimeoutMs,
              skills: skillCatalog.resolve(["citation-reviewer", "computation-reviewer", "literature-searcher"]),
              workspace: { ...agentOptions, mcpTools: reviewerMcpTools.mcpTools },
            })
          : undefined;
        try {
          const result = await runReviewerCheckpoint({
            artifactVersionIds: input.artifactVersionIds,
            cas: provenanceRecorder.cas,
            parentRunId: runId,
            reason: input.reason,
            reviewLevel: reviewerSpecialistSettings.level,
            sessionId,
            signal,
            store,
            toolCallId: checkpointToolCallId,
            ...(memoryGraphClient && memoryGraphSink.enabled ? {
              traceEvidenceReference: createEvidenceReferenceTracer(memoryGraphClient, sessionId, () => memoryGraphSink.enabled),
              traceArtifactProvenance: async (reference, traceSignal) => {
                if (traceSignal?.aborted) throw new DOMException("Review cancelled", "AbortError");
                return memoryGraphClient.traceProvenance({ nodeId: reference.artifactId }, sessionId);
              },
            } : {}),
            onProgress: async (progress) => {
              const message = await store.updateReviewerCheckpointProgress(sessionId, checkpointMessageId, progress);
              await publishCheckpoint(message);
            },
            onArtifactCompleted: async (completedReviews) => {
              const message = await store.updateReviewerCheckpointMessage(sessionId, checkpointMessageId, {
                content: reviewerCheckpointPromptContent(completedReviews, undefined, true),
                status: "running",
              });
              await publishCheckpoint(message);
            },
            ...(semanticReview ? { semanticReview } : {}),
          });
          const completedCheckpoint = await store.updateReviewerCheckpointMessage(sessionId, checkpointMessageId, {
            content: reviewerCheckpointPromptContent(result.reviews),
            status: "completed",
          });
          await publishCheckpoint(completedCheckpoint);
          for (const review of result.reviews) await emit({ review, type: "artifact_review.completed" });
          return result;
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Reviewer Specialist failed";
          const failedCheckpoint = await store.updateReviewerCheckpointMessage(sessionId, checkpointMessageId, {
            content: reviewerCheckpointPromptContent([], detail), error: detail, status: "failed",
          });
          await publishCheckpoint(failedCheckpoint);
          throw error;
        }
      },
    } : {}),
    ...(remoteHosts.length ? {
      proposeRemoteJob: async (input: CreateRemoteJobRequest) => {
        let job = await store.createRemoteJob(sessionId, input, { executionId: runId });
        job = await startApprovedRemoteJob(job, store, remoteCompute, provenanceRecorder);
        await emit({ job, type: "remote_job.proposed" });
        return job;
      },
    } : {}),
    runSubagent: async (input: SubagentInput, signal?: AbortSignal): Promise<Subagent> => {
      store.assertSessionWritable(sessionId);
      const subagentConfig = resolveSubagentConfig(input);
      const specialist = resolveSubagentSpecialist(store, session.specialistId, input);
      const subagentInput: SubagentInput = specialist && input.specialistId?.trim() !== specialist.id
        ? { ...input, specialistId: specialist.id }
        : input;
      const releaseSubagentSlot = reserveSubagentSlot(subagentInput.description);
      try {
        let subagent = await store.createSubagent(sessionId, runId, subagentInput, {
          maxTurns: subagentConfig.maxTurns,
          model: { id: selectedModel.id, model: selectedModel.model, name: selectedModel.name },
          timeoutSeconds: subagentConfig.timeoutSeconds,
        });
        await emit({ subagent, type: "subagent.updated" });
        const steps: SubagentStep[] = [...subagent.steps];
        let handoff: NonNullable<Subagent["handoff"]> | undefined;
        const releaseParentWait = mainExecution?.beginExternalWait();
        let assistantOutput = "";
        let activeMessageStep: { id: string; kind: Extract<SubagentStep["kind"], "assistant" | "thinking"> } | undefined;
        let progressFlushFailure: unknown;
        let progressFlushTimer: ReturnType<typeof setTimeout> | undefined;
        let progressFlushQueue = Promise.resolve();
        let maxTurnsExceeded = false;
        const enqueueProgressFlush = () => {
          const snapshot = structuredClone({ ...subagent, steps });
          progressFlushQueue = progressFlushQueue.then(async () => {
            if (progressFlushFailure) return;
            try {
              await store.updateSubagent(snapshot);
            } catch (error) {
              progressFlushFailure = error;
            }
          });
        };
        const scheduleProgressFlush = () => {
          if (progressFlushTimer) return;
          progressFlushTimer = setTimeout(() => {
            progressFlushTimer = undefined;
            enqueueProgressFlush();
          }, SUBAGENT_PROGRESS_FLUSH_MS);
        };
        const publishStep = (step: SubagentStep) => {
          const existing = steps.findIndex((candidate) => candidate.id === step.id);
          if (existing >= 0) steps[existing] = step;
          else steps.push(step);
          void emit({ step, subagentId: subagent.id, type: "subagent.step" });
          scheduleProgressFlush();
        };
        const publishMessageDelta = (
          kind: Extract<SubagentStep["kind"], "assistant" | "thinking">,
          delta: string,
        ) => {
          const activeStep = activeMessageStep?.kind === kind
            ? steps.find((step) => step.id === activeMessageStep?.id)
            : undefined;
          const step: SubagentStep = activeStep
            ? { ...activeStep, content: `${activeStep.content}${delta}` }
            : {
                content: delta,
                createdAt: new Date().toISOString(),
                id: randomUUID(),
                kind,
                status: "completed",
              };
          activeMessageStep = { id: step.id, kind };
          publishStep(step);
        };
        try {
          handoff = await prepareSubagentHandoff(store, sessionId, subagent.id, subagent.input);
          const handoffStep: SubagentStep = {
            content: `Private workspace: ${handoff.privateWorkspacePath}\nHandoff manifest: ${handoff.manifestPath}`,
            createdAt: new Date().toISOString(),
            id: randomUUID(),
            kind: "system",
            status: "completed",
          };
          steps.push(handoffStep);
          subagent = await store.updateSubagent({
            ...subagent,
            handoff,
            steps,
          });
          await emit({ subagent, type: "subagent.updated" });
          const roleSkillId = skillIdForSubagentType(skillCatalog, subagent.input.subagentType);
          const subagentSkillIds = [...new Set([
            ...settingsSnapshot.enabledSkillIds,
            ...(specialist?.enabledSkillIds ?? []),
            ...(roleSkillId ? [roleSkillId] : []),
          ])];
          const subagentSkills = skillCatalog.resolve(subagentSkillIds).map(({ content, description, hash, id, readResource, resources, revision, version }) => ({
            content, description, hash, id, readResource, resources, revision, version,
          }));
          const subagentConnectorIds = [...new Set([...settingsSnapshot.enabledConnectorIds, ...(specialist?.connectorIds ?? [])])];
          const subagentWorkspaceRoot = resolveWorkspaceFile(store.workspacePath(sessionId), handoff.privateWorkspacePath);
          const subagentProfile = createSubagentProfile({
            allowedToolNames: subagentConfig.tools ?? undefined,
            connectorIds: subagentConnectorIds,
            deniedToolNames: subagentConfig.disallowedTools,
            gatewayThreadId: subagent.id,
            maxModelTurns: subagentConfig.maxTurns,
            presetId: subagentConfig.name,
            runTimeoutMs: subagentConfig.timeoutSeconds * 1_000,
            skills: subagentSkills.map(({ id, revision, version }) => ({ id, revision, version })),
            ...(specialist ? { specialistId: specialist.id } : {}),
            workspaceRoot: subagentWorkspaceRoot,
          });
          const childExecution = createRequestExecutionContext({
            abortSignal: signal ?? requestExecution.abortSignal,
            identity: {
              executionId: subagent.id,
              ownerSessionId: sessionId,
              parentExecutionId: requestExecution.identity.executionId,
            },
            permission: requestExecution.permission,
            responseSink: requestExecution.responseSink,
          });
          let subagentRunHandle: ReturnType<typeof runSubagentTask> | undefined;
          const subagentWorkspace: WorkspaceAgentOptions = {
            config: agentConfig,
            enabledConnectorIds: subagentConnectorIds,
            ...(scientificEnvironments ? { environments: scientificEnvironments } : {}),
            ...createArtifactBindings(subagentWorkspaceRoot, childExecution.identity.executionId, handoff.privateWorkspacePath),
            ...createWorkspaceExecutionBindings({
              agentId: `subagent:${subagent.id}`,
              executionId: childExecution.identity.executionId,
              executionTimeoutMs: timeoutSettings.runnerExecTimeoutMs,
              kernelIdleTimeoutMs: timeoutSettings.kernelIdleTimeoutMs,
              maxOutputBytes: quotaSettings.runnerMaxOutputBytes,
              maxWorkspaceBytes: quotaSettings.runnerMaxWorkspaceBytes,
              npuBrokerEnabled: runnerHealth.npuBroker.enabled,
              permission: childExecution.permission,
              permissionScopeLabel: `in subagent ${subagent.id}`,
              artifactPathPrefix: handoff.privateWorkspacePath,
              provenanceRecorder,
              readOnlyWorkspaceRoot: store.workspacePath(sessionId),
              runnerClient,
              ...(scientificEnvironments ? { scientificEnvironments } : {}),
              sessionId,
              store,
              workspaceRoot: subagentWorkspaceRoot,
            }),
            ...createMcpWorkspaceTools({
              artifactManager,
              broker: mcpBroker,
              catalog: mcpCatalog,
              enabledSourceIds: subagentConnectorIds,
              emitPermissionRequest: (permissionRequest) => {
                responseSink.emit({ request: permissionRequest, type: "permission.required" });
              },
              pauseExternalWait: () => {
                if (!subagentRunHandle) throw new Error("No subagent AgentRun is active");
                return subagentRunHandle.beginExternalWait();
              },
              paperService,
              permission: childExecution.permission,
              projectId: session.projectId,
              registry: mcpRegistry,
              sessionId,
              store,
              turnId: childExecution.identity.executionId,
              workspacePathPrefix: handoff.privateWorkspacePath,
            }),
            ...createWebWorkspaceTools({
              broker: webBroker,
              context: {
                forceRefresh: body.webForceRefresh === true,
                projectId: session.projectId,
                sessionId,
                turnId: childExecution.identity.executionId,
              },
              permission: childExecution.permission,
            }),
            // report-writer citation chain (topology B): when a specialist
            // declares the report-writer role skill, inject the same four
            // graph callbacks + memoryGraphEnabled the leader gets above,
            // so the report-writer subagent can build Evidence/Claim nodes,
            // emit [alias] chips, and have them drained onto the report
            // Artifact version it writes. declare_claim pushes into the
            // shared run-scoped chipMapBuffer/claimIds (same closure as the
            // leader's declareClaim), which provenanceRecorder drains when
            // declare_artifact writes a markdown/latex/report version.
            // trace_provenance/review_checkpoint are reviewer-specialist tools
            // and are intentionally NOT injected here.
            // Gate on enabledSkillIds because the current specialist contract
            // has no capabilities field; upgrade once that field is available.
            ...((memoryGraphSink.enabled && specialist?.enabledSkillIds?.includes("report-writer"))
              ? {
                memoryGraphEnabled: true,
                queryGraph: async (query: string) => {
                  if (!memoryGraphClient || !memoryGraphSink.enabled) {
                    return { hits: [], total: 0, truncated: false, reason: "memory_graph_disabled" };
                  }
                  return memoryGraphClient.queryMatch(query, sessionId);
                },
                declareEvidence: async (input) => {
                  if (!memoryGraphClient || !memoryGraphSink.enabled) {
                    return { status: "error", code: "memory_graph_disabled", message: "memory graph not available" };
                  }
                  return memoryGraphClient.declareEvidence(input, sessionId);
                },
                declareClaim: async (input) => {
                  if (!memoryGraphClient || !memoryGraphSink.enabled) {
                    return { status: "error", code: "memory_graph_disabled", message: "memory graph not available" };
                  }
                  const citesArtifactVersions: Record<string, number> = {};
                  const citesArtifactAliases: Record<string, string> = {};
                  for (const [alias, rawArtifactId] of Object.entries(input.citesArtifactAliases)) {
                    const { id: artifactId, version: suffixVersion } = splitArtifactVersionSuffix(rawArtifactId);
                    citesArtifactAliases[alias] = artifactId;
                    try {
                      const latest = store.listArtifactVersions(sessionId, artifactId).at(-1);
                      if (latest) {
                        const resolved = suffixVersion != null && suffixVersion >= 1 && suffixVersion <= latest.version
                          ? suffixVersion
                          : latest.version;
                        citesArtifactVersions[alias] = resolved;
                      } else if (suffixVersion != null) {
                        citesArtifactVersions[alias] = suffixVersion;
                      }
                    } catch {
                      if (suffixVersion != null) citesArtifactVersions[alias] = suffixVersion;
                    }
                  }
                  const result = await memoryGraphClient.declareClaim(
                    { ...input, citesArtifactAliases, citesArtifactVersions },
                    sessionId,
                  );
                  if (result.status === "ok") {
                    for (const [alias, entry] of Object.entries(result.chipMap)) {
                      pushChipReference(
                        childExecution.identity.executionId,
                        entry.version != null
                          ? { id: entry.id, kind: entry.kind, label: alias, version: entry.version }
                          : { id: entry.id, kind: entry.kind, label: alias },
                      );
                    }
                    pushClaimId(childExecution.identity.executionId, result.claimId);
                  }
                  return result;
                },
              }
              : {}),
            remoteHosts: [],
            runSubagent: async () => {
              throw new Error("Nested subagents are disabled");
            },
            readOnlyWorkspaceRoot: store.workspacePath(sessionId),
            subagent: {
              instructions: subagentConfig.systemPrompt,
              name: subagentConfig.name,
            },
            skills: subagentSkills,
            ...(specialist ? { specialist: { description: specialist.description, instructions: specialist.instructions, name: specialist.name } } : {}),
            workspaceRoot: subagentWorkspaceRoot,
          };
          const observeSubagentEvent = (event: Parameters<NonNullable<import("../agent-run/create-agent-run.js").AgentRunBindings["observer"]>>[0]) => {
            if (event.type === "turn_start") {
              activeMessageStep = undefined;
              const nextTurn = subagent.turnCount + 1;
              if (nextTurn > subagentProfile.budget.maxModelTurns) {
                maxTurnsExceeded = true;
                subagentRunHandle?.abort();
                return;
              }
              subagent.turnCount = nextTurn;
              publishStep({
                content: `Turn ${subagent.turnCount} started`,
                createdAt: new Date().toISOString(),
                id: randomUUID(),
                kind: "system",
                status: "completed",
              });
            }
          if (event.type === "message_update") {
            const isText = event.assistantMessageEvent.type === "text_delta";
            publishMessageDelta(isText ? "assistant" : "thinking", event.assistantMessageEvent.delta);
          }
          if (event.type === "tool_execution_start") {
            activeMessageStep = undefined;
            const input = formatSubagentToolInput(event.args);
            publishStep({
              content: input,
              createdAt: new Date().toISOString(),
              id: event.toolCallId,
              input,
              kind: "tool",
              status: "running",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            });
          }
          if (event.type === "tool_execution_end") {
            activeMessageStep = undefined;
            const runningStep = steps.find((step) => step.id === event.toolCallId && step.kind === "tool");
            publishStep({
              content: aggregateToolText(event.result) ?? (event.isError ? "Tool failed" : "Tool completed"),
              createdAt: runningStep?.createdAt ?? new Date().toISOString(),
              id: event.toolCallId,
              ...(runningStep ? { input: runningStep.input ?? runningStep.content } : {}),
              kind: "tool",
              status: event.isError ? "failed" : "completed",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            });
          }
          if (event.type === "usage") {
            subagent.usage = event.usage;
            void emit({ subagentId: subagent.id, type: "subagent.usage", usage: event.usage });
            scheduleProgressFlush();
          }
        };
        const subagentExecutionPrompt = formatSubagentExecutionPrompt(subagent.input, handoff);
        subagentRunHandle = runSubagentTask({
          bindings: {
            abortSignal: childExecution.abortSignal,
            observer: observeSubagentEvent,
            runIdleTimeoutMs: timeoutSettings.gatewayIdleTimeoutMs,
            workspace: subagentWorkspace,
          },
          profile: subagentProfile,
          prompt: subagentExecutionPrompt,
          requestExecutionId: childExecution.identity.executionId,
          runContract: subagentExecutionPrompt,
        });
        externalWaitByExecution.set(
          childExecution.identity.executionId,
          () => subagentRunHandle!.beginExternalWait(),
        );
        await subagentRunHandle.execute();
        assistantOutput = steps
          .findLast((step) => step.kind === "assistant" && step.content.trim())
          ?.content.trim() ?? "";
        if (!assistantOutput) {
          publishStep({
            content: "Subagent completed without a text response.",
            createdAt: new Date().toISOString(),
            id: randomUUID(),
            kind: "assistant",
            status: "completed",
          });
        }
        subagent = {
          ...subagent,
          finishedAt: new Date().toISOString(),
          steps,
        };
        const validation = validateSubagentStructuredResult(subagent.input.brief, assistantOutput);
        subagent = {
          ...subagent,
          ...validation,
          status: validation.resultValidation?.status === "failed" ? "failed" : "completed",
        };
        if (subagent.resultValidation?.status === "failed") {
          subagent = {
            ...subagent,
            error: `Subagent result validation failed: ${subagent.resultValidation.errors.join("; ")}`,
          };
        }
        } catch (error) {
          rememberTimeout(timeoutFailure(error));
          const failure = classifySubagentFailure(error, {
            maxTurns: subagent.maxTurns,
            maxTurnsExceeded,
            parentAborted: signal?.aborted ?? false,
          });
          subagent = {
            ...subagent,
            error: failure.error,
            finishedAt: new Date().toISOString(),
            status: failure.status,
            steps,
          };
        } finally {
          releaseParentWait?.();
        }
        externalWaitByExecution.delete(subagent.id);
        for (const request of await store.cancelPendingPermissionRequests(subagent.id)) {
          await emit({ request, type: "permission.resolved" });
        }
        if (progressFlushTimer) {
          clearTimeout(progressFlushTimer);
          progressFlushTimer = undefined;
        }
        await progressFlushQueue;
        if (progressFlushFailure) {
          const message = progressFlushFailure instanceof Error ? progressFlushFailure.message : String(progressFlushFailure);
          subagent = {
            ...subagent,
            error: `Failed to persist subagent progress: ${message}`,
            finishedAt: new Date().toISOString(),
            status: "failed",
            steps,
          };
        }
        subagent = await store.updateSubagent(subagent);
        await emit({ subagent, type: "subagent.updated" });
        return subagent;
      } finally {
        releaseSubagentSlot();
      }
    },
    ...(sessionSpecialist ? { specialist: { description: sessionSpecialist.description, instructions: sessionSpecialist.instructions, name: sessionSpecialist.name } } : {}),
    history: promptHistory,
    skills: runtimeSkills,
    specialists: store.listSpecialists()
      .filter((specialist) => specialist.enabled !== false)
      .map((specialist) => ({
        builtIn: specialist.builtIn,
        connectorIds: specialist.connectorIds,
        description: specialist.description,
        enabledSkillIds: specialist.enabledSkillIds,
        id: specialist.id,
        name: specialist.name,
      })),
    workspaceRoot: store.workspacePath(sessionId),
  };
  const mainProfile = createMainAgentProfile({
    connectorIds: settingsSnapshot.enabledConnectorIds,
    gatewayThreadId: sessionId,
    runTimeoutMs: timeoutSettings.gatewayTurnTimeoutMs,
    skills: runtimeSkills.map(({ id, revision, version }) => ({ id, revision, version })),
    ...(sessionSpecialist ? { specialistId: sessionSpecialist.id } : {}),
    workspaceRoot: store.workspacePath(sessionId),
  });
  const observeMainEvent: NonNullable<import("../agent-run/create-agent-run.js").AgentRunBindings["observer"]> = (event) => {
    const active = activeSessions.get(sessionId);
    if (active) active.lastActivityAt = new Date().toISOString();
    if (event.type === "model_usage") {
      lastAgentUsage = capturedModelUsage(event);
      return;
    }
    if (event.type === "turn_start") {
      turnNumber += 1;
      void emit({ phase: "thinking", turn: turnNumber, type: "agent.phase" });
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
      void emit({
        delta: event.assistantMessageEvent.delta,
        turn: turnNumber,
        type: "assistant.thinking.delta",
      });
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      assistantText += event.assistantMessageEvent.delta;
      void emit({ delta: event.assistantMessageEvent.delta, type: "assistant.delta" });
    }
    if (event.type === "tool_execution_start") {
      const trace: ToolTrace = {
        ...(Object.keys(event.args).length ? { args: structuredClone(event.args) } : {}),
        id: event.toolCallId,
        name: event.toolName,
        status: "running",
      };
      traces.set(trace.id, trace);
      void emit({ trace, type: "tool.started" });
    }
    if (event.type === "tool_execution_end") {
      const text = aggregateToolText(event.result);
      if (event.isError) rememberTimeout(timeoutFailure(text));
      if (text !== undefined) {
        void emit({ chunk: text, toolCallId: event.toolCallId, type: "tool.output" });
      }
      const trace: ToolTrace = {
        id: event.toolCallId,
        name: event.toolName,
        ...(text !== undefined
          ? { outputChars: text.length, outputStream: toolOutputStreamId(event.toolCallId) }
          : {}),
        status: event.isError ? "failed" : "completed",
      };
      traces.set(trace.id, trace);
      void emit({ trace, type: "tool.completed" });
      workspaceRefreshQueue = workspaceRefreshQueue
        .then(() => emitWorkspaceChanges({
          emit,
          previous: workspaceSnapshot,
          sessionId,
          store,
        }))
        .then((next) => {
          workspaceSnapshot = next;
        })
        .catch(() => undefined);
    }
  };

  mainExecution = runMainRequestExecution({
    bindings: {
      abortSignal: requestExecution.abortSignal,
      observer: observeMainEvent,
      runIdleTimeoutMs: timeoutSettings.gatewayIdleTimeoutMs,
      workspace: agentOptions,
    },
    profile: mainProfile,
    requestExecutionId: requestExecution.identity.executionId,
  });
  externalWaitByExecution.set(
    requestExecution.identity.executionId,
    () => mainExecution!.beginExternalWait(),
  );
  workspaceSnapshot = new Map(
    (await listWorkspaceFiles(store, sessionId)).map((file) => [file.path, workspaceFileFingerprint(file)]),
  );
  try {
    assertRunActive();
    const latestHistory: AgentHistoryMessage[] =
      (agentOptions.history ?? []).map(({ content, role }) => ({ content, role }));
    lastAgentUsage = unreportedModelUsage();
    await mainExecution.executeAgentRun({
      history: latestHistory,
      prompt: promptUserMessage.content,
      purpose: "initial",
    });
    const taskUsage = lastAgentUsage;
    assertRunActive();
    await flushWorkspaceRefresh();
    assertRunActive();
    await persistObservedTimeouts();
    if (!assistantText) assistantText = "The run completed without a text response.";
    promptManifest = await createPromptManifest({
      cas: provenanceRecorder.cas,
      messages: promptMessages,
      model: selectedModel,
      response: assistantText,
      runtimeSettings: settingsSnapshot,
      sessionId,
      startedAt: runStartedAt,
      systemPrompt,
      systemPromptVersion: WORKSPACE_SYSTEM_PROMPT_VERSION,
      skillRefs: activeSkills.map(({ hash, id, revision, version }) => ({ hash, id, revision, version })),
      ...(sessionSpecialist ? { specialistRef: { id: sessionSpecialist.id, name: sessionSpecialist.name } } : {}),
      turnId: runId,
      usage: taskUsage,
    });
    await store.appendPromptManifest(promptManifest);
    await appendModelUsageForManifest(store, {
      invocationId: taskInvocationId,
      invocationKind: "task",
      manifest: promptManifest,
      runId,
      usage: taskUsage,
    });
    const message = await store.appendMessage(sessionId, "assistant", assistantText, selectedModel);
    // The report Artifact version already carries the chip references drained
    // from this turn's declare_claim calls; mirror them onto the assistant
    // message so the conversation transcript renders [alias] tokens as chips
    // even when the run has no replayable timeline (failed run, empty
    // assistantMessageId) — the report-preview path already reads the version.
    await store.updateMessageReferences(sessionId, message.id, store.latestReportReferences(sessionId));
    assertRunActive();
    await persistObservedTimeouts();
    await flushWorkspaceRefresh();
    await store.updateSessionRun(sessionId, runId, { assistantMessageId: message.id });
    await emit({
      files: await listWorkspaceFiles(store, sessionId),
      // Re-read so the streamed run.completed carries the chip references
      // back-filled onto the message — the live transcript then renders chips
      // without waiting for a reload.
      message: (await store.readMessages(sessionId)).find((entry) => entry.id === message.id) ?? message,
      type: "run.completed",
    });
    return "completed";
  } catch (error) {
    if (cancelledRuns.has(runId)) {
      await flushWorkspaceRefresh();
      await emit({ reason: "Run cancelled", runId, type: "run.cancelled" });
      return "cancelled";
    }
    rememberTimeout(timeoutFailure(error));
    try {
      await persistObservedTimeouts();
    } catch {
      // Preserve the original timeout as the stream's authoritative error.
    }
    if (!promptManifest) {
      try {
        promptManifest = await createPromptManifest({
          cas: provenanceRecorder.cas,
          error: error instanceof Error ? error.message : "Agent run failed",
          messages: promptMessages,
          model: selectedModel,
          runtimeSettings: settingsSnapshot,
          sessionId,
          startedAt: runStartedAt,
          systemPrompt,
          systemPromptVersion: WORKSPACE_SYSTEM_PROMPT_VERSION,
          skillRefs: activeSkills.map(({ hash, id, revision, version }) => ({ hash, id, revision, version })),
          ...(sessionSpecialist ? { specialistRef: { id: sessionSpecialist.id, name: sessionSpecialist.name } } : {}),
          turnId: runId,
          usage: lastAgentUsage,
        });
        await store.appendPromptManifest(promptManifest);
        await appendModelUsageForManifest(store, {
          invocationId: taskInvocationId,
          invocationKind: "task",
          manifest: promptManifest,
          runId,
          usage: lastAgentUsage,
        });
      } catch {
        // The original run error remains authoritative if manifest persistence also fails.
      }
    }
    await flushWorkspaceRefresh();
    await emit({
      error: runFailureMessage(error),
      errorCode: classifyRunFailure(error),
      type: "run.failed",
    });
    return "failed";
  } finally {
    externalWaitByExecution.clear();
    // The decision poll dies with the run's abort signal, so the terminal
    // request state is published here to keep replays from ending on pending.
    for (const request of await store.cancelPendingPermissionRequests(runId)) {
      await emit({ request, type: "permission.resolved" });
    }
    if (activeSessions.get(sessionId)?.runId === runId) activeSessions.delete(sessionId);
    activeRunAbortControllers.delete(runId);
  }
}

function runSubscriberKey(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`;
}

export function isTerminalRunStatus(status: SessionRunStatus): boolean {
  return status === "cancelled" || status === "completed" || status === "failed" || status === "interrupted";
}

export async function sessionHasActiveRun(store: SessionStore, sessionId: string): Promise<boolean> {
  if (activeSessions.has(sessionId)) return true;
  return (await store.listSessionRuns(sessionId)).some((run) => !isTerminalRunStatus(run.status));
}

async function findCurrentCancelableRun(store: SessionStore, sessionId: string): Promise<SessionRun | undefined> {
  const runs = await store.listSessionRuns(sessionId);
  return runs.find((run) => run.status === "running" || run.status === "blocked")
    ?? runs.find((run) => run.status === "queued");
}

export async function cancelQueuedRunBeforeExecution(
  store: SessionStore,
  sessionId: string,
  runId: string,
): Promise<SessionRun | undefined> {
  const cancelled = await store.updateSessionRunStatusIfCurrent(sessionId, runId, "queued", "cancelled", {
    finishedAt: new Date().toISOString(),
  });
  if (!cancelled) return undefined;
  runLog.info("run_cancelled", { reason: "cancelled_before_execution", runId, sessionId });
  await publishRunEvent(store, sessionId, runId, { reason: "Run cancelled before execution", runId, type: "run.cancelled" });
  await publishRunEvent(store, sessionId, runId, { reason: "Run cancelled before execution", run: cancelled, status: "cancelled", type: "run.status" });
  return cancelled;
}

export async function cancelCurrentSessionRun(
  response: ServerResponse,
  store: SessionStore,
  sessionId: string,
  legacyResponse = false,
): Promise<void> {
  if (!store.getSession(sessionId)) {
    sendError(response, 404, "Session not found");
    return;
  }
  // Manual Reviewer runs do not create a SessionRun, so Stop must cancel its
  // own per-Session controller as well as the main Agent run when one exists.
  const reviewerCancelled = cancelReviewerCheckpoints(sessionId);
  // The controller map is intentionally in-process. If an API process was
  // restarted (or a request was routed to a sibling process), there can still
  // be a persisted running checkpoint with no local controller to abort.
  // Mark it terminal here so Stop is reliable from the user's perspective;
  // Store guards ensure an older worker cannot later overwrite this state.
  const runningReviewerMessages = (await store.getSessionDetail(sessionId))?.messages.filter((message) =>
    message.kind === "reviewer_checkpoint" && message.reviewerCheckpoint?.status === "running",
  ) ?? [];
  if (reviewerCancelled || runningReviewerMessages.length) {
    for (const message of runningReviewerMessages) {
      await store.updateReviewerCheckpointMessage(sessionId, message.id, {
        content: reviewerCheckpointPromptContent([], "Review cancelled by user"),
        error: "Review cancelled by user",
        status: "failed",
      });
    }
  }
  const active = await findCurrentCancelableRun(store, sessionId);
  if (!active) {
    if (reviewerCancelled || runningReviewerMessages.length) {
      sendJson(response, legacyResponse ? 202 : 200, legacyResponse
        ? { cancelled: true, sessionId }
        : { cancelled: true, runId: "reviewer-specialist", sessionId } satisfies CancelRunResult);
      return;
    }
    sendError(response, 409, "No run is active for this session");
    return;
  }
  cancelledRuns.add(active.id);
  runLog.info("run_cancel_requested", { reason: "user_cancelled", runId: active.id, sessionId });
  const controller = activeRunAbortControllers.get(active.id);
  if (controller) controller.abort();
  else if (active.status === "queued") {
    const cancelled = await cancelQueuedRunBeforeExecution(store, sessionId, active.id);
    if (!cancelled) {
      const current = await store.getSessionRun(sessionId, active.id);
      if (current && !isTerminalRunStatus(current.status)) {
        activeRunAbortControllers.get(active.id)?.abort();
      }
    }
  }
  sendJson(
    response,
    legacyResponse ? 202 : 200,
    legacyResponse
      ? { cancelled: true, sessionId }
      : { cancelled: true, runId: active.id, sessionId } satisfies CancelRunResult,
  );
}

function isTerminalRunEvent(event: RunStreamEvent): boolean {
  return event.type === "run.status" && isTerminalRunStatus(event.status);
}

export interface DeltaCoalescingSink {
  emit: RunEventSink;
  /** Publish whatever is buffered; run teardown must call this before the terminal status. */
  flush(): Promise<void>;
}

/**
 * Streamed text arrives token-sized, but every published record pays a fixed
 * envelope in the JSONL stream. Buffer consecutive same-stream deltas and
 * publish one merged record per window: the text is concatenated exactly, so
 * nothing is lost except transport chunk boundaries. Any non-delta event
 * flushes first, which keeps tool/permission ordering intact.
 */
export function createDeltaCoalescingSink(
  publish: RunEventSink,
  windowMs = 250,
  maxChars = 8_192,
): DeltaCoalescingSink {
  let pending: { delta: string; turn?: number; type: "assistant.delta" | "assistant.thinking.delta" } | undefined;
  let timer: NodeJS.Timeout | undefined;

  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!pending) return Promise.resolve();
    const merged: RunStreamEvent = pending.type === "assistant.thinking.delta"
      ? { delta: pending.delta, turn: pending.turn!, type: "assistant.thinking.delta" }
      : { delta: pending.delta, type: "assistant.delta" };
    pending = undefined;
    return Promise.resolve(publish(merged));
  };

  const emit: RunEventSink = (event) => {
    if (event.type === "assistant.delta" || event.type === "assistant.thinking.delta") {
      const turn = event.type === "assistant.thinking.delta" ? event.turn : undefined;
      if (pending && (pending.type !== event.type || pending.turn !== turn)) void flush();
      if (!pending) {
        pending = { delta: "", ...(turn === undefined ? {} : { turn }), type: event.type };
        timer = setTimeout(() => void flush(), windowMs);
        timer.unref?.();
      }
      pending.delta += event.delta;
      if (pending.delta.length >= maxChars) return flush();
      return Promise.resolve();
    }
    void flush();
    return Promise.resolve(publish(event));
  };

  return { emit, flush };
}

export function toolOutputStreamId(toolCallId: string): string {
  return `tool-${toolCallId}`;
}

export function subagentStreamId(subagentId: string): string {
  return `subagent-${subagentId}`;
}

/**
 * Persist an event where it belongs before fanning it out to live subscribers.
 * Growable payloads (tool output, subagent process steps) land in the run's
 * child streams and are broadcast without a main-stream sequence; the catalog's
 * subagent records stay a panel projection of the step stream. The slim
 * subagent milestone keeps the main timeline free of repeated step snapshots.
 */
export async function publishRunEvent(
  store: SessionStore,
  sessionId: string,
  runId: string,
  event: RunStreamEvent,
): Promise<SessionRunEvent> {
  let record: SessionRunEvent;
  if (event.type === "tool.output") {
    const persisted = await store.appendRunStreamEvent(sessionId, runId, toolOutputStreamId(event.toolCallId), event);
    record = { ...persisted, sequence: 0 };
  } else if (event.type === "subagent.step") {
    const persisted = await store.appendRunStreamEvent(sessionId, runId, subagentStreamId(event.subagentId), event);
    record = { ...persisted, sequence: 0 };
  } else if (event.type === "subagent.updated") {
    const persisted = await store.appendSessionRunEvent(sessionId, runId, {
      subagent: { ...event.subagent, steps: [] },
      type: "subagent.updated",
    });
    record = { ...persisted, event };
  } else {
    record = await store.appendSessionRunEvent(sessionId, runId, event);
  }
  const subscribers = runEventSubscribers.get(runSubscriberKey(sessionId, runId));
  if (subscribers) {
    for (const subscriber of subscribers) subscriber(record);
  }
  return record;
}

async function applyInitialSessionTitle(
  store: SessionStore,
  firstRun: SessionRun,
): Promise<Session | undefined> {
  if (firstRun.queueOrder !== 1) return undefined;
  const session = store.getSession(firstRun.sessionId);
  if (!session || session.archivedAt || session.title !== UNTITLED_SESSION_TITLE) return undefined;
  return await store.compareAndSetSessionTitle(
    session.id,
    UNTITLED_SESSION_TITLE,
    createLocalSessionTitle(firstRun.prompt, session.createdAt),
  );
}

async function refineFirstSessionTitle(
  store: SessionStore,
  firstRun: SessionRun,
  provisionalTitle: string,
): Promise<Session | undefined> {
  const session = store.getSession(firstRun.sessionId);
  if (!session) return undefined;
  if (session.archivedAt) return session;
  if (session.title !== provisionalTitle) return session;
  const invocationId = `session-naming:${firstRun.id}`;
  const model = store.getModel(firstRun.settingsSnapshot.modelId);
  const apiToken = model ? store.getModelApiToken(model.id) : undefined;
  if (!model || !apiToken) return session;

  const refined = await generateRefinedSessionTitle({
    apiToken,
    firstMessage: firstRun.prompt,
    model,
  });
  let updatedSession = store.getSession(session.id);
  if (refined.title !== provisionalTitle) {
    updatedSession = await store.compareAndSetSessionTitle(session.id, provisionalTitle, refined.title)
      ?? store.getSession(session.id);
  }
  await store.appendModelInvocationUsage({
    attemptIndex: 0,
    cacheReadTokens: refined.usage.cacheReadTokens,
    cacheWriteTokens: refined.usage.cacheWriteTokens,
    costUsd: null,
    finishedAt: refined.finishedAt,
    id: randomUUID(),
    inputTokens: refined.usage.inputTokens,
    invocationId,
    invocationKind: "session-naming",
    model: model.model,
    modelProfileId: model.id,
    modelProfileName: model.name,
    outputTokens: refined.usage.outputTokens,
    projectId: session.projectId,
    runId: firstRun.id,
    sessionId: session.id,
    startedAt: refined.startedAt,
    totalTokens: refined.usage.totalTokens,
    usageStatus: refined.usage.usageStatus,
  });
  return updatedSession;
}

function refineSessionTitleInBackground(
  store: SessionStore,
  firstRun: SessionRun,
  provisionalTitle: string,
): void {
  void refineFirstSessionTitle(store, firstRun, provisionalTitle)
    .then(async (updated) => {
      if (!updated || updated.title === provisionalTitle) return;
      await publishRunEvent(store, firstRun.sessionId, firstRun.id, {
        session: updated,
        type: "session.updated",
      });
    })
    .catch((error) => {
      console.warn(
        `Could not publish the refined Session title for ${firstRun.sessionId}:`,
        error instanceof Error ? error.message : error,
      );
    });
}

function computeSettingsSnapshot(store: SessionStore, sessionId: string): EffectiveRuntimeSettings {
  const session = store.assertSessionWritable(sessionId);
  const sessionSpecialist = store.getSpecialist(session.specialistId);
  const resolved = store.resolveRuntimeSettings(sessionId).effective;
  return {
    ...structuredClone(resolved),
    enabledConnectorIds: [...new Set([...resolved.enabledConnectorIds, ...(sessionSpecialist?.connectorIds ?? [])])],
    enabledSkillIds: [...new Set([...resolved.enabledSkillIds, ...(sessionSpecialist?.enabledSkillIds ?? [])])],
  };
}

export async function createQueuedRun(
  store: SessionStore,
  skillCatalog: SkillCatalog,
  sessionId: string,
  body: SendMessageRequest,
): Promise<SessionRun> {
  const session = store.assertSessionWritable(sessionId);
  if (session.archivedAt) throw new ApiStatusError(409, "Session is archived and read-only");
  const submittedPrompt = body.content?.trim();
  const slashRefresh = submittedPrompt?.startsWith("/web-refresh ");
  const prompt = slashRefresh ? submittedPrompt.slice("/web-refresh ".length).trim() : submittedPrompt;
  if (!prompt) throw new ApiStatusError(400, "Message content is required");
  let references: ComposerReference[];
  try {
    references = await resolveComposerReferences(body.references, sessionId, store, skillCatalog);
  } catch (error) {
    throw new ApiStatusError(400, error instanceof Error ? error.message : "Composer references are invalid");
  }
  const run = await store.createSessionRun({
    annotationIds: body.annotationIds,
    prompt,
    references,
    sessionId,
    settingsSnapshot: computeSettingsSnapshot(store, sessionId),
    webForceRefresh: body.webForceRefresh === true || slashRefresh,
  });
  const renamedSession = await applyInitialSessionTitle(store, run);
  if (renamedSession) await publishRunEvent(store, sessionId, run.id, {
    session: renamedSession,
    type: "session.updated",
  });
  await publishRunEvent(store, sessionId, run.id, { run, type: "run.queued" });
  if (renamedSession) refineSessionTitleInBackground(store, run, renamedSession.title);
  return run;
}

export function scheduleSessionRuns(
  store: SessionStore,
  runnerClient: RunnerClient,
  provenanceRecorder: ProvenanceRecorder,
  mcpBroker: McpGovernanceBroker,
  webBroker: WebBroker,
  mcpRegistry: ReturnType<typeof createBuiltinMcpSourceRegistry>,
  mcpCatalog: McpSourceCatalog,
  artifactManager: ArtifactManager,
  paperService: PaperService,
  remoteCompute: RemoteComputeClient,
  skillCatalog: SkillCatalog,
  memoryGraphSink: MemoryGraphSink,
  sessionId: string,
  serverConfig: ServerConfig,
  memoryGraphClient: MemoryGraphClient | null,
): void {
  if (scheduledSessions.has(sessionId)) return;
  scheduledSessions.add(sessionId);
  void (async () => {
    try {
      while (true) {
        const next = (await store.listSessionRuns(sessionId)).find((run) => run.status === "queued");
        if (!next) return;
        if (cancelledRuns.has(next.id)) {
          await cancelQueuedRunBeforeExecution(store, sessionId, next.id);
          cancelledRuns.delete(next.id);
          continue;
        }
        const startedAt = new Date().toISOString();
        const requestAbortController = new AbortController();
        activeRunAbortControllers.set(next.id, requestAbortController);
        const started = await store.updateSessionRunStatusIfCurrent(sessionId, next.id, "queued", "running", { startedAt });
        if (!started) {
          activeRunAbortControllers.delete(next.id);
          continue;
        }
        runLog.info("run_started", { runId: next.id, sessionId });
        let eventQueue = Promise.resolve();
        const publish: RunEventSink = (event) => {
          eventQueue = eventQueue.then(() => publishRunEvent(store, sessionId, next.id, event)).then(() => undefined);
          return eventQueue;
        };
        const deltaSink = createDeltaCoalescingSink(publish);
        const emit = deltaSink.emit;
        await emit({ run: started, status: "running", type: "run.status" });
        let status: SessionRunStatus = "failed";
        let error: string | undefined;
        try {
          status = await executeAgentRun(
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
            next.id,
            {
              annotationIds: next.annotationIds,
              content: next.prompt,
              references: next.references,
              webForceRefresh: next.webForceRefresh,
            },
            requestAbortController,
            next.settingsSnapshot,
            emit,
            serverConfig,
            memoryGraphClient,
          );
        } catch (reason) {
          error = runFailureMessage(reason);
          status = cancelledRuns.has(next.id) ? "cancelled" : "failed";
          await emit(status === "cancelled"
            ? { reason: "Run cancelled", runId: next.id, type: "run.cancelled" }
            : { error, errorCode: classifyRunFailure(reason), type: "run.failed" });
        } finally {
          await deltaSink.flush();
          await eventQueue;
          cancelledRuns.delete(next.id);
          const finished = await store.updateSessionRunStatus(sessionId, next.id, status, {
            ...(error && status === "failed" ? { error } : {}),
            finishedAt: new Date().toISOString(),
          });
          await publishRunEvent(store, sessionId, next.id, { run: finished, status, type: "run.status" });
          const durationMs = Math.max(0, Date.now() - Date.parse(startedAt));
          if (status === "completed") {
            runLog.info("run_completed", { durationMs, runId: next.id, sessionId });
          } else if (status === "cancelled") {
            runLog.info("run_cancelled", { durationMs, reason: "user_cancelled", runId: next.id, sessionId });
          } else {
            runLog.error("run_failed", {
              durationMs,
              errorMessage: shortErrorMessage(error ?? "Agent run failed"),
              runId: next.id,
              sessionId,
            });
          }
        }
      }
    } finally {
      scheduledSessions.delete(sessionId);
      const stillQueued = (await store.listSessionRuns(sessionId)).some((run) => run.status === "queued");
      if (stillQueued) scheduleSessionRuns(
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
        serverConfig,
        memoryGraphClient,
      );
    }
  })();
}

export async function recoverSessionRuns(store: SessionStore, memoryGraphClient: MemoryGraphClient | null = null): Promise<void> {
  for (const project of store.listProjects()) {
    for (const session of store.listSessions(project.id, "all")) {
      for (const run of await store.listSessionRuns(session.id)) {
        if (run.status !== "running" && run.status !== "blocked") continue;
        const reason = "API process exited before this run reached a terminal state";
        const interrupted = await store.updateSessionRunStatus(session.id, run.id, "interrupted", {
          error: reason,
          finishedAt: new Date().toISOString(),
        });
        runLog.warn("run_interrupted", {
          reason: "api_process_exit",
          runId: run.id,
          sessionId: session.id,
        });
        // Subagent-scoped requests are keyed by the subagent's execution id,
        // not the run id, so they need their own cancellation sweep.
        for (const subagent of store.listSubagents(session.id)) {
          if (subagent.parentTurnId !== run.id) continue;
          for (const request of await store.cancelPendingPermissionRequests(subagent.id)) {
            await publishRunEvent(store, session.id, run.id, { request, type: "permission.resolved" });
          }
        }
        for (const request of await store.cancelPendingPermissionRequests(run.id)) {
          await publishRunEvent(store, session.id, run.id, { request, type: "permission.resolved" });
        }
        await publishRunEvent(store, session.id, run.id, {
          reason,
          run: interrupted,
          status: "interrupted",
          type: "run.status",
        });
      }
    }
  }
}

export async function streamStoredRunEvents(
  response: ServerResponse,
  store: SessionStore,
  sessionId: string,
  runId: string,
  after: number,
  closeOnTerminal: boolean,
): Promise<void> {
  const run = await store.getSessionRun(sessionId, runId);
  if (!run) {
    sendError(response, 404, "Run not found");
    return;
  }
  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  });
  response.flushHeaders();
  let lastSequence = after;
  const key = runSubscriberKey(sessionId, runId);
  let buffering = true;
  const buffered: SessionRunEvent[] = [];
  let sawTerminal = isTerminalRunStatus(run.status);
  const deliver = (record: SessionRunEvent) => {
    if (record.sequence <= 0) {
      // Child-stream payloads fan out live without a main-stream cursor; a
      // reconnecting client re-reads them from their own stream instead.
      writeSse(response, record.event);
      return;
    }
    if (record.sequence <= lastSequence) return;
    lastSequence = record.sequence;
    writeSse(response, record.event, record.sequence);
    if (isTerminalRunEvent(record.event)) sawTerminal = true;
  };
  const subscriber: RunEventSubscriber = (record) => {
    if (buffering) buffered.push(record);
    else {
      deliver(record);
      if (closeOnTerminal && sawTerminal) response.end();
    }
  };
  const subscribers = runEventSubscribers.get(key) ?? new Set<RunEventSubscriber>();
  subscribers.add(subscriber);
  runEventSubscribers.set(key, subscribers);
  response.once("close", () => {
    subscribers.delete(subscriber);
    if (!subscribers.size) runEventSubscribers.delete(key);
    if (!sawTerminal) {
      runLog.info("run_stream_disconnected", { reason: "client_disconnect", runId, sessionId });
    }
  });
  const replay = await store.listSessionRunEvents(sessionId, runId, after);
  for (const record of replay) deliver(record);
  buffering = false;
  for (const record of buffered.toSorted((left, right) => left.sequence - right.sequence)) deliver(record);
  if (closeOnTerminal && sawTerminal) response.end();
}

export async function streamAgentRun(
  request: IncomingMessage,
  response: ServerResponse,
  store: SessionStore,
  runnerClient: RunnerClient,
  provenanceRecorder: ProvenanceRecorder,
  mcpBroker: McpGovernanceBroker,
  webBroker: WebBroker,
  mcpRegistry: ReturnType<typeof createBuiltinMcpSourceRegistry>,
  mcpCatalog: McpSourceCatalog,
  artifactManager: ArtifactManager,
  paperService: PaperService,
  remoteCompute: RemoteComputeClient,
  skillCatalog: SkillCatalog,
  memoryGraphSink: MemoryGraphSink,
  sessionId: string,
  body: SendMessageRequest,
  serverConfig: ServerConfig,
  memoryGraphClient: MemoryGraphClient | null,
): Promise<void> {
  const run = await createQueuedRun(store, skillCatalog, sessionId, body);
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
    serverConfig,
    memoryGraphClient,
  );
  request.once("close", () => {
    // Browser disconnects should not cancel queued backend work. Cancellation
    // is explicit through /runs/:id/cancel so refresh/reconnect can replay.
  });
  await streamStoredRunEvents(response, store, sessionId, run.id, 0, true);
}

export function getActiveSessionRun(sessionId: string): RuntimeSessionRun | undefined {
  return activeSessions.get(sessionId);
}

export async function cancelSessionRun(
  response: ServerResponse,
  store: SessionStore,
  sessionId: string,
  runId: string,
): Promise<void> {
  const run = await store.getSessionRun(sessionId, runId);
  if (!run) return sendError(response, 404, "Run not found");
  if (isTerminalRunStatus(run.status)) {
    sendJson(response, 200, run);
    return;
  }
  cancelledRuns.add(runId);
  runLog.info("run_cancel_requested", { reason: "user_cancelled", runId, sessionId });
  const controller = activeRunAbortControllers.get(runId);
  if (controller) {
    controller.abort();
    sendJson(response, 202, run);
    return;
  }
  if (run.status === "queued") {
    const cancelled = await cancelQueuedRunBeforeExecution(store, sessionId, runId);
    if (cancelled) {
      sendJson(response, 200, cancelled);
      return;
    }
    const current = await store.getSessionRun(sessionId, runId);
    if (!current) return sendError(response, 404, "Run not found");
    if (isTerminalRunStatus(current.status)) {
      sendJson(response, 200, current);
      return;
    }
    activeRunAbortControllers.get(runId)?.abort();
    sendJson(response, 202, current);
    return;
  }
  sendJson(response, 202, run);
}
