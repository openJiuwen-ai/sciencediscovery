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

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { VersionStore, RefStore, workspaceHeadName, withWorkspaceMutation, withWorkspaceAdmission, withWorkspaceRetirement } from "@sciencediscovery/cas";
import { dirname, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentNotifications } from "./agent-notifications.js";
import { ShellExecutions } from "./shell-executions.js";
import { WorkspaceTransfers } from "./workspace-transfers.js";

import type {
  ChatMessage,
  ArtifactReviewRun,
  ReviewerAuditTask,
  ReviewFeedback,
  ArtifactAnnotation,
  ArtifactDerivation,
  ArtifactOrigin,
  ArtifactOriginMeta,
  ArtifactExtractionJob,
  ArtifactJob,
  ArtifactPlan,
  CasObjectRef,
  Claim,
  ComposerReference,
  CreateRemoteJobRequest,
  CreateArtifactAnnotationRequest,
  CreateSpecialistRequest,
  DecideRemoteJobRequest,
  Subagent,
  SubagentInput,
  UpdateSubagentBriefRequest,
  ConnectorId,
  CreateModelProfileRequest,
  DeletionImpact,
  Environment,
  EnvironmentRevision,
  EnvironmentSourceSettings,
  EffectiveRuntimeSettings,
  ExecutionRun,
  EvidenceLink,
  EvidenceItem,
  CreateProxyServerRequest,
  IdeaTreeSettings,
  IdeaTreeSettingsDetails,
  McpProxyPolicies,
  MemoryGraphSettings,
  MemoryGraphSettingsDetails,
  McpInvocation,
  ModelFactOverrides,
  ModelUsageAnalyticsFilters,
  ModelUsageAnalyticsSummary,
  ModelInvocationUsage,
  ModelRunInfo,
  ModelProfile,
  ModelProvider,
  ModelThinkingEffort,
  ModelThinkingMode,
  CreateModelProviderRequest,
  UpdateModelProviderRequest,
  PaperAcquisition,
  PaperVisionRun,
  PermissionAction,
  PermissionAuthorization,
  PermissionAuthorizationSource,
  PermissionDecision,
  PermissionEpoch,
  PermissionGrant,
  PermissionGrantScope,
  PermissionRequest,
  PromptManifest,
  Project,
  ProxyDefaultPolicy,
  ProxyPolicy,
  ProxyServer,
  ProxySettingsDetails,
  ResolvedProxy,
  RemoteHostCapabilities,
  RemoteHostConnectionKind,
  RemoteHostEndpoint,
  RemoteHostTarget,
  RemoteJob,
  RemoteWorkspaceSyncRecord,
  ReviewRun,
  SessionReviewerSpecialistSettings,
  ReviewerSpecialistLevel,
  ReviewerSpecialistSettings,
  ResolvedRuntimeSettings,
  RuntimeSettingsDetails,
  RuntimeSettingsField,
  RuntimeSettingsOverrides,
  RuntimeSettingsSource,
  Session,
  SessionDetail,
  SessionRun,
  SessionRunEvent,
  SessionRunStatus,
  IdeaTreeRunSettingsSnapshot,
  SessionUsageSummary,
  GlobalModelUsageSummary,
  ScientificArtifact,
  ScientificArtifactKind,
  ScientificArtifactVersion,
  SessionArtifactOutput,
  SessionListState,
  SkillDeletionImpact,
  SkillSelectionMode,
  SandboxNetworkAccess,
  SandboxNetworkSettings,
  Specialist,
  SystemQuotaSettings,
  SystemTimeoutSettings,
  TimeoutKind,
  UpdateIdeaTreeSettingsRequest,
  UpdateMcpProxyPoliciesRequest,
  UpdateMemoryGraphSettingsRequest,
  UpdateEnvironmentSourceSettingsRequest,
  UpdateModelProfileRequest,
  UpdateProjectRequest,
  UpdateProxyServerRequest,
  UpdateProxySettingsRequest,
  UpdateSessionRequest,
  UpdateSpecialistRequest,
  UpdateWebSettingsRequest,
  WebSettingsDetails,
  WorkspaceFile,
  WorkspaceFileProvenance,
  WorkspaceFileProvenanceSummary,
  WorkspaceFileRecord,
  WorkspaceFileRevision,
  WorkspaceFileRevisionInput,
  ResolvedModelPricing,
} from "@sciencediscovery/schema";
import {
  DEFAULT_SANDBOX_NETWORK_SETTINGS,
  DEFAULT_SKILL_SELECTION_MODE,
  DEFAULT_SYSTEM_QUOTA_SETTINGS,
  DEFAULT_REVIEWER_SPECIALIST_LEVEL,
  DEFAULT_REVIEWER_FEEDBACK_POLICY,
  DEFAULT_SYSTEM_TIMEOUT_SETTINGS,
  DEFAULT_MEMORY_GRAPH_SETTINGS,
  DEFAULT_WEB_SETTINGS,
  REVIEWER_SPECIALIST_LEVELS,
  REVIEWER_FEEDBACK_POLICIES,
  SKILL_SELECTION_FIELDS,
  epochSandboxNetworkAccess,
  UNTITLED_SESSION_TITLE,
} from "@sciencediscovery/schema";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
} from "@sciencediscovery/orchestration";

import { SCIENTIFIC_ARTIFACT_KIND_SET, resolveScientificArtifactKind } from "@sciencediscovery/schema";
import {
  constrainCatalogThinking,
  getModelProviderPreset,
  lookupModelCatalog,
  MODEL_API_VARIANTS,
  resolveModelFacts,
} from "@sciencediscovery/schema";
import {
  DEFAULT_ENVIRONMENT_REVISION_ID,
  defaultEnvironmentRevision,
  defaultShellEnvironmentRevision,
  isSystemEnvironmentRevisionId,
} from "@sciencediscovery/executor";
import { toolOutputStoreRoot } from "@sciencediscovery/tools";
import { normalizeWorkspaceRelativePath } from "@sciencediscovery/workspace";
import { summarizeGlobalModelUsage, summarizeModelUsage, summarizeModelUsageAnalytics } from "./model-usage.js";
import { normalizeEnvironmentSourceSettings } from "./environment-sources.js";
import { BUNDLED_SKILL_IDS } from "@sciencediscovery/specialist";
import { BUILTIN_SPECIALISTS } from "@sciencediscovery/specialist";
import { normalizeSubagentBrief } from "./subagent-brief.js";
import {
  emptyCatalog,
  ENVIRONMENT_PROXY_SERVER_ID,
  environmentProxyServer,
  hasOwn,
  isRecord,
  type Catalog,
} from "./store/catalog.js";
import { proxyEnvironmentDetails, resolveProxyEnvironment, resolveProxyPolicy, type ProxyRegistryView } from "@sciencediscovery/data-source";
import {
  cleanLabel,
  createPermissionEpoch,
  parsePermissionAuthorization,
  permissionMatcherResource,
} from "@sciencediscovery/governance";
import {
  normalizeSandboxNetworkSettings,
  resolveSandboxNetworkSettings,
  sandboxNetworkAccess,
} from "./store/sandbox-network.js";
import {
  decryptModelApiToken,
  decryptSecretValue,
  encryptModelApiToken,
  encryptSecretValue,
  loadOrCreateModelSecretKey,
  normalizeApiToken,
  normalizeModelFactOverrides,
  validateLiveModel,
} from "./store/secrets.js";
import {
  normalizePersistedRemoteHost,
  normalizePersistedSessionRemoteRunners,
  normalizeRemoteHostEndpoint,
  normalizeSshPort,
  remoteRunnerUnusableReason,
  type RemoteHostSecretKind,
} from "./store/remote-hosts.js";
import { openSshPublicKey } from "@sciencediscovery/executor";
import { planStandaloneProfileMigration, providerSecretKey, validateLiveProvider } from "./store/providers.js";
import {
  knownConnectorIdSet,
  normalizeIdeaTreeSettings,
  normalizeMcpProxyPolicies,
  normalizeMemoryGraphSettings,
  normalizeProxyDefaultPolicy,
  normalizeProxyPolicy,
  normalizeProxyUrl,
  normalizeQuotaSettings,
  normalizeRuntimeSettings,
  normalizeTimeoutSettings,
  normalizeWebSettings,
  PROXY_SERVER_KINDS,
  resolveIdeaTreeSettings,
  resolveQuotaSettings,
  RUNTIME_SETTINGS_FIELDS,
  withoutSkillSelection,
} from "./store/settings.js";
import {
  normalizePersistedSubagent,
  normalizeSubagentInputPaths,
} from "./store/subagents.js";
import {
  assertValidStreamId,
  MAIN_RUN_STREAM,
  parseStreamLines,
  type RunStreamLine,
} from "./store/run-streams.js";

export { MAIN_RUN_STREAM } from "./store/run-streams.js";

const SESSION_DATA_CATEGORIES = [
  "messages",
  "execution records",
  "provenance and reviews",
  "connector and evidence records",
  "paper records",
  "workspace files",
] as const;

interface StagedDeletion {
  entries: Array<{ source: string; staged: string }>;
  root: string;
  sessionIds: string[];
  scopes?: string[];
  projectId?: string;
  committed?: boolean;
}

function withDefaultProjectSkillSettings(input: RuntimeSettingsOverrides): RuntimeSettingsOverrides {
  if (
    hasOwn(input, "enabledSkillIds")
    || hasOwn(input, "enabledSkillLibraries")
    || hasOwn(input, "skillSelectionMode")
  ) {
    return input;
  }
  return {
    ...input,
    enabledSkillIds: [],
    enabledSkillLibraries: [],
    skillSelectionMode: "selected",
  };
}

function requiredLabel(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  const cleaned = cleanLabel(value, "");
  if (!cleaned) throw new Error(`${field} is required`);
  return cleaned;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${field} is required`);
  if (cleaned.length > maxLength) throw new Error(`${field} must be 1-${maxLength} characters`);
  return cleaned;
}

function remotePath(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  const path = value.trim();
  if (!path.startsWith("/") || path.includes("\0") || path.includes("\n") || path.length > 2_000) {
    throw new Error(`${field} must be an absolute remote POSIX path of at most 2000 characters`);
  }
  return path;
}

function isReviewerSpecialistLevel(value: unknown): value is ReviewerSpecialistLevel {
  return typeof value === "string"
    && (REVIEWER_SPECIALIST_LEVELS as readonly string[]).includes(value);
}

function isReviewerFeedbackPolicy(value: unknown): value is import("@sciencediscovery/schema").ReviewerFeedbackPolicy {
  return typeof value === "string"
    && (REVIEWER_FEEDBACK_POLICIES as readonly string[]).includes(value);
}

const WORKSPACE_FILE_ORIGINS = new Set<WorkspaceFileRevision["origin"]>([
  "agent",
  "mcp-download",
  "remote-compute",
  "subagent",
  "system",
  "tool",
  "unknown",
  "upload",
]);

function savedWorkspaceFileRecord(value: unknown): WorkspaceFileRecord | undefined {
  if (!isRecord(value)) return undefined;
  const required = ["createdAt", "currentRevisionId", "id", "path", "projectId", "sessionId", "sessionTitle", "updatedAt"];
  if (required.some((field) => typeof value[field] !== "string" || !value[field])) return undefined;
  if (Number.isNaN(Date.parse(value.createdAt as string)) || Number.isNaN(Date.parse(value.updatedAt as string))) return undefined;
  return {
    createdAt: value.createdAt as string,
    currentRevisionId: value.currentRevisionId as string,
    ...(typeof value.deletedAt === "string" && value.deletedAt ? { deletedAt: value.deletedAt } : {}),
    id: value.id as string,
    path: value.path as string,
    projectId: value.projectId as string,
    sessionId: value.sessionId as string,
    sessionTitle: value.sessionTitle as string,
    updatedAt: value.updatedAt as string,
  };
}

function savedWorkspaceFileRevision(value: unknown): WorkspaceFileRevision | undefined {
  if (!isRecord(value) || !WORKSPACE_FILE_ORIGINS.has(value.origin as WorkspaceFileRevision["origin"])) return undefined;
  const required = ["createdAt", "fileId", "id", "modifiedAt", "path", "projectId", "sessionId"];
  if (required.some((field) => typeof value[field] !== "string" || !value[field])) return undefined;
  if (Number.isNaN(Date.parse(value.createdAt as string)) || Number.isNaN(Date.parse(value.modifiedAt as string))) return undefined;
  if (typeof value.size !== "number" || !Number.isFinite(value.size) || value.size < 0) return undefined;
  const optionalString = (field: string): Record<string, string> =>
    typeof value[field] === "string" && value[field] ? { [field]: value[field] as string } : {};
  const originMeta = isRecord(value.originMeta)
    ? Object.fromEntries(Object.entries(value.originMeta).filter((entry): entry is [string, boolean | number | string | null] => {
        const item = entry[1];
        return item === null || typeof item === "boolean" || typeof item === "number" || typeof item === "string";
      }))
    : undefined;
  return {
    artifactVersionIds: Array.isArray(value.artifactVersionIds)
      ? [...new Set(value.artifactVersionIds.filter((id): id is string => typeof id === "string" && Boolean(id)))]
      : [],
    ...(typeof value.contentHash === "string" && /^[a-f0-9]{64}$/.test(value.contentHash)
      ? { contentHash: value.contentHash }
      : {}),
    createdAt: value.createdAt as string,
    ...optionalString("executionRunId"),
    fileId: value.fileId as string,
    id: value.id as string,
    modifiedAt: value.modifiedAt as string,
    origin: value.origin as WorkspaceFileRevision["origin"],
    ...(originMeta && Object.keys(originMeta).length ? { originMeta } : {}),
    ...optionalString("parentRevisionId"),
    path: value.path as string,
    projectId: value.projectId as string,
    ...optionalString("runId"),
    sessionId: value.sessionId as string,
    size: value.size,
    ...optionalString("subagentId"),
    ...optionalString("toolCallId"),
    ...optionalString("toolName"),
  } as WorkspaceFileRevision;
}

export class SessionStoreHttpError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409) {
    super(message);
    this.name = "SessionStoreHttpError";
  }
}

export class SessionStore {
  readonly dataDir: string;

  /** File publishers share the Runner's cross-process admission and commit boundary. */
  async mutateWorkspace<T>(root: string, kind: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withWorkspaceMutation(new VersionStore(this.dataDir), root, operation, { kind }, signal);
  }
  private readonly arrayMutationQueues = new Map<string, Promise<void>>();
  private readonly streamAppendQueues = new Map<string, Promise<void>>();
  private readonly streamTailSequences = new Map<string, number>();
  private readonly subagentMutationQueues = new Map<string, Promise<void>>();
  private readonly workspaceFileMutationQueues = new Map<string, Promise<void>>();
  private catalog: Catalog = emptyCatalog();
  private database?: DatabaseSync;
  private notificationStore?: AgentNotifications;
  private shellExecutionStore?: ShellExecutions;
  private transferStore?: WorkspaceTransfers;
  private loaded = false;
  private saveQueue = Promise.resolve();
  private secretKey?: Buffer;
  private skillIds = new Set<string>(BUNDLED_SKILL_IDS);
  private connectorIds = knownConnectorIdSet();
  private readonly initialTimeoutSettings: SystemTimeoutSettings;
  private readonly initialQuotaSettings: SystemQuotaSettings;
  /**
   * Neo4j password read from `.env` (SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_PASSWORD).
   * Used once on first catalog load to seed the encrypted `memory_graph_secret`
   * table; subsequent loads ignore it — the runtime reads the store. Backward
   * compat for users who had the password in their `.env` before the frontend
   * settings became the sole entry point.
   */
  private readonly initialNeo4jPassword?: string;

  constructor(
    dataDir: string,
    initialTimeoutSettings: SystemTimeoutSettings = DEFAULT_SYSTEM_TIMEOUT_SETTINGS,
    initialQuotaSettings: SystemQuotaSettings = DEFAULT_SYSTEM_QUOTA_SETTINGS,
    initialNeo4jPassword?: string,
  ) {
    this.dataDir = resolve(dataDir);
    this.initialTimeoutSettings = initialTimeoutSettings;
    this.initialQuotaSettings = initialQuotaSettings;
    this.initialNeo4jPassword = initialNeo4jPassword?.trim() || undefined;
  }

  get notifications(): AgentNotifications {
    if (!this.notificationStore) throw new Error("Notification storage is not initialized");
    return this.notificationStore;
  }

  get shellExecutions(): ShellExecutions {
    if (!this.shellExecutionStore) throw new Error("Shell Execution storage is not initialized");
    return this.shellExecutionStore;
  }

  get transfers(): WorkspaceTransfers {
    if (!this.transferStore) throw new Error("Transfer storage is not initialized");
    return this.transferStore;
  }

  private normalizeReviewCriteria(values: string[] | undefined): string[] {
    if (values === undefined) return [];
    if (!Array.isArray(values) || values.length > 20) throw new Error("Review criteria must contain at most 20 items");
    return [...new Set(values.map((value) => {
      if (typeof value !== "string") throw new Error("Review criteria must be strings");
      const criterion = value.trim().replace(/\s+/g, " ");
      if (!criterion || criterion.length > 500) throw new Error("Each review criterion must contain 1-500 characters");
      return criterion;
    }))];
  }

  private get catalogPath(): string {
    return resolve(this.dataDir, "catalog.json");
  }

  private get catalogDatabasePath(): string {
    return resolve(this.dataDir, "catalog.sqlite");
  }

  private get modelSecretKeyPath(): string {
    return resolve(this.dataDir, "model-secrets.key");
  }

  private async loadOrCreateSecretKey(): Promise<Buffer> {
    return loadOrCreateModelSecretKey(this.modelSecretKeyPath);
  }

  private encryptModelApiToken(modelId: string, apiToken: string): string {
    if (!this.secretKey) throw new Error("Model credential storage is not initialized");
    return encryptModelApiToken(this.secretKey, modelId, apiToken);
  }

  private decryptModelApiToken(modelId: string, encrypted: string): string {
    if (!this.secretKey) throw new Error("Model credential storage is not initialized");
    return decryptModelApiToken(this.secretKey, modelId, encrypted);
  }

  private setModelApiToken(modelId: string, apiToken: string | undefined): void {
    if (!this.database) throw new Error("Catalog database is not initialized");
    if (!apiToken) {
      this.database.prepare("DELETE FROM model_secrets WHERE model_id = ?").run(modelId);
      return;
    }
    const encrypted = this.encryptModelApiToken(modelId, apiToken);
    this.database.prepare("INSERT INTO model_secrets (model_id, encrypted_token) VALUES (?, ?) ON CONFLICT(model_id) DO UPDATE SET encrypted_token = excluded.encrypted_token")
      .run(modelId, encrypted);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.dataDir, { recursive: true });
    this.database = new DatabaseSync(this.catalogDatabasePath);
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS catalog_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_secrets (
        model_id TEXT PRIMARY KEY,
        encrypted_token TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS web_provider_secrets (
        provider TEXT PRIMARY KEY,
        encrypted_token TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS web_proxy_secret (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        encrypted_url TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proxy_server_secrets (
        server_id TEXT PRIMARY KEY,
        encrypted_url TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_graph_secret (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        encrypted_password TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS remote_host_secrets (
        host_id TEXT PRIMARY KEY,
        encrypted_token TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS remote_host_credentials (
        host_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        PRIMARY KEY (host_id, kind)
      );
      CREATE TABLE IF NOT EXISTS permission_authorizations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        execution_id TEXT,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS permission_authorizations_session_created
        ON permission_authorizations(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS permission_authorizations_execution
        ON permission_authorizations(execution_id, created_at DESC);
    `);
    this.notificationStore = new AgentNotifications(this.database, (sessionId) => {
      const session = this.getSession(sessionId);
      return !session || Boolean(session.archivedAt);
    });
    this.transferStore = new WorkspaceTransfers(this.database, new VersionStore(this.dataDir));
    this.shellExecutionStore = new ShellExecutions(this.database, new VersionStore(this.dataDir), this.notificationStore);
    this.secretKey = await this.loadOrCreateSecretKey();
    this.migrateRemoteHostTokens();
    const modelIdsWithSecrets = new Set((this.database.prepare("SELECT model_id FROM model_secrets").all() as Array<{ model_id: string }>).map((row) => row.model_id));
    const row = this.database.prepare("SELECT json FROM catalog_state WHERE id = 1").get() as { json: string } | undefined;
    let saved: Partial<Catalog> & { delegationTracks?: Subagent[] } = {};
    let importedLegacyCatalog = false;
    if (row) saved = JSON.parse(row.json) as Partial<Catalog> & { delegationTracks?: Subagent[] };
    else {
      try {
        saved = JSON.parse(await readFile(this.catalogPath, "utf8")) as Partial<Catalog> & { delegationTracks?: Subagent[] };
        importedLegacyCatalog = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    // --- Proxy registry: load, or import the legacy single web proxy fields ---
    const serverIdsWithUrls = new Set(
      (this.database.prepare("SELECT server_id FROM proxy_server_secrets").all() as Array<{ server_id: string }>)
        .map((row) => row.server_id),
    );
    // The web settings dropped proxyMode/proxyUrl in favour of proxyPolicy;
    // strip the legacy key so normalizeWebSettings does not reject it, and
    // remember the mode for the one-time import below.
    let legacyWebProxyMode: string | undefined;
    let savedWebInput: unknown = saved.webSettings;
    if (isRecord(savedWebInput) && hasOwn(savedWebInput, "proxyMode")) {
      const { proxyMode, ...rest } = savedWebInput;
      legacyWebProxyMode = typeof proxyMode === "string" ? proxyMode : undefined;
      savedWebInput = rest;
    }
    let proxyServers: ProxyServer[];
    let proxyDefaultPolicy: ProxyDefaultPolicy;
    let mcpProxyPolicies: McpProxyPolicies;
    let migratedWebProxyPolicy: ProxyPolicy | undefined;
    let migratedProxySettings = false;
    if (Array.isArray(saved.proxyServers)) {
      proxyServers = saved.proxyServers
        .filter((server) => isRecord(server) && typeof server.id === "string"
          && PROXY_SERVER_KINDS.has(server.kind as ProxyServer["kind"]))
        .map((server) => ({
          createdAt: server.createdAt,
          hasUrl: serverIdsWithUrls.has(server.id),
          id: server.id,
          kind: server.kind,
          name: server.name,
          updatedAt: server.updatedAt,
        }));
      try {
        proxyDefaultPolicy = normalizeProxyDefaultPolicy(saved.proxyDefaultPolicy);
      } catch {
        proxyDefaultPolicy = "none";
      }
      try {
        mcpProxyPolicies = normalizeMcpProxyPolicies(saved.mcpProxyPolicies ?? {});
      } catch {
        mcpProxyPolicies = {};
      }
    } else {
      // One-time import of the pre-registry web proxy configuration. The
      // global default stays "environment variables" (the historical
      // behaviour of every non-web outbound path); the legacy web mode is
      // expressed as the web module's own policy so web behaviour is
      // reproduced exactly.
      proxyServers = [environmentProxyServer()];
      proxyDefaultPolicy = `proxy:${ENVIRONMENT_PROXY_SERVER_ID}`;
      mcpProxyPolicies = {};
      const legacyProxyRow = this.database.prepare("SELECT encrypted_url FROM web_proxy_secret WHERE id = 1")
        .get() as { encrypted_url: string } | undefined;
      if (legacyWebProxyMode === "custom" && legacyProxyRow) {
        const importedId = randomUUID();
        const legacyUrl = this.decryptModelApiToken("web:proxy", legacyProxyRow.encrypted_url);
        this.database.prepare(
          "INSERT INTO proxy_server_secrets (server_id, encrypted_url) VALUES (?, ?) ON CONFLICT(server_id) DO UPDATE SET encrypted_url = excluded.encrypted_url",
        ).run(importedId, this.encryptModelApiToken(`proxy:${importedId}`, legacyUrl));
        const importedAt = new Date().toISOString();
        proxyServers.push({
          createdAt: importedAt,
          hasUrl: true,
          id: importedId,
          kind: "custom_url",
          name: "Imported web proxy",
          updatedAt: importedAt,
        });
        migratedWebProxyPolicy = `proxy:${importedId}`;
      } else if (legacyWebProxyMode === "direct") {
        migratedWebProxyPolicy = "none";
      }
      if (legacyProxyRow) this.database.prepare("DELETE FROM web_proxy_secret WHERE id = 1").run();
      migratedProxySettings = true;
    }
    const proxyServerIds = new Set(proxyServers.map((server) => server.id));
    if (proxyDefaultPolicy.startsWith("proxy:") && !proxyServerIds.has(proxyDefaultPolicy.slice("proxy:".length))) {
      proxyDefaultPolicy = "none";
    }
    const normalizeSavedProxyPolicy = (value: unknown): ProxyPolicy => {
      try {
        const policy = normalizeProxyPolicy(value ?? "inherit", "proxyPolicy");
        const serverId = policy.startsWith("proxy:") ? policy.slice("proxy:".length) : undefined;
        return serverId && !proxyServerIds.has(serverId) ? "inherit" : policy;
      } catch {
        return "inherit";
      }
    };

    const savedProviders = Array.isArray(saved.providers) ? saved.providers : [];
    const providers = savedProviders.map((provider) => ({
      ...validateLiveProvider(provider),
      createdAt: provider.createdAt,
      hasApiToken: modelIdsWithSecrets.has(providerSecretKey(provider.id)),
      id: provider.id,
      proxyPolicy: normalizeSavedProxyPolicy(provider.proxyPolicy),
      tokenOptional: provider.tokenOptional === true,
      updatedAt: provider.updatedAt,
    }));
    const providerIds = new Set(providers.map((provider) => provider.id));
    const providerHasToken = new Map(providers.map((provider) => [provider.id, provider.hasApiToken]));

    const savedModels = Array.isArray(saved.models) ? saved.models : [];
    const models = savedModels
      .filter((model) => {
        const legacy = model as ModelProfile & { builtin?: boolean; demoMode?: boolean };
        return legacy.id !== "builtin-demo" && legacy.demoMode !== true && legacy.model !== "deterministic-demo";
      })
      .map((model) => ({
        ...validateLiveModel(model),
        createdAt: model.createdAt,
        hasApiToken: modelIdsWithSecrets.has(model.id)
          || (typeof model.providerId === "string" && providerHasToken.get(model.providerId) === true),
        id: model.id,
        // A profile whose provider disappeared keeps working standalone: its
        // connection fields were always stored on the profile itself.
        ...(typeof model.providerId === "string" && providerIds.has(model.providerId)
          ? { providerId: model.providerId }
          : {}),
        proxyPolicy: normalizeSavedProxyPolicy(model.proxyPolicy),
        updatedAt: model.updatedAt,
      }));

    // Profiles that predate the provider registry own their connection fields
    // and used to be edited through a separate "standalone" surface. Group
    // them by connection so every one of them is reachable through the
    // provider list, without touching profile ids or endpoints.
    const standaloneMigration = planStandaloneProfileMigration(models, {
      newProviderId: () => randomUUID(),
      now: new Date().toISOString(),
    });
    for (const provider of standaloneMigration.providers) providers.push(provider);
    for (const model of models) {
      const providerId = standaloneMigration.assignments.get(model.id);
      if (providerId) model.providerId = providerId;
    }

    const migratedProviders = JSON.stringify(providers) !== JSON.stringify(savedProviders);
    const migratedModels = JSON.stringify(models) !== JSON.stringify(savedModels);
    const modelIds = new Set(models.map((model) => model.id));
    const fallbackModelId = models[0]?.id;
    const defaultGlobalSettings = emptyCatalog(this.initialTimeoutSettings, this.initialQuotaSettings).globalSettings;
    const normalizedGlobalSettings = saved.globalSettings === undefined
      ? undefined
      : withoutSkillSelection(normalizeRuntimeSettings(saved.globalSettings, modelIds, this.skillIds, false, this.connectorIds));
    const globalSettings = normalizedGlobalSettings === undefined
      ? defaultGlobalSettings
      : normalizedGlobalSettings;
    const memoryGraphSettings = normalizeMemoryGraphSettings(saved.memoryGraphSettings);
    const migratedMemoryGraphSettings = JSON.stringify(memoryGraphSettings) !== JSON.stringify(saved.memoryGraphSettings ?? null);
    const ideaTreeSettings = resolveIdeaTreeSettings(saved.ideaTreeSettings);
    const migratedIdeaTreeSettings = JSON.stringify(ideaTreeSettings) !== JSON.stringify(saved.ideaTreeSettings ?? null);
    // One-time backward-compat seed: if no password is stored yet but `.env`
    // still carries SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_PASSWORD (pre-frontend-
    // toggle users), seed the encrypted store from it. Subsequent loads ignore
    // the env value — the runtime reads the store, set via System Settings.
    if (this.initialNeo4jPassword && !this.database!.prepare("SELECT 1 FROM memory_graph_secret WHERE id = 1").get()) {
      this.database!.prepare(
        "INSERT INTO memory_graph_secret (id, encrypted_password) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET encrypted_password = excluded.encrypted_password",
      ).run(this.encryptModelApiToken("memory-graph:neo4j", this.initialNeo4jPassword));
    }
    const projects = (Array.isArray(saved.projects) ? saved.projects : []).map((project) => ({
      ...project,
      remoteRunnerHostIds: Array.isArray(project.remoteRunnerHostIds)
        ? project.remoteRunnerHostIds.filter((id): id is string => typeof id === "string")
        : [],
      settingsOverrides: normalizeRuntimeSettings(project.settingsOverrides, modelIds, this.skillIds, false, this.connectorIds),
    }));
    const migratedHierarchicalSettings = saved.globalSettings === undefined
      || JSON.stringify(globalSettings) !== JSON.stringify(saved.globalSettings)
      || JSON.stringify(projects) !== JSON.stringify(saved.projects ?? []);
    const environments = Array.isArray(saved.environments) ? saved.environments : [];
    const savedEnvironmentRevisions = Array.isArray(saved.environmentRevisions) && saved.environmentRevisions.length
      ? saved.environmentRevisions
      : [defaultEnvironmentRevision(), defaultShellEnvironmentRevision()];
    const environmentRevisions = savedEnvironmentRevisions.map((revision) => {
      if (revision.id === DEFAULT_ENVIRONMENT_REVISION_ID) {
        return { ...defaultEnvironmentRevision(), ...revision, snapshot: defaultEnvironmentRevision().snapshot };
      }
      if (revision.id === defaultShellEnvironmentRevision().id) {
        return { ...defaultShellEnvironmentRevision(), ...revision, snapshot: defaultShellEnvironmentRevision().snapshot };
      }
      const legacy = revision as EnvironmentRevision & { snapshot?: EnvironmentRevision["snapshot"] };
      return {
        channels: legacy.channels ?? [],
        createdAt: legacy.createdAt,
        environmentId: legacy.environmentId ?? "legacy-unknown",
        id: legacy.id,
        language: legacy.language,
        languageVersion: legacy.languageVersion,
        ...(legacy.localWheels?.length ? { localWheels: legacy.localWheels } : {}),
        packages: legacy.packages ?? [],
        packageSpecHash: legacy.packageSpecHash,
        platform: legacy.platform ?? "unknown",
        provisioner: legacy.provisioner ?? "legacy",
        runnerVersion: legacy.runnerVersion,
        snapshot: legacy.snapshot ?? { hash: legacy.packageSpecHash, size: 0 },
      };
    });
    if (!environmentRevisions.some((revision) => revision.id === DEFAULT_ENVIRONMENT_REVISION_ID)) {
      environmentRevisions.push(defaultEnvironmentRevision());
    }
    if (!environmentRevisions.some((revision) => revision.id === defaultShellEnvironmentRevision().id)) {
      environmentRevisions.push(defaultShellEnvironmentRevision());
    }
    const migratedEnvironmentRevisions = JSON.stringify(environmentRevisions) !== JSON.stringify(savedEnvironmentRevisions);
    const permissionEpochs = Array.isArray(saved.permissionEpochs) ? [...saved.permissionEpochs] : [];
    const savedPermissionGrants = Array.isArray(saved.permissionGrants) ? saved.permissionGrants : [];
    const permissionGrants = savedPermissionGrants
      .map((grant) => ({ ...grant, state: grant.state === "revoked" ? "revoked" as const : "active" as const }));
    const migratedPermissionGrants = JSON.stringify(permissionGrants) !== JSON.stringify(savedPermissionGrants);
    const permissionRequests = Array.isArray(saved.permissionRequests) ? saved.permissionRequests : [];
    const savedArtifacts = Array.isArray(saved.artifacts) ? saved.artifacts : [];
    const savedArtifactVersions = Array.isArray(saved.artifactVersions) ? saved.artifactVersions : [];
    const artifactAnnotations = Array.isArray(saved.artifactAnnotations) ? saved.artifactAnnotations : [];
    const savedSpecialists = Array.isArray(saved.specialists) ? saved.specialists : [];
    // Merge built-in specialists: user specialists from the saved catalog are
    // kept as-is; built-ins are re-seeded from the pinned definitions so their
    // instructions/description/name/connectorIds/enabledSkillIds stay
    // authoritative. Only the user's persisted `enabled` toggle is carried over
    // (every other field is overwritten by the pinned definition on each load,
    // so pinned upgrades always propagate).
    const specialists = [
      ...savedSpecialists.filter((specialist) => !specialist.builtIn),
      ...BUILTIN_SPECIALISTS.map((builtin) => {
        const existing = savedSpecialists.find((candidate) => candidate.id === builtin.id);
        return existing?.builtIn
          ? { ...structuredClone(builtin), ...(typeof existing.enabled === "boolean" ? { enabled: existing.enabled } : {}) }
          : { ...structuredClone(builtin) };
      }),
    ];
    const migratedSpecialists = JSON.stringify(specialists) !== JSON.stringify(savedSpecialists);
    const specialistIds = new Set(specialists.map((specialist) => specialist.id));
    const savedSubagents = Array.isArray(saved.subagents)
      ? saved.subagents
      : Array.isArray(saved.delegationTracks) ? saved.delegationTracks : [];
    const subagents = savedSubagents.flatMap((subagent) => {
      const normalized = normalizePersistedSubagent(subagent);
      return normalized ? [normalized] : [];
    });
    const migratedSubagents = !Array.isArray(saved.subagents)
      || JSON.stringify(subagents) !== JSON.stringify(savedSubagents);
    const savedRemoteHosts = Array.isArray(saved.remoteHosts) ? saved.remoteHosts : [];
    const remoteHosts = savedRemoteHosts.map(normalizePersistedRemoteHost);
    const migratedRemoteHosts = JSON.stringify(remoteHosts) !== JSON.stringify(savedRemoteHosts);
    const remoteJobs = Array.isArray(saved.remoteJobs) ? saved.remoteJobs : [];
    const remoteWorkspaceSyncs = Array.isArray(saved.remoteWorkspaceSyncs) ? saved.remoteWorkspaceSyncs : [];
    const timeoutSettings = saved.timeoutSettings === undefined
      ? structuredClone(this.initialTimeoutSettings)
      : normalizeTimeoutSettings(saved.timeoutSettings);
    const migratedQuotaSettings = saved.quotaSettings !== undefined
      && isRecord(saved.quotaSettings)
      && (saved.quotaSettings.uploadMaxFileBytes === undefined
        || saved.quotaSettings.uploadMaxRequestBytes === undefined);
    const quotaSettings = saved.quotaSettings === undefined
      ? structuredClone(this.initialQuotaSettings)
      : resolveQuotaSettings(saved.quotaSettings, this.initialQuotaSettings);
    const sandboxNetworkSettings = resolveSandboxNetworkSettings(
      saved.sandboxNetworkSettings,
      DEFAULT_SANDBOX_NETWORK_SETTINGS,
    );
    const webSettings = savedWebInput === undefined
      ? structuredClone(DEFAULT_WEB_SETTINGS)
      : normalizeWebSettings(savedWebInput);
    webSettings.proxyPolicy = migratedWebProxyPolicy ?? normalizeSavedProxyPolicy(webSettings.proxyPolicy);
    const environmentSourceSettings = normalizeEnvironmentSourceSettings(saved.environmentSourceSettings, false);
    const migratedEnvironmentSourceSettings = JSON.stringify(environmentSourceSettings)
      !== JSON.stringify(saved.environmentSourceSettings ?? null);
    const epochIds = new Set(permissionEpochs.map((epoch) => epoch.id));
    let migratedEpoch = false;
    let migratedSessionSettings = false;
    let migratedSessionAssignments = false;
    const savedSessions = Array.isArray(saved.sessions) ? saved.sessions : [];
    const sessions = savedSessions.map((session) => {
      let permissionEpochId = session.permissionEpochId;
      if (!permissionEpochId || !epochIds.has(permissionEpochId)) {
        const epoch = createPermissionEpoch(
          session.id,
          "Migrated from pre-M1 session",
          undefined,
          undefined,
          sandboxNetworkAccess(sandboxNetworkSettings),
        );
        permissionEpochs.push(epoch);
        epochIds.add(epoch.id);
        permissionEpochId = epoch.id;
        migratedEpoch = true;
      }
      if (!Array.isArray(session.enabledConnectorIds)
        || !Array.isArray(session.enabledSkillIds)
        || session.semanticReviewEnabled === undefined) migratedSessionSettings = true;
      const modelId = session.modelId && modelIds.has(session.modelId) ? session.modelId : fallbackModelId;
      const reviewModelId = session.reviewModelId && modelIds.has(session.reviewModelId)
        ? session.reviewModelId
        : modelId ?? fallbackModelId;
      if (modelId !== session.modelId || reviewModelId !== session.reviewModelId) migratedSessionAssignments = true;
      const enabledConnectorIds = Array.isArray(session.enabledConnectorIds)
        ? session.enabledConnectorIds.filter((id): id is ConnectorId => this.connectorIds.has(id))
        : [];
      // Compatibility mirror only; syncSessionCompatibility recomputes it after load.
      const enabledSkillIds = Array.isArray(session.enabledSkillIds)
        ? session.enabledSkillIds.filter((id): id is string => this.skillIds.has(id))
        : [];
      const semanticReviewEnabled = session.semanticReviewEnabled ?? true;
      const reviewerAutomaticReviewEnabled = typeof session.reviewerAutomaticReviewEnabled === "boolean"
        ? session.reviewerAutomaticReviewEnabled
        : true;
      const reviewerSpecialistLevel = isReviewerSpecialistLevel(session.reviewerSpecialistLevel)
        ? session.reviewerSpecialistLevel
        : DEFAULT_REVIEWER_SPECIALIST_LEVEL;
      const reviewCriteria = Array.isArray(session.reviewCriteria)
        ? session.reviewCriteria.filter((criterion): criterion is string => typeof criterion === "string").slice(0, 20)
        : [];
      const reviewMode = session.reviewMode === "manual" ? "manual" as const : "auto" as const;
      const settingsOverrides = isRecord(session.settingsOverrides)
        ? normalizeRuntimeSettings(session.settingsOverrides, modelIds, this.skillIds, false, this.connectorIds)
        : {
            enabledConnectorIds,
            ...(modelId ? { modelId } : {}),
            ...(reviewModelId ? { reviewModelId } : {}),
            semanticReviewEnabled,
          };
      const savedApproval = session as Omit<Session, "approvalMode"> & {
        approvalMode?: Session["approvalMode"] | "never_ask";
      };
      return {
        approvalMode: savedApproval.approvalMode === "always_allow"
          || savedApproval.approvalMode === "never_ask"
          ? "always_allow" as const
          : "ask_for_dangerous" as const,
        ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}),
        createdAt: session.createdAt,
        enabledConnectorIds,
        enabledSkillIds,
        id: session.id,
        modelId,
        permissionEpochId,
        projectId: session.projectId,
        reviewModelId,
        reviewCriteria,
        reviewMode,
        ...normalizePersistedSessionRemoteRunners(session),
        reviewerAutomaticReviewEnabled,
        reviewerSpecialistLevel,
        semanticReviewEnabled,
        settingsOverrides,
        ...(session.specialistId && specialistIds.has(session.specialistId) ? { specialistId: session.specialistId } : { specialistId: undefined }),
        title: session.title,
        updatedAt: session.updatedAt,
      } as Session;
    });
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const projectIds = new Set(projects.map((project) => project.id));
    const savedWorkspaceFileRecords = Array.isArray(saved.workspaceFileRecords) ? saved.workspaceFileRecords : [];
    const normalizedWorkspaceFileRecords = savedWorkspaceFileRecords
      .flatMap((value) => savedWorkspaceFileRecord(value) ?? [])
      .filter((record) => projectIds.has(record.projectId)
        && (!sessionsById.has(record.sessionId) || sessionsById.get(record.sessionId)?.projectId === record.projectId));
    const workspaceFileProjects = new Map(normalizedWorkspaceFileRecords.map((record) => [record.id, record.projectId]));
    const savedWorkspaceFileRevisions = Array.isArray(saved.workspaceFileRevisions) ? saved.workspaceFileRevisions : [];
    const normalizedWorkspaceFileRevisions = savedWorkspaceFileRevisions
      .flatMap((value) => savedWorkspaceFileRevision(value) ?? [])
      .filter((revision) => workspaceFileProjects.get(revision.fileId) === revision.projectId);
    const workspaceFileRevisionIds = new Set(normalizedWorkspaceFileRevisions.map((revision) => revision.id));
    const workspaceFileRecords = normalizedWorkspaceFileRecords
      .filter((record) => workspaceFileRevisionIds.has(record.currentRevisionId));
    const retainedWorkspaceFileRecordIds = new Set(workspaceFileRecords.map((record) => record.id));
    const workspaceFileRevisions = normalizedWorkspaceFileRevisions
      .filter((revision) => retainedWorkspaceFileRecordIds.has(revision.fileId));
    const migratedWorkspaceFileProvenance = !Array.isArray(saved.workspaceFileRecords)
      || !Array.isArray(saved.workspaceFileRevisions)
      || JSON.stringify(workspaceFileRecords) !== JSON.stringify(savedWorkspaceFileRecords)
      || JSON.stringify(workspaceFileRevisions) !== JSON.stringify(savedWorkspaceFileRevisions);
    const savedVersionsByArtifactId = new Map<string, ScientificArtifactVersion[]>();
    for (const version of savedArtifactVersions) {
      const values = savedVersionsByArtifactId.get(version.artifactId) ?? [];
      values.push(version);
      savedVersionsByArtifactId.set(version.artifactId, values);
    }
    const usedArtifactNames = new Set<string>();
    const artifacts = savedArtifacts.flatMap((savedArtifact) => {
      const legacy = savedArtifact as Partial<ScientificArtifact> & Pick<ScientificArtifact, "createdAt" | "currentVersion" | "id" | "kind" | "logicalName" | "sessionId" | "updatedAt">;
      const createdInSessionId = legacy.createdInSessionId ?? legacy.sessionId;
      const session = sessionsById.get(createdInSessionId);
      const projectId = legacy.projectId ?? session?.projectId;
      if (!projectId) return [];
      const deletedAt = typeof legacy.deletedAt === "string" && legacy.deletedAt ? legacy.deletedAt : undefined;
      const baseName = (legacy.name ?? legacy.logicalName).trim();
      let name = baseName;
      let key = `${projectId}\0${name}`;
      if (!deletedAt) {
        if (usedArtifactNames.has(key)) {
          name = `${baseName} (s-${createdInSessionId.slice(0, 8)})`;
          key = `${projectId}\0${name}`;
          if (usedArtifactNames.has(key)) name = `${name}-${legacy.id.slice(0, 8)}`;
        }
        usedArtifactNames.add(`${projectId}\0${name}`);
      }
      const firstVersion = savedVersionsByArtifactId.get(legacy.id)?.toSorted((left, right) => left.version - right.version)[0];
      const origin: ArtifactOrigin = legacy.origin
        ?? (firstVersion?.executionRunIds?.length ? "legacy_auto" : "user_upload");
      return [{
        createdAt: legacy.createdAt,
        createdInSessionId,
        createdInSessionTitle: legacy.createdInSessionTitle ?? session?.title ?? "Deleted Session",
        currentVersion: legacy.currentVersion,
        ...(deletedAt ? { deletedAt } : {}),
        ...(legacy.description ? { description: legacy.description } : {}),
        id: legacy.id,
        // `.json` entries recorded before JSON had its own kind are stored as
        // "dataset"; upgrade them on load so preview routing, the kind icon and
        // the "kind cannot change across versions" guard all agree.
        kind: resolveScientificArtifactKind(legacy.kind, name),
        logicalName: name,
        name,
        origin,
        ...(legacy.originMeta ? { originMeta: structuredClone(legacy.originMeta) } : {}),
        projectId,
        sessionId: createdInSessionId,
        ...(legacy.title ? { title: legacy.title } : {}),
        updatedAt: legacy.updatedAt,
      } satisfies ScientificArtifact];
    });
    const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    const artifactVersions = savedArtifactVersions.flatMap((savedVersion) => {
      const artifact = artifactsById.get(savedVersion.artifactId);
      if (!artifact) return [];
      return [{
        ...savedVersion,
        projectId: savedVersion.projectId ?? artifact.projectId,
        ...(savedVersion.sourcePath ? { sourcePath: savedVersion.sourcePath } : { sourcePath: artifact.logicalName }),
      } satisfies ScientificArtifactVersion];
    });
    const migratedArtifactCatalog = JSON.stringify(artifacts) !== JSON.stringify(savedArtifacts)
      || JSON.stringify(artifactVersions) !== JSON.stringify(savedArtifactVersions);
    const savedReviewerSpecialistLevel: unknown = saved.reviewerSpecialistLevel;
    const reviewerSpecialistLevel = savedReviewerSpecialistLevel === "smart"
      ? "deep"
      : isReviewerSpecialistLevel(savedReviewerSpecialistLevel)
        ? savedReviewerSpecialistLevel
        : DEFAULT_REVIEWER_SPECIALIST_LEVEL;
    const migratedReviewerSpecialistLevel = saved.reviewerSpecialistLevel !== reviewerSpecialistLevel;
    const savedReviewerFeedbackPolicy: unknown = saved.reviewerSpecialistFeedbackPolicy;
    const reviewerSpecialistFeedbackPolicy = isReviewerFeedbackPolicy(savedReviewerFeedbackPolicy)
      ? savedReviewerFeedbackPolicy
      : DEFAULT_REVIEWER_FEEDBACK_POLICY;
    const migratedReviewerFeedbackPolicy = saved.reviewerSpecialistFeedbackPolicy !== reviewerSpecialistFeedbackPolicy;
    this.catalog = {
      artifactAnnotations,
      artifactVersions,
      artifacts,
      subagents,
      environments,
      environmentRevisions,
      environmentSourceSettings,
      globalSettings,
      ideaTreeSettings,
      mcpProxyPolicies,
      memoryGraphSettings,
      models,
      permissionEpochs,
      permissionGrants,
      permissionRequests,
      projects,
      providers,
      proxyDefaultPolicy,
      proxyServers,
      quotaSettings,
      sandboxNetworkSettings,
      reviewerSpecialistEnabled: saved.reviewerSpecialistEnabled === true,
      reviewerSpecialistFeedbackPolicy,
      reviewerSpecialistLevel,
      remoteHosts,
      remoteJobs,
      remoteWorkspaceSyncs,
      sessions,
      specialists,
      timeoutSettings,
      webSettings,
      workspaceFileRecords,
      workspaceFileRevisions,
    };
    for (const session of sessions) this.syncSessionCompatibility(session);
    const migratedSessionOverrides = JSON.stringify(sessions) !== JSON.stringify(savedSessions);
    if (!Array.isArray(saved.models)
      || !Array.isArray(saved.providers)
      || migratedProviders
      || !Array.isArray(saved.artifacts)
      || !Array.isArray(saved.artifactVersions)
      || !Array.isArray(saved.artifactAnnotations)
      || !Array.isArray(saved.environments)
      || !Array.isArray(saved.environmentRevisions)
      || !Array.isArray(saved.permissionEpochs)
      || !Array.isArray(saved.permissionGrants)
      || !Array.isArray(saved.permissionRequests)
      || !Array.isArray(saved.subagents)
      || !Array.isArray(saved.remoteHosts)
      || !Array.isArray(saved.remoteJobs)
      || !Array.isArray(saved.remoteWorkspaceSyncs)
      || !Array.isArray(saved.specialists)
      || saved.timeoutSettings === undefined
      || saved.quotaSettings === undefined
      || saved.sandboxNetworkSettings === undefined
      || migratedQuotaSettings
      || saved.webSettings === undefined
      || migratedEnvironmentSourceSettings
      || migratedProxySettings
      || migratedModels
      || migratedHierarchicalSettings
      || migratedMemoryGraphSettings
      || migratedIdeaTreeSettings
      || migratedEnvironmentRevisions
      || migratedEpoch
      || migratedSessionSettings
      || migratedSessionAssignments
      || migratedSessionOverrides
      || migratedSubagents
      || migratedPermissionGrants
      || migratedReviewerSpecialistLevel
      || migratedReviewerFeedbackPolicy
      || migratedSpecialists
      || migratedArtifactCatalog
      || migratedWorkspaceFileProvenance
      || migratedRemoteHosts
      || importedLegacyCatalog
    ) {
      await this.saveCatalog();
    }
    await this.recoverTrashOperations();
    this.loaded = true;
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
    this.secretKey = undefined;
    this.loaded = false;
  }

  private async saveCatalog(): Promise<void> {
    const content = JSON.stringify(this.catalog);
    this.saveQueue = this.saveQueue.then(() => {
      if (!this.database) throw new Error("Catalog database is not initialized");
      this.database.prepare("INSERT INTO catalog_state (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(content);
    });
    await this.saveQueue;
  }

  private async withSubagentMutation<T>(subagentId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.subagentMutationQueues.get(subagentId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const queued = previous.then(() => next, () => next);
    this.subagentMutationQueues.set(subagentId, queued);
    try {
      await previous.catch(() => {});
      return await mutation();
    } finally {
      release();
      if (this.subagentMutationQueues.get(subagentId) === queued) {
        this.subagentMutationQueues.delete(subagentId);
      }
    }
  }

  private async withWorkspaceFileMutation<T>(sessionId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.workspaceFileMutationQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const queued = previous.then(() => next, () => next);
    this.workspaceFileMutationQueues.set(sessionId, queued);
    try {
      await previous.catch(() => {});
      return await mutation();
    } finally {
      release();
      if (this.workspaceFileMutationQueues.get(sessionId) === queued) {
        this.workspaceFileMutationQueues.delete(sessionId);
      }
    }
  }

  private async saveCatalogWithAuthorizations(authorizations: PermissionAuthorization[]): Promise<void> {
    const content = JSON.stringify(this.catalog);
    const records = structuredClone(authorizations);
    this.saveQueue = this.saveQueue.then(() => {
      if (!this.database) throw new Error("Catalog database is not initialized");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare(
          "INSERT INTO catalog_state (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
        ).run(content);
        const insert = this.database.prepare(`
          INSERT INTO permission_authorizations
            (id, session_id, project_id, execution_id, created_at, record_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const authorization of records) {
          insert.run(
            authorization.id,
            authorization.sessionId,
            authorization.projectId,
            authorization.executionId ?? null,
            authorization.createdAt,
            JSON.stringify(authorization),
          );
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    });
    await this.saveQueue;
  }

  private async appendPermissionAuthorizations(authorizations: PermissionAuthorization[]): Promise<void> {
    const records = structuredClone(authorizations);
    this.saveQueue = this.saveQueue.then(() => {
      if (!this.database) throw new Error("Catalog database is not initialized");
      const insert = this.database.prepare(`
        INSERT INTO permission_authorizations
          (id, session_id, project_id, execution_id, created_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const authorization of records) {
        insert.run(
          authorization.id,
          authorization.sessionId,
          authorization.projectId,
          authorization.executionId ?? null,
          authorization.createdAt,
          JSON.stringify(authorization),
        );
      }
    });
    await this.saveQueue;
  }

  private messagesPath(sessionId: string): string {
    return resolve(this.dataDir, "messages", `${sessionId}.json`);
  }

  private executionRunsPath(sessionId: string): string {
    return resolve(this.dataDir, "execution-runs", `${sessionId}.json`);
  }

  private sessionRunsPath(sessionId: string): string {
    return resolve(this.dataDir, "session-runs", `${sessionId}.json`);
  }

  /** Pre-stream layout: one JSON array per run. Read-only since the JSONL streams landed. */
  private sessionRunEventsPath(sessionId: string, runId: string): string {
    return resolve(this.dataDir, "run-events", sessionId, `${runId}.json`);
  }

  private runStreamDir(sessionId: string, runId: string): string {
    return resolve(this.dataDir, "run-events", sessionId, runId);
  }

  private runStreamPath(sessionId: string, runId: string, streamId: string): string {
    return resolve(this.runStreamDir(sessionId, runId), `${streamId}.jsonl`);
  }

  private artifactDerivationsPath(sessionId: string): string {
    return resolve(this.dataDir, "artifact-derivations", `${sessionId}.json`);
  }

  private artifactPlansPath(sessionId: string): string {
    return resolve(this.dataDir, "artifact-plans", `${sessionId}.json`);
  }

  private artifactJobsPath(sessionId: string): string {
    return resolve(this.dataDir, "artifact-jobs", `${sessionId}.json`);
  }

  private artifactExtractionJobsPath(sessionId: string): string {
    return resolve(this.dataDir, "artifact-extraction-jobs", `${sessionId}.json`);
  }

  private promptManifestsPath(sessionId: string): string {
    return resolve(this.dataDir, "prompt-manifests", `${sessionId}.json`);
  }

  private modelUsagePath(sessionId: string): string {
    return resolve(this.dataDir, "model-usage", `${sessionId}.json`);
  }

  private reviewsPath(sessionId: string): string {
    return resolve(this.dataDir, "reviews", `${sessionId}.json`);
  }

  private artifactReviewsPath(sessionId: string): string {
    return resolve(this.dataDir, "artifact-reviews", `${sessionId}.json`);
  }

  private reviewerAuditTasksPath(sessionId: string): string {
    return resolve(this.dataDir, "reviewer-audit-tasks", `${sessionId}.json`);
  }

  private reviewFeedbackPath(sessionId: string): string {
    return resolve(this.dataDir, "review-feedback", `${sessionId}.json`);
  }

  private paperAcquisitionsPath(sessionId: string): string {
    return resolve(this.dataDir, "paper-acquisitions", `${sessionId}.json`);
  }

  private paperVisionRunsPath(sessionId: string): string {
    return resolve(this.dataDir, "paper-vision-runs", `${sessionId}.json`);
  }

  private claimsPath(sessionId: string): string {
    return resolve(this.dataDir, "claims", `${sessionId}.json`);
  }

  private evidenceLinksPath(sessionId: string): string {
    return resolve(this.dataDir, "evidence-links", `${sessionId}.json`);
  }

  private evidenceItemsPath(sessionId: string): string {
    return resolve(this.dataDir, "evidence-items", `${sessionId}.json`);
  }

  private mcpInvocationsPath(sessionId: string): string {
    return resolve(this.dataDir, "mcp-invocations", `${sessionId}.json`);
  }

  private knownSessionDataPaths(session: Session): string[] {
    return [
      this.messagesPath(session.id),
      this.executionRunsPath(session.id),
      this.sessionRunsPath(session.id),
      resolve(this.dataDir, "run-events", session.id),
      this.artifactDerivationsPath(session.id),
      this.artifactPlansPath(session.id),
      this.artifactJobsPath(session.id),
      this.artifactExtractionJobsPath(session.id),
      this.promptManifestsPath(session.id),
      this.modelUsagePath(session.id),
      this.reviewsPath(session.id),
      this.artifactReviewsPath(session.id),
      this.reviewerAuditTasksPath(session.id),
      this.reviewFeedbackPath(session.id),
      this.paperAcquisitionsPath(session.id),
      this.paperVisionRunsPath(session.id),
      this.claimsPath(session.id),
      this.evidenceLinksPath(session.id),
      this.evidenceItemsPath(session.id),
      this.mcpInvocationsPath(session.id),
      toolOutputStoreRoot(this.dataDir, session.id),
      resolve(this.dataDir, "projects", session.projectId, "sessions", session.id),
    ];
  }

  sessionDataPaths(sessionId: string): string[] {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return this.knownSessionDataPaths(session);
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async rollbackStagedDeletion(operation: StagedDeletion): Promise<void> {
    for (const entry of operation.entries.toReversed()) {
      if (!await this.pathExists(entry.staged)) continue;
      if (await this.pathExists(entry.source)) {
        throw new Error(`Cannot restore staged data because ${entry.source} already exists`);
      }
      await mkdir(dirname(entry.source), { recursive: true });
      await rename(entry.staged, entry.source);
    }
  }

  private async deletionWorkspaceRoots(scopes: string[]): Promise<string[]> {
    const roots: string[] = [];
    for (const session of this.catalog.sessions) {
      const root = this.workspacePath(session.id);
      if (!scopes.some((scope) => root.startsWith(`${scope}/`) || root === scope)) continue;
      if (await this.pathExists(root)) roots.push(root);
      const children = resolve(root, "..", "agent-workspaces");
      if (await this.pathExists(children)) {
        for (const child of await readdir(children, { withFileTypes: true })) {
          if (child.isDirectory()) roots.push(resolve(children, child.name));
        }
      }
    }
    return roots;
  }

  private async withDeletionBoundary<T>(paths: () => string[], sessionIds: () => string[], scopes: string[],
    action: (operation: StagedDeletion) => Promise<T>, projectId?: string): Promise<T> {
    const root = resolve(this.dataDir, ".trash", randomUUID());
    const operation: StagedDeletion = { entries: [], root, sessionIds: sessionIds(), scopes, projectId };
    // The recovery journal must exist before admission closes, including a crash
    // before the first rename. Coordination itself lives outside these paths.
    await mkdir(root, { recursive: true });
    await writeFile(resolve(root, "operation.json"), `${JSON.stringify(operation, null, 2)}\n`, "utf8");
    let restored = false;
    try {
      const versions = new VersionStore(this.dataDir);
      return await withWorkspaceRetirement(versions, scopes, root, async (roots, reopen) => {
        try {
          // Creation admitted before the fence must finish before enumerating
          // Session roots and catalog IDs; otherwise a new Session is orphaned.
          const distinct = [...new Set(paths())];
          operation.sessionIds = sessionIds();
          for (const source of distinct.filter((path) => !distinct.some((parent) => parent !== path && path.startsWith(`${parent}/`)))) {
            if (!await this.pathExists(source)) continue;
            const relativePath = relative(this.dataDir, source);
            if (!relativePath || relativePath.startsWith("..")) throw new Error("Deletion path escaped the data directory");
            operation.entries.push({ source, staged: resolve(root, "data", relativePath) });
          }
          await writeFile(resolve(root, "operation.next.json"), `${JSON.stringify(operation, null, 2)}\n`, "utf8");
          await rename(resolve(root, "operation.next.json"), resolve(root, "operation.json"));
          for (const workspace of roots) {
            if (await this.pathExists(workspace)) await this.mutateWorkspace(workspace, "pre-deletion", async () => {});
          }
          return await action(operation);
        } catch (error) {
          if (operation.committed) throw error;
          try { await this.rollbackStagedDeletion(operation); }
          catch (rollbackError) { throw new AggregateError([error, rollbackError], "Deletion and rollback both failed"); }
          restored = true;
          reopen();
          throw error;
        }
      }, () => this.deletionWorkspaceRoots(scopes));
    } finally {
      if (restored) await this.finishStagedDeletion(operation);
    }
  }

  private async stageDeletion(operation: StagedDeletion): Promise<void> {
    for (const entry of operation.entries) {
      await mkdir(dirname(entry.staged), { recursive: true });
      await rename(entry.source, entry.staged);
    }
  }

  private async finishStagedDeletion(operation: StagedDeletion): Promise<void> {
    try {
      await rm(operation.root, { force: true, recursive: true });
    } catch (error) {
      console.warn(`Could not clean deletion staging directory ${operation.root}:`, error);
    }
  }

  private async recoverTrashOperations(): Promise<void> {
    const trashRoot = resolve(this.dataDir, ".trash");
    let directories;
    try {
      directories = await readdir(trashRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const directory of directories.filter((entry) => entry.isDirectory())) {
      const root = resolve(trashRoot, directory.name);
      try {
        const operation = JSON.parse(await readFile(resolve(root, "operation.json"), "utf8")) as StagedDeletion;
        const valid = Array.isArray(operation.entries)
          && Array.isArray(operation.sessionIds)
          && operation.entries.every((entry) => {
            const source = resolve(entry.source);
            const staged = resolve(entry.staged);
            return source.startsWith(`${this.dataDir}/`) && staged.startsWith(`${root}/`);
          });
        if (!valid) throw new Error("Invalid deletion operation manifest");
        operation.root = root;
        const scopes = operation.scopes ?? operation.entries.map((entry) => entry.source);
        if (!scopes.every((scope) => resolve(scope).startsWith(`${this.dataDir}/`))) throw new Error("Invalid deletion scope");
        await withWorkspaceRetirement(new VersionStore(this.dataDir), scopes, root, async (_roots, reopen) => {
          const catalogStillReferencesData = operation.sessionIds.some((id) => Boolean(this.getSession(id)))
            || Boolean(operation.projectId && this.getProject(operation.projectId));
          if (catalogStillReferencesData) { await this.rollbackStagedDeletion(operation); reopen(); }
          else await this.finishStagedDeletion(operation);
        }, () => this.deletionWorkspaceRoots(scopes));
        await this.finishStagedDeletion(operation);
      } catch (error) {
        console.warn(`Could not recover deletion staging directory ${root}:`, error);
      }
    }
  }

  private async readArray<T>(path: string): Promise<T[]> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeArray(path: string, values: unknown[]): Promise<void> {
    const directory = dirname(path);
    const temporaryPath = resolve(directory, `.state-${process.pid}-${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(values, null, 2)}\n`, "utf8");
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async mutateArray<T, R>(
    path: string,
    operation: (values: T[]) => R | Promise<R>,
  ): Promise<R> {
    const previous = this.arrayMutationQueues.get(path) ?? Promise.resolve();
    const mutation = previous.then(async () => {
      const values = await this.readArray<T>(path);
      const result = await operation(values);
      await this.writeArray(path, values);
      return result;
    });
    const barrier = mutation.then(() => undefined, () => undefined);
    this.arrayMutationQueues.set(path, barrier);
    try {
      return await mutation;
    } finally {
      if (this.arrayMutationQueues.get(path) === barrier) this.arrayMutationQueues.delete(path);
    }
  }

  private normalizeSettings(value: unknown): RuntimeSettingsOverrides {
    return normalizeRuntimeSettings(value, new Set(this.catalog.models.map((model) => model.id)), this.skillIds, true, this.connectorIds);
  }

  setCustomConnectorIds(ids: Iterable<string>): void {
    this.connectorIds = new Set([...knownConnectorIdSet(), ...ids]);
  }

  async removeCustomConnectorReferences(id: string): Promise<void> {
    if (!/^custom-[a-f0-9]{12}$/.test(id)) throw new Error("Not a custom MCP connector");
    for (const settings of [this.catalog.globalSettings, ...this.catalog.projects.map((item) => item.settingsOverrides), ...this.catalog.sessions.map((item) => item.settingsOverrides)]) {
      if (settings.enabledConnectorIds) settings.enabledConnectorIds = settings.enabledConnectorIds.filter((value) => value !== id);
    }
    for (const specialist of this.catalog.specialists) specialist.connectorIds = specialist.connectorIds.filter((value) => value !== id);
    this.syncSessionCompatibilityForProject();
    await this.saveCatalog();
  }

  setAvailableSkillIds(ids: Iterable<string>): void {
    this.skillIds = new Set(ids);
    // In `all` mode the effective set is the catalog itself, so installing or
    // deleting a skill changes every Session mirror.
    this.syncSessionCompatibilityForProject();
  }

  /**
   * Only Project and Session layers whitelist skills, and only while their
   * resolved mode is `selected` — an `all`-mode layer runs on the live catalog,
   * so a stored list there is inert and must not block deletion.
   */
  getSkillDeletionImpact(skillId: string): SkillDeletionImpact {
    const references: SkillDeletionImpact["references"] = [];
    for (const project of this.catalog.projects) {
      if (!project.settingsOverrides.enabledSkillIds?.includes(skillId)) continue;
      const mode = this.resolveSettingsLayers(this.projectSettingsLayers(project)).effective.skillSelectionMode;
      if (mode === "selected") references.push({ id: project.id, label: project.name, scope: "project" });
    }
    for (const session of this.catalog.sessions) {
      if (!session.settingsOverrides.enabledSkillIds?.includes(skillId)) continue;
      const mode = this.resolveRuntimeSettings(session.id).effective.skillSelectionMode;
      if (mode === "selected") references.push({ id: session.id, label: session.title, scope: "session" });
    }
    return { references, skillId };
  }

  private resolveSettingsLayers(
    layers: Array<{ overrides: RuntimeSettingsOverrides; source: Exclude<RuntimeSettingsSource, "unset"> }>,
  ): ResolvedRuntimeSettings {
    const effective: ResolvedRuntimeSettings["effective"] = {
      enabledConnectorIds: [],
      enabledSkillLibraries: [],
      enabledSkillIds: [],
      semanticReviewEnabled: true,
      skillSelectionMode: DEFAULT_SKILL_SELECTION_MODE,
    };
    const sources = Object.fromEntries(
      RUNTIME_SETTINGS_FIELDS.map((field) => [field, "unset"]),
    ) as Record<RuntimeSettingsField, RuntimeSettingsSource>;

    for (const { overrides, source } of layers) {
      for (const field of RUNTIME_SETTINGS_FIELDS) {
        // Skill selection is a Project/Session concern; the Global layer never contributes.
        if (source === "global" && SKILL_SELECTION_FIELDS.includes(field)) continue;
        if (!hasOwn(overrides, field)) continue;
        const value = overrides[field];
        if (value === undefined) continue;
        if (field === "enabledConnectorIds") effective.enabledConnectorIds = [...value as ConnectorId[]];
        else if (field === "enabledSkillLibraries") effective.enabledSkillLibraries = structuredClone(value) as EffectiveRuntimeSettings["enabledSkillLibraries"];
        else if (field === "enabledSkillIds") effective.enabledSkillIds = [...value as string[]];
        else if (field === "semanticReviewEnabled") effective.semanticReviewEnabled = value as boolean;
        else if (field === "skillSelectionMode") effective.skillSelectionMode = value as SkillSelectionMode;
        else if (field === "thinkingMode") effective.thinkingMode = value as ModelThinkingMode;
        else if (field === "thinkingEffort") effective.thinkingEffort = value as ModelThinkingEffort;
        else effective[field] = value as string;
        sources[field] = source;
      }
    }

    // `all` (the default) means the whole installed catalog; `selected` intersects
    // the stored whitelist with what is still installed.
    if (effective.skillSelectionMode === "all") {
      effective.enabledSkillIds = [...this.skillIds];
      sources.enabledSkillIds = sources.skillSelectionMode;
    } else {
      effective.enabledSkillIds = effective.enabledSkillIds.filter((id) => this.skillIds.has(id));
    }
    return { effective, sources };
  }

  private projectSettingsLayers(project: Project) {
    return [
      { overrides: this.catalog.globalSettings, source: "global" as const },
      { overrides: project.settingsOverrides, source: "project" as const },
    ];
  }

  private syncSessionCompatibility(session: Session): void {
    const { effective } = this.resolveRuntimeSettings(session.id);
    session.enabledConnectorIds = [...effective.enabledConnectorIds];
    session.enabledSkillIds = [...effective.enabledSkillIds];
    session.modelId = effective.modelId;
    session.reviewModelId = effective.reviewModelId;
    session.semanticReviewEnabled = effective.semanticReviewEnabled;
    session.thinkingEffort = effective.thinkingEffort;
    session.thinkingMode = effective.thinkingMode;
  }

  private syncSessionCompatibilityForProject(projectId?: string): void {
    for (const session of this.catalog.sessions) {
      if (!projectId || session.projectId === projectId) this.syncSessionCompatibility(session);
    }
  }

  getGlobalSettings(): RuntimeSettingsDetails {
    return {
      overrides: structuredClone(this.catalog.globalSettings),
      ...this.resolveSettingsLayers([
        { overrides: this.catalog.globalSettings, source: "global" },
      ]),
    };
  }

  /** The policy new Permission Epochs snapshot. */
  private currentSandboxNetworkAccess(): SandboxNetworkAccess {
    return sandboxNetworkAccess(this.catalog.sandboxNetworkSettings);
  }

  getSandboxNetworkSettings(): SandboxNetworkSettings {
    return structuredClone(this.catalog.sandboxNetworkSettings);
  }

  /**
   * Save the sandbox network policy and rotate the Permission Epoch of every
   * writable Session whose snapshot no longer matches. Rotation is what makes
   * the change take effect: the epoch id is part of the runner's persistent
   * kernel and shell reuse key, so sessions started under the old policy can
   * never serve an execution granted under the new one.
   */
  async replaceSandboxNetworkSettings(value: unknown): Promise<{
    rotatedSessionIds: string[];
    settings: SandboxNetworkSettings;
  }> {
    const settings = normalizeSandboxNetworkSettings(value);
    // Same guard the other policy surfaces use: reject a dangling reference at
    // save time rather than letting every later execution fail closed on it.
    this.assertProxyPolicyKnown(settings.egressProxyPolicy, "egressProxyPolicy");
    this.catalog.sandboxNetworkSettings = settings;
    const access = this.currentSandboxNetworkAccess();
    const rotatedSessionIds: string[] = [];
    for (const session of this.catalog.sessions) {
      if (session.archivedAt) continue;
      const current = this.getPermissionEpoch(session.permissionEpochId);
      if (current && epochSandboxNetworkAccess(current).revision === access.revision) continue;
      const epoch = createPermissionEpoch(
        session.id,
        "Sandbox network access policy changed",
        "Sandbox network access policy changed; persistent kernel and shell memory was lost",
        current?.executeGrantScope,
        access,
      );
      this.catalog.permissionEpochs.push(epoch);
      session.permissionEpochId = epoch.id;
      session.updatedAt = epoch.createdAt;
      rotatedSessionIds.push(session.id);
    }
    await this.saveCatalog();
    return { rotatedSessionIds, settings: this.getSandboxNetworkSettings() };
  }

  getTimeoutSettings(): SystemTimeoutSettings {
    return structuredClone(this.catalog.timeoutSettings);
  }

  getQuotaSettings(): SystemQuotaSettings {
    return structuredClone(this.catalog.quotaSettings);
  }

  getEnvironmentSourceSettings(): EnvironmentSourceSettings {
    return structuredClone(this.catalog.environmentSourceSettings);
  }

  async updateEnvironmentSourceSettings(
    input: UpdateEnvironmentSourceSettingsRequest,
  ): Promise<EnvironmentSourceSettings> {
    const next = normalizeEnvironmentSourceSettings({
      ...this.catalog.environmentSourceSettings,
      ...input,
    });
    this.catalog.environmentSourceSettings = next;
    await this.saveCatalog();
    return this.getEnvironmentSourceSettings();
  }

  getReviewerSpecialistSettings(): ReviewerSpecialistSettings {
    return {
      enabled: this.catalog.reviewerSpecialistEnabled,
      feedbackPolicy: this.catalog.reviewerSpecialistFeedbackPolicy,
    };
  }

  async updateReviewerSpecialistSettings(value: unknown): Promise<ReviewerSpecialistSettings> {
    if (!isRecord(value) || typeof value.enabled !== "boolean") {
      throw new Error("Reviewer Specialist enabled must be a boolean");
    }
    if (value.feedbackPolicy !== undefined && !isReviewerFeedbackPolicy(value.feedbackPolicy)) {
      throw new Error("Reviewer Specialist feedback policy must be record, explain, suggest, or repair");
    }
    this.catalog.reviewerSpecialistEnabled = value.enabled;
    if (value.feedbackPolicy !== undefined) this.catalog.reviewerSpecialistFeedbackPolicy = value.feedbackPolicy;
    await this.saveCatalog();
    return this.getReviewerSpecialistSettings();
  }

  getSessionReviewerSpecialistSettings(sessionId: string): SessionReviewerSpecialistSettings {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return {
      automaticReviewEnabled: session.reviewerAutomaticReviewEnabled,
      level: session.reviewerSpecialistLevel,
    };
  }

  async updateSessionReviewerSpecialistSettings(
    sessionId: string,
    value: unknown,
  ): Promise<SessionReviewerSpecialistSettings> {
    if (!isRecord(value) || typeof value.automaticReviewEnabled !== "boolean") {
      throw new Error("Reviewer Specialist automatic review must be a boolean");
    }
    if (!isReviewerSpecialistLevel(value.level)) {
      throw new Error("Reviewer Specialist level must be quick or deep");
    }
    const session = this.assertSessionWritable(sessionId);
    session.reviewerAutomaticReviewEnabled = value.automaticReviewEnabled;
    session.reviewerSpecialistLevel = value.level;
    session.updatedAt = new Date().toISOString();
    await this.saveCatalog();
    return this.getSessionReviewerSpecialistSettings(sessionId);
  }

  getWebSettings(): WebSettingsDetails {
    if (!this.database) throw new Error("Catalog database is not initialized");
    const configured = new Set(
      (this.database.prepare("SELECT provider FROM web_provider_secrets").all() as Array<{ provider: string }>)
        .map((row) => row.provider),
    );
    return {
      ...structuredClone(this.catalog.webSettings),
      providers: (["jina", "tavily", "exa", "brave"] as const).map((provider) => ({
        hasApiKey: configured.has(provider),
        provider,
      })),
    };
  }

  getWebProviderApiKey(provider: "brave" | "exa" | "jina" | "tavily"): string | undefined {
    if (!this.database) return undefined;
    const row = this.database.prepare("SELECT encrypted_token FROM web_provider_secrets WHERE provider = ?")
      .get(provider) as { encrypted_token: string } | undefined;
    return row ? this.decryptModelApiToken(`web:${provider}`, row.encrypted_token) : undefined;
  }

  async updateWebSettings(input: UpdateWebSettingsRequest): Promise<WebSettingsDetails> {
    const { providerApiKeys, ...settingsInput } = input;
    const nextSettings = normalizeWebSettings({ ...this.catalog.webSettings, ...settingsInput });
    this.assertProxyPolicyKnown(nextSettings.proxyPolicy, "proxyPolicy");
    const normalizedApiKeys = new Map<"brave" | "exa" | "jina" | "tavily", string | null>();
    if (providerApiKeys) {
      for (const provider of ["brave", "exa", "jina", "tavily"] as const) {
        if (!(provider in providerApiKeys)) continue;
        const value = providerApiKeys[provider];
        normalizedApiKeys.set(provider, value === null ? null : normalizeApiToken(value) ?? null);
      }
    }
    if (normalizedApiKeys.size && !this.database) throw new Error("Catalog database is not initialized");
    this.catalog.webSettings = nextSettings;
    for (const [provider, value] of normalizedApiKeys) {
      if (value === null) {
        this.database!.prepare("DELETE FROM web_provider_secrets WHERE provider = ?").run(provider);
      } else {
        const encrypted = this.encryptModelApiToken(`web:${provider}`, value);
        this.database!.prepare(
          "INSERT INTO web_provider_secrets (provider, encrypted_token) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET encrypted_token = excluded.encrypted_token",
        ).run(provider, encrypted);
      }
    }
    await this.saveCatalog();
    return this.getWebSettings();
  }

  // --- Global proxy registry (the configuration side of the network base) ---

  private getProxyServer(serverId: string): ProxyServer | undefined {
    return this.catalog.proxyServers.find((server) => server.id === serverId);
  }

  /** Reject policies that point at a proxy server missing from the registry. */
  private assertProxyPolicyKnown(policy: ProxyPolicy, field: string): void {
    if (!policy.startsWith("proxy:")) return;
    const serverId = policy.slice("proxy:".length);
    if (!this.getProxyServer(serverId)) {
      throw new Error(`${field} references an unknown proxy server`);
    }
  }

  private proxyRegistryView(): ProxyRegistryView {
    return {
      defaultPolicy: this.catalog.proxyDefaultPolicy,
      getServerKind: (serverId) => this.getProxyServer(serverId)?.kind,
      getServerUrl: (serverId) => this.getProxyServerUrl(serverId),
    };
  }

  /** Resolve a module policy (undefined behaves like "inherit") into the
   *  transport-agnostic instruction consumed by outbound callers. */
  resolveProxy(policy?: ProxyPolicy): ResolvedProxy {
    return resolveProxyPolicy(policy, this.proxyRegistryView());
  }

  /**
   * The outbound route the egress gateway should use for one execution, taken
   * from the policy that execution's Permission Epoch snapshotted rather than
   * from the current settings — the epoch is what was granted.
   *
   * Returns `undefined` for a sandbox with no network, so an unrelated proxy
   * misconfiguration cannot fail an execution that never dials out. The result
   * is resolved per execution and never written into the epoch: a custom proxy
   * URL is stored encrypted and must not reach the persisted catalog.
   */
  resolveSandboxEgressProxy(epoch: PermissionEpoch): ResolvedProxy | undefined {
    const access = epochSandboxNetworkAccess(epoch);
    if (access.mode !== "domain-allowlist") return undefined;
    return this.resolveProxy(access.egressProxyPolicy);
  }

  /** Construct the authenticated settings projection without ever attaching a
   *  decrypted URL to the persisted catalog object. */
  private proxyServerSettingsView(
    server: ProxyServer,
    environment?: ProxyServer["environment"],
  ): ProxyServer {
    const view: ProxyServer = {
      createdAt: server.createdAt,
      hasUrl: server.hasUrl,
      id: server.id,
      kind: server.kind,
      name: server.name,
      updatedAt: server.updatedAt,
    };
    if (server.kind === "custom_url") {
      const url = this.getProxyServerUrl(server.id);
      if (url) view.url = url;
    }
    if (server.kind === "environment" && environment) view.environment = environment;
    return view;
  }

  getProxySettings(): ProxySettingsDetails {
    const environment = proxyEnvironmentDetails(resolveProxyEnvironment());
    return {
      defaultPolicy: this.catalog.proxyDefaultPolicy,
      servers: this.catalog.proxyServers
        .map((server) => this.proxyServerSettingsView(server, environment))
        .toSorted((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
    };
  }

  /** Decrypt the stored URL of a custom_url entry (server-internal only). */
  getProxyServerUrl(serverId: string): string | undefined {
    if (!this.database) return undefined;
    const row = this.database.prepare("SELECT encrypted_url FROM proxy_server_secrets WHERE server_id = ?")
      .get(serverId) as { encrypted_url: string } | undefined;
    return row ? this.decryptModelApiToken(`proxy:${serverId}`, row.encrypted_url) : undefined;
  }

  async updateProxySettings(input: UpdateProxySettingsRequest): Promise<ProxySettingsDetails> {
    const defaultPolicy = normalizeProxyDefaultPolicy(isRecord(input) ? input.defaultPolicy : undefined);
    this.assertProxyPolicyKnown(defaultPolicy, "defaultPolicy");
    this.catalog.proxyDefaultPolicy = defaultPolicy;
    await this.saveCatalog();
    return this.getProxySettings();
  }

  async createProxyServer(input: CreateProxyServerRequest): Promise<ProxyServer> {
    if (!PROXY_SERVER_KINDS.has(input.kind)) {
      throw new Error("Proxy server kind must be custom_url, environment, or system");
    }
    const name = requiredLabel(input.name, "Proxy server name");
    if (this.catalog.proxyServers.length >= 50) throw new Error("At most 50 proxy servers can be configured");
    if (!this.database) throw new Error("Catalog database is not initialized");
    const id = randomUUID();
    let hasUrl = false;
    if (input.kind === "custom_url") {
      if (typeof input.url !== "string") throw new Error("A custom_url proxy server requires a proxy URL");
      const url = normalizeProxyUrl(input.url);
      this.database.prepare(
        "INSERT INTO proxy_server_secrets (server_id, encrypted_url) VALUES (?, ?) ON CONFLICT(server_id) DO UPDATE SET encrypted_url = excluded.encrypted_url",
      ).run(id, this.encryptModelApiToken(`proxy:${id}`, url));
      hasUrl = true;
    } else if (input.url !== undefined) {
      throw new Error("Only custom_url proxy servers accept a proxy URL");
    }
    const now = new Date().toISOString();
    const server: ProxyServer = { createdAt: now, hasUrl, id, kind: input.kind, name, updatedAt: now };
    this.catalog.proxyServers.push(server);
    await this.saveCatalog();
    return this.proxyServerSettingsView(server);
  }

  async updateProxyServer(serverId: string, input: UpdateProxyServerRequest): Promise<ProxyServer> {
    const server = this.getProxyServer(serverId);
    if (!server) throw new Error("Proxy server not found");
    // Validate the complete request before mutating catalog state so a mixed
    // valid/invalid update cannot partially rename an in-memory record.
    const nextName = input.name === undefined ? server.name : requiredLabel(input.name, "Proxy server name");
    const nextKind = input.kind ?? server.kind;
    if (!PROXY_SERVER_KINDS.has(nextKind)) {
      throw new Error("Proxy server kind must be custom_url, environment, or system");
    }
    if (nextKind === "custom_url" && server.kind !== "custom_url" && input.url === undefined) {
      throw new Error("Changing to custom_url requires a proxy URL");
    }
    const nextUrl = input.url === undefined ? undefined : normalizeProxyUrl(input.url);
    if (input.url !== undefined) {
      if (nextKind !== "custom_url") throw new Error("Only custom_url proxy servers accept a proxy URL");
      if (!this.database) throw new Error("Catalog database is not initialized");
      this.database.prepare(
        "INSERT INTO proxy_server_secrets (server_id, encrypted_url) VALUES (?, ?) ON CONFLICT(server_id) DO UPDATE SET encrypted_url = excluded.encrypted_url",
      ).run(serverId, this.encryptModelApiToken(`proxy:${serverId}`, nextUrl!));
      server.hasUrl = true;
    }
    if (server.kind === "custom_url" && nextKind !== "custom_url") {
      this.database?.prepare("DELETE FROM proxy_server_secrets WHERE server_id = ?").run(serverId);
      server.hasUrl = false;
    }
    server.name = nextName;
    server.kind = nextKind;
    server.updatedAt = new Date().toISOString();
    await this.saveCatalog();
    return this.proxyServerSettingsView(server);
  }

  async deleteProxyServer(serverId: string): Promise<void> {
    const server = this.getProxyServer(serverId);
    if (!server) throw new Error("Proxy server not found");
    const policy: ProxyPolicy = `proxy:${serverId}`;
    const references: string[] = [];
    if (this.catalog.proxyDefaultPolicy === policy) references.push("the global default proxy");
    if (this.catalog.webSettings.proxyPolicy === policy) references.push("web settings");
    if (this.catalog.sandboxNetworkSettings.egressProxyPolicy === policy) {
      references.push("sandbox network access");
    }
    for (const model of this.catalog.models) {
      if (model.proxyPolicy === policy) references.push(`model "${model.name}"`);
    }
    for (const [mcpServerId, mcpPolicy] of Object.entries(this.catalog.mcpProxyPolicies)) {
      if (mcpPolicy === policy) references.push(`MCP server "${mcpServerId}"`);
    }
    if (references.length) {
      throw new Error(`Proxy server is referenced by ${references.join(", ")} and cannot be deleted`);
    }
    this.database?.prepare("DELETE FROM proxy_server_secrets WHERE server_id = ?").run(serverId);
    this.catalog.proxyServers = this.catalog.proxyServers.filter((entry) => entry.id !== serverId);
    await this.saveCatalog();
  }

  getMcpProxyPolicies(): McpProxyPolicies {
    return structuredClone(this.catalog.mcpProxyPolicies);
  }

  /** Effective policy for one MCP server; unlisted servers inherit. */
  mcpProxyPolicy(serverId: string): ProxyPolicy {
    return this.catalog.mcpProxyPolicies[serverId] ?? "inherit";
  }

  async updateMcpProxyPolicies(input: UpdateMcpProxyPoliciesRequest): Promise<McpProxyPolicies> {
    const policies = normalizeMcpProxyPolicies(isRecord(input) ? input.policies : undefined);
    for (const [serverId, policy] of Object.entries(policies)) {
      this.assertProxyPolicyKnown(policy, `policies.${serverId}`);
    }
    this.catalog.mcpProxyPolicies = policies;
    await this.saveCatalog();
    return this.getMcpProxyPolicies();
  }

  async replaceTimeoutSettings(value: unknown): Promise<SystemTimeoutSettings> {
    this.catalog.timeoutSettings = normalizeTimeoutSettings(value);
    await this.saveCatalog();
    return this.getTimeoutSettings();
  }

  async replaceQuotaSettings(value: unknown): Promise<SystemQuotaSettings> {
    this.catalog.quotaSettings = normalizeQuotaSettings(value);
    await this.saveCatalog();
    return this.getQuotaSettings();
  }

  /** Memory-graph settings without the live sidecar health — the HTTP layer
   *  merges `memoryGraphStatus` (it owns the client). The password is never
   *  returned; only whether one is stored. */
  getMemoryGraphSettings(): Omit<MemoryGraphSettingsDetails, "memoryGraphStatus"> {
    return {
      ...structuredClone(this.catalog.memoryGraphSettings),
      hasNeo4jPassword: Boolean(this.database?.prepare("SELECT 1 FROM memory_graph_secret WHERE id = 1").get()),
    };
  }

  /** Decrypt the stored Neo4j password (undefined when none is stored). Used
   *  by the HTTP layer to push to the sidecar on startup, on password PUT,
   *  and for the GET-time self-heal re-push. */
  getMemoryGraphNeo4jPassword(): string | undefined {
    if (!this.database) return undefined;
    const row = this.database.prepare("SELECT encrypted_password FROM memory_graph_secret WHERE id = 1")
      .get() as { encrypted_password: string } | undefined;
    return row ? this.decryptModelApiToken("memory-graph:neo4j", row.encrypted_password) : undefined;
  }

  async updateMemoryGraphSettings(input: UpdateMemoryGraphSettingsRequest): Promise<Omit<MemoryGraphSettingsDetails, "memoryGraphStatus">> {
    const { neo4jPassword, ...settingsInput } = input;
    // 2B: fields are independent — only the keys present in the payload move.
    // Overlay provided fields on the current settings, then normalize. The
    // normalizer receives the full payload (minus the write-only password) so
    // it can reject unknown keys; known-but-absent fields fall back to the
    // current stored value via normalizeMemoryGraphSettings's own defaults.
    const merged: Record<string, unknown> = { ...this.catalog.memoryGraphSettings };
    for (const [key, value] of Object.entries(settingsInput)) {
      if (hasOwn(settingsInput, key)) merged[key] = value;
    }
    const next = normalizeMemoryGraphSettings(merged);
    if (neo4jPassword !== undefined) {
      if (!this.database) throw new Error("Catalog database is not initialized");
      if (neo4jPassword === null) {
        this.database!.prepare("DELETE FROM memory_graph_secret WHERE id = 1").run();
      } else {
        const trimmed = neo4jPassword.trim();
        if (!trimmed) throw new Error("The Neo4j password cannot be empty");
        if (trimmed.length > 16_384) throw new Error("The Neo4j password is too long");
        const encrypted = this.encryptModelApiToken("memory-graph:neo4j", trimmed);
        this.database!.prepare(
          "INSERT INTO memory_graph_secret (id, encrypted_password) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET encrypted_password = excluded.encrypted_password",
        ).run(encrypted);
      }
    }
    this.catalog.memoryGraphSettings = next;
    await this.saveCatalog();
    return this.getMemoryGraphSettings();
  }

  /** Idea Tree system settings. Persisted in the catalog JSON (the settings
   *  table) and filled from `DEFAULT_IDEA_TREE_SETTINGS` for any missing
   *  field. The runtime reads these when a user triggers `/idea-tree-team` in a
   *  Run — there is no per-Session override. */
  getIdeaTreeSettings(): IdeaTreeSettings {
    return structuredClone(this.catalog.ideaTreeSettings);
  }

  /** Idea Tree settings as returned to the UI. Currently identical to the
   *  stored settings (no live status to merge, unlike the memory-graph
   *  view), but exposed as `IdeaTreeSettingsDetails` so the HTTP layer can
   *  return the documented view shape without the store leaking its internal
   *  type. */
  getIdeaTreeSettingsDetails(): IdeaTreeSettingsDetails {
    return structuredClone(this.catalog.ideaTreeSettings);
  }

  /** Persist an Idea Tree settings update. Each field is independent — only
   *  the keys present in the payload move. The normalizer validates numeric
   *  ranges and the assessor weight sum (enforced only when all three weights
   *  are provided together). */
  async updateIdeaTreeSettings(input: UpdateIdeaTreeSettingsRequest): Promise<IdeaTreeSettings> {
    const next = normalizeIdeaTreeSettings(input, this.catalog.ideaTreeSettings);
    this.catalog.ideaTreeSettings = next;
    await this.saveCatalog();
    return this.getIdeaTreeSettings();
  }

  getProjectSettings(projectId: string): RuntimeSettingsDetails {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found");
    return {
      overrides: structuredClone(project.settingsOverrides),
      ...this.resolveSettingsLayers(this.projectSettingsLayers(project)),
    };
  }

  getSessionSettings(sessionId: string): RuntimeSettingsDetails {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const project = this.getProject(session.projectId);
    if (!project) throw new Error("Project not found");
    return {
      overrides: structuredClone(session.settingsOverrides),
      ...this.resolveRuntimeSettings(sessionId),
    };
  }

  resolveRuntimeSettings(sessionId: string): ResolvedRuntimeSettings {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const project = this.getProject(session.projectId);
    if (!project) throw new Error("Project not found");
    return this.resolveSettingsLayers([
      ...this.projectSettingsLayers(project),
      { overrides: session.settingsOverrides, source: "session" },
    ]);
  }

  async replaceGlobalSettings(value: unknown): Promise<RuntimeSettingsDetails> {
    const normalized = withoutSkillSelection(this.normalizeSettings(value));
    this.catalog.globalSettings = normalized;
    this.syncSessionCompatibilityForProject();
    await this.saveCatalog();
    return this.getGlobalSettings();
  }

  async replaceProjectSettings(projectId: string, value: unknown): Promise<RuntimeSettingsDetails> {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found");
    const normalized = this.normalizeSettings(value);
    project.settingsOverrides = normalized;
    this.syncSessionCompatibilityForProject(projectId);
    await this.saveCatalog();
    return this.getProjectSettings(projectId);
  }

  async replaceSessionSettings(sessionId: string, value: unknown): Promise<RuntimeSettingsDetails> {
    const session = this.assertSessionWritable(sessionId);
    const normalized = this.normalizeSettings(value);
    session.settingsOverrides = normalized;
    session.updatedAt = new Date().toISOString();
    this.syncSessionCompatibility(session);
    await this.saveCatalog();
    return this.getSessionSettings(sessionId);
  }

  listProjects(): Project[] {
    return this.catalog.projects.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  listModels(): ModelProfile[] {
    return this.catalog.models.toSorted((left, right) => left.name.localeCompare(right.name));
  }

  getModel(modelId?: string): ModelProfile | undefined {
    if (!modelId) return undefined;
    return this.catalog.models.find((model) => model.id === modelId);
  }

  getModelApiToken(modelId?: string): string | undefined {
    if (!modelId || !this.database) return undefined;
    const row = this.database.prepare("SELECT encrypted_token FROM model_secrets WHERE model_id = ?").get(modelId) as { encrypted_token: string } | undefined;
    if (row) return this.decryptModelApiToken(modelId, row.encrypted_token);
    // Provider-backed profiles without a token of their own use the
    // provider's shared token.
    const providerId = this.getModel(modelId)?.providerId;
    return providerId ? this.getProviderApiToken(providerId) : undefined;
  }

  getProviderApiToken(providerId?: string): string | undefined {
    if (!providerId || !this.database) return undefined;
    const key = providerSecretKey(providerId);
    const row = this.database.prepare("SELECT encrypted_token FROM model_secrets WHERE model_id = ?").get(key) as { encrypted_token: string } | undefined;
    return row ? this.decryptModelApiToken(key, row.encrypted_token) : undefined;
  }

  /**
   * Whether a run may start without any saved token.
   *
   * There is no separate "this endpoint needs no token" switch: saving a
   * provider with an empty token is that statement, which is what local
   * endpoints (Ollama), gateways that authenticate by network position, and
   * test stubs rely on. A standalone profile with no provider still needs its
   * own token, because nothing else vouches for the endpoint.
   */
  modelAllowsMissingToken(profile: ModelProfile): boolean {
    const provider = this.getProvider(profile.providerId);
    if (!provider) return false;
    return provider.tokenOptional || !provider.hasApiToken;
  }

  /** Validate an optional model proxy policy (default inherit) against the
   *  registry before it is stored. */
  private normalizeModelProxyPolicy(value: ProxyPolicy | undefined): ProxyPolicy {
    const policy = normalizeProxyPolicy(value ?? "inherit", "proxyPolicy");
    this.assertProxyPolicyKnown(policy, "proxyPolicy");
    return policy;
  }

  async createModel(input: CreateModelProfileRequest): Promise<ModelProfile> {
    const normalized = validateLiveModel(input);
    const now = new Date().toISOString();
    const profile: ModelProfile = {
      ...normalized,
      createdAt: now,
      hasApiToken: false,
      id: randomUUID(),
      proxyPolicy: this.normalizeModelProxyPolicy(input.proxyPolicy),
      updatedAt: now,
    };
    const apiToken = normalizeApiToken(input.apiToken);
    if (apiToken) {
      this.setModelApiToken(profile.id, apiToken);
      profile.hasApiToken = true;
    }
    this.catalog.models.push(profile);
    this.defaultGlobalTaskModel(profile);
    await this.saveCatalog();
    return profile;
  }

  /** Adding a model should make the app usable without a second, separate
   * "select it as the task model" step: while no global task model is chosen,
   * the model being configured becomes the global default. An explicit choice
   * (existing `modelId` override) is never overwritten. */
  private defaultGlobalTaskModel(profile: ModelProfile): void {
    if (!this.catalog.globalSettings.modelId) {
      this.catalog.globalSettings.modelId = profile.id;
    }
  }

  async updateModel(modelId: string, input: UpdateModelProfileRequest): Promise<ModelProfile> {
    const profile = this.getModel(modelId);
    if (!profile) throw new Error("Model not found");
    const normalized = validateLiveModel(input);
    const provider = this.getProvider(profile.providerId);
    if (provider && (normalized.baseUrl !== provider.baseUrl || normalized.apiProtocol !== provider.apiProtocol)) {
      throw new Error("The base URL and API protocol of a provider model cannot be changed here; edit the provider instead");
    }
    Object.assign(profile, normalized, { updatedAt: new Date().toISOString() });
    // `null` is an explicit "drop my overrides" so the listing and the catalog
    // answer again; an absent key keeps whatever was saved.
    if (input.facts === null) delete profile.facts;
    if (input.proxyPolicy !== undefined) {
      profile.proxyPolicy = this.normalizeModelProxyPolicy(input.proxyPolicy);
    }
    if (input.apiToken === null) {
      this.setModelApiToken(modelId, undefined);
      profile.hasApiToken = provider?.hasApiToken === true;
    } else if (input.apiToken !== undefined) {
      this.setModelApiToken(modelId, normalizeApiToken(input.apiToken));
      profile.hasApiToken = true;
    }
    // Heals catalogs from before auto-defaulting existed: re-saving a usable
    // model claims the still-unset global task model slot.
    if (profile.hasApiToken) this.defaultGlobalTaskModel(profile);
    await this.saveCatalog();
    return profile;
  }

  async deleteModel(modelId: string): Promise<void> {
    const profile = this.getModel(modelId);
    if (!profile) throw new Error("Model not found");
    const referencesModel = (settings: RuntimeSettingsOverrides) =>
      settings.modelId === modelId || settings.reviewModelId === modelId;
    if (referencesModel(this.catalog.globalSettings)
      || this.catalog.projects.some((project) => referencesModel(project.settingsOverrides))
      || this.catalog.sessions.some((session) =>
        session.modelId === modelId || session.reviewModelId === modelId || referencesModel(session.settingsOverrides))) {
      throw new Error("Model is referenced by runtime settings and cannot be deleted");
    }
    this.setModelApiToken(modelId, undefined);
    this.catalog.models = this.catalog.models.filter((model) => model.id !== modelId);
    await this.saveCatalog();
  }

  listProviders(): ModelProvider[] {
    return this.catalog.providers.toSorted((left, right) => left.name.localeCompare(right.name));
  }

  getProvider(providerId?: string): ModelProvider | undefined {
    if (!providerId) return undefined;
    return this.catalog.providers.find((provider) => provider.id === providerId);
  }

  private setProviderApiToken(providerId: string, apiToken: string | undefined): void {
    this.setModelApiToken(providerSecretKey(providerId), apiToken);
  }

  private profileHasOwnToken(modelId: string): boolean {
    if (!this.database) return false;
    return Boolean(this.database.prepare("SELECT 1 FROM model_secrets WHERE model_id = ?").get(modelId));
  }

  /** Mirror provider connection changes onto its profiles. The API variant is
   *  only reset when the protocol family changed, so a per-model variant
   *  choice under the same protocol survives provider edits. */
  private syncProviderModels(provider: ModelProvider, previousProtocol: ModelProfile["apiProtocol"]): void {
    for (const profile of this.catalog.models) {
      if (profile.providerId !== provider.id) continue;
      profile.baseUrl = provider.baseUrl;
      profile.apiProtocol = provider.apiProtocol;
      if (provider.apiProtocol !== previousProtocol) profile.apiVariant = provider.apiVariant;
      profile.proxyPolicy = provider.proxyPolicy;
      profile.hasApiToken = this.profileHasOwnToken(profile.id) || provider.hasApiToken;
      profile.updatedAt = provider.updatedAt;
    }
  }

  async createProvider(input: CreateModelProviderRequest): Promise<ModelProvider> {
    const normalized = validateLiveProvider(input);
    const preset = input.presetId === undefined ? undefined : getModelProviderPreset(input.presetId);
    const now = new Date().toISOString();
    const provider: ModelProvider = {
      ...normalized,
      createdAt: now,
      hasApiToken: false,
      id: randomUUID(),
      proxyPolicy: this.normalizeModelProxyPolicy(input.proxyPolicy),
      tokenOptional: input.tokenOptional ?? preset?.tokenOptional ?? false,
      updatedAt: now,
    };
    const apiToken = normalizeApiToken(input.apiToken);
    if (apiToken) {
      this.setProviderApiToken(provider.id, apiToken);
      provider.hasApiToken = true;
    }
    this.catalog.providers.push(provider);
    await this.saveCatalog();
    return provider;
  }

  async updateProvider(providerId: string, input: UpdateModelProviderRequest): Promise<ModelProvider> {
    const provider = this.getProvider(providerId);
    if (!provider) throw new Error("Provider not found");
    const previousProtocol = provider.apiProtocol;
    const normalized = validateLiveProvider({
      apiProtocol: input.apiProtocol ?? provider.apiProtocol,
      apiVariant: input.apiVariant
        ?? (input.apiProtocol !== undefined && input.apiProtocol !== provider.apiProtocol ? undefined : provider.apiVariant),
      baseUrl: input.baseUrl ?? provider.baseUrl,
      modelDiscovery: input.modelDiscovery ?? provider.modelDiscovery,
      name: input.name ?? provider.name,
      presetId: provider.presetId,
    });
    Object.assign(provider, normalized, { updatedAt: new Date().toISOString() });
    if (input.tokenOptional !== undefined) provider.tokenOptional = input.tokenOptional === true;
    if (input.proxyPolicy !== undefined) {
      provider.proxyPolicy = this.normalizeModelProxyPolicy(input.proxyPolicy);
    }
    if (input.apiToken === null) {
      this.setProviderApiToken(providerId, undefined);
      provider.hasApiToken = false;
    } else if (input.apiToken !== undefined) {
      this.setProviderApiToken(providerId, normalizeApiToken(input.apiToken));
      provider.hasApiToken = true;
    }
    this.syncProviderModels(provider, previousProtocol);
    await this.saveCatalog();
    return provider;
  }

  async deleteProvider(providerId: string): Promise<void> {
    const provider = this.getProvider(providerId);
    if (!provider) throw new Error("Provider not found");
    const children = this.catalog.models.filter((model) => model.providerId === providerId);
    const referencesModel = (settings: RuntimeSettingsOverrides, id: string) =>
      settings.modelId === id || settings.reviewModelId === id;
    for (const child of children) {
      if (referencesModel(this.catalog.globalSettings, child.id)
        || this.catalog.projects.some((project) => referencesModel(project.settingsOverrides, child.id))
        || this.catalog.sessions.some((session) =>
          session.modelId === child.id || session.reviewModelId === child.id || referencesModel(session.settingsOverrides, child.id))) {
        throw new Error("Provider models are referenced by runtime settings and cannot be deleted");
      }
    }
    for (const child of children) this.setModelApiToken(child.id, undefined);
    this.setProviderApiToken(providerId, undefined);
    this.catalog.models = this.catalog.models.filter((model) => model.providerId !== providerId);
    this.catalog.providers = this.catalog.providers.filter((entry) => entry.id !== providerId);
    await this.saveCatalog();
  }

  /** Ensure a profile backs the given provider/model pair so the rest of the
   *  product (runs, usage, review model) keeps operating on profile ids. */
  async materializeProviderModel(
    providerId: string,
    modelId: string,
    options: {
      facts?: ModelFactOverrides;
      label?: string;
      vision?: boolean;
    } = {},
  ): Promise<ModelProfile> {
    const provider = this.getProvider(providerId);
    if (!provider) throw new Error("Provider not found");
    const model = modelId.trim();
    if (!model) throw new Error("Model ID is required");
    if (model.length > 512) throw new Error("Model ID is too long");
    const catalog = lookupModelCatalog(model, provider.presetId);
    // Adding a model never states a thinking default. A new profile starts at
    // whatever the model's own contract says, which for almost every model is
    // `auto` — the mode that omits the control field entirely. Per-model
    // defaults are an edit, made in the model editor, not part of adding.
    const requestedFacts = normalizeModelFactOverrides(options.facts);
    const { effort: defaultEffort, mode: defaultMode } = constrainCatalogThinking(
      model,
      undefined,
      undefined,
      requestedFacts,
    );
    const apiVariant = catalog?.apiVariant && MODEL_API_VARIANTS[provider.apiProtocol].includes(catalog.apiVariant)
      ? catalog.apiVariant
      : provider.apiVariant;
    const existing = this.catalog.models.find((profile) => profile.providerId === providerId && profile.model === model);
    if (existing) {
      // Adding the same model twice stays idempotent, but a field the caller
      // states explicitly is an instruction, not a duplicate: apply it and
      // leave everything else as saved.
      const facts = requestedFacts ?? existing.facts;
      const constrained = constrainCatalogThinking(
        model,
        existing.thinkingMode,
        existing.thinkingEffort,
        facts,
      );
      const name = options.label === undefined
        ? existing.name
        : cleanLabel(`${provider.name} · ${options.label}`, model);
      const vision = options.vision ?? existing.vision;
      if (existing.apiVariant !== apiVariant
        || existing.thinkingMode !== constrained.mode
        || existing.thinkingEffort !== constrained.effort
        || existing.name !== name
        || existing.vision !== vision
        || JSON.stringify(existing.facts) !== JSON.stringify(facts)) {
        Object.assign(existing, {
          apiVariant,
          ...(facts ? { facts } : {}),
          name,
          thinkingEffort: constrained.effort,
          thinkingMode: constrained.mode,
          updatedAt: new Date().toISOString(),
          vision,
        });
        await this.saveCatalog();
      }
      return existing;
    }
    const now = new Date().toISOString();
    const facts = requestedFacts;
    const profile: ModelProfile = {
      apiProtocol: provider.apiProtocol,
      apiVariant,
      baseUrl: provider.baseUrl,
      createdAt: now,
      ...(facts ? { facts } : {}),
      hasApiToken: provider.hasApiToken,
      id: randomUUID(),
      model,
      name: cleanLabel(`${provider.name} · ${options.label ?? model}`, model),
      providerId,
      proxyPolicy: provider.proxyPolicy,
      thinkingEffort: defaultEffort,
      thinkingMode: defaultMode,
      updatedAt: now,
      vision: options.vision === true,
    };
    this.catalog.models.push(profile);
    this.defaultGlobalTaskModel(profile);
    await this.saveCatalog();
    return profile;
  }

  async createProject(
    name: string,
    input: RuntimeSettingsOverrides = {},
    remoteRunnerHostIds: string[] = [],
  ): Promise<Project> {
    const settingsOverrides = this.normalizeSettings(withDefaultProjectSkillSettings(input));
    const allowedHosts = this.validateProjectRemoteRunnerHosts(remoteRunnerHostIds);
    const project: Project = {
      createdAt: new Date().toISOString(),
      id: randomUUID(),
      name: cleanLabel(name, "Untitled project"),
      remoteRunnerHostIds: allowedHosts,
      settingsOverrides,
    };
    this.catalog.projects.push(project);
    await this.saveCatalog();
    return project;
  }

  async updateProject(projectId: string, changes: UpdateProjectRequest): Promise<Project> {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found");
    if (changes.name !== undefined) project.name = requiredLabel(changes.name, "Project name");
    if (changes.remoteRunnerHostIds !== undefined) {
      // Project choices are defaults, not a ceiling on Session overrides.
      project.remoteRunnerHostIds = this.validateProjectRemoteRunnerHosts(changes.remoteRunnerHostIds);
    }
    await this.saveCatalog();
    return project;
  }

  private validateProjectRemoteRunnerHosts(hostIds: string[]): string[] {
    if (!Array.isArray(hostIds)) throw new Error("Project remote runner allowlist must be an array");
    const normalized = [...new Set(hostIds.map((id) => id.trim()).filter(Boolean))];
    for (const hostId of normalized) {
      const host = this.getRemoteHost(hostId);
      if (!host) throw new Error(`Remote host not found: ${hostId}`);
      const unusable = remoteRunnerUnusableReason(host);
      if (unusable) throw new Error(`Remote runner host ${host.alias} cannot run Sessions: ${unusable}`);
    }
    return normalized;
  }

  /**
   * Session overrides select from the global usable catalog independently of
   * Project defaults. The same host existence/capability checks still apply.
   */
  private validateSessionRemoteRunnerHosts(projectId: string, hostIds: string[]): string[] {
    if (!Array.isArray(hostIds)) throw new Error("Session remote runner allowlist must be an array");
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found");
    return this.validateProjectRemoteRunnerHosts(hostIds);
  }

  /**
   * The machines this Session may use right now: its own override when it has
   * one, otherwise the Project defaults, filtered by current host usability. Local execution is not part
   * of this list because it is always available.
   */
  effectiveRemoteRunnerHosts(sessionId: string): RemoteHostTarget[] {
    const session = this.getSession(sessionId);
    if (!session) return [];
    const project = this.getProject(session.projectId);
    if (!project) return [];
    const selected = session.remoteRunnerHostIds ?? project.remoteRunnerHostIds;
    return selected
      .flatMap((hostId) => {
        const host = this.getRemoteHost(hostId);
        return host && !remoteRunnerUnusableReason(host) ? [host] : [];
      });
  }

  /** The host, when this Session is allowed to use it; throws with the reason otherwise. */
  assertSessionAllowsRemoteRunner(sessionId: string, hostId: string): RemoteHostTarget {
    const host = this.effectiveRemoteRunnerHosts(sessionId).find((candidate) => candidate.id === hostId);
    if (host) return host;
    const known = this.getRemoteHost(hostId);
    const unusable = known ? remoteRunnerUnusableReason(known) : undefined;
    throw new Error(unusable
      ? `Remote runner host ${known!.alias} cannot run this Session: ${unusable}`
      : `Remote runner host ${known?.alias ?? hostId} is not allowed by this Session`);
  }

  getProject(projectId: string): Project | undefined {
    return this.catalog.projects.find((project) => project.id === projectId);
  }

  listSessions(projectId: string, state: SessionListState = "active"): Session[] {
    return this.catalog.sessions
      .filter((session) => session.projectId === projectId
        && (state === "all" || (state === "archived" ? Boolean(session.archivedAt) : !session.archivedAt)))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async createSession(
    projectId: string,
    title: string,
    input: RuntimeSettingsOverrides | string = {},
    governance: {
      approvalMode?: "always_allow" | "ask_for_dangerous";
      reviewCriteria?: string[];
      reviewMode?: "auto" | "manual";
      remoteRunnerHostIds?: string[];
      specialistId?: string;
    } = {},
    options: {
      allowUnconfiguredModel?: boolean;
    } = {},
  ): Promise<Session> {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found");
    const settingsOverrides = this.normalizeSettings(typeof input === "string"
      ? { modelId: input, reviewModelId: input }
      : input);
    const resolved = this.resolveSettingsLayers([
      ...this.projectSettingsLayers(project),
      { overrides: settingsOverrides, source: "session" },
    ]);
    const selectedModel = this.getModel(resolved.effective.modelId);
    if (!selectedModel && !options.allowUnconfiguredModel) throw new Error("A task model is required");
    if (selectedModel && !this.getModelApiToken(selectedModel.id)
      && !this.modelAllowsMissingToken(selectedModel) && !options.allowUnconfiguredModel) {
      throw new Error("The task model must have a saved API token");
    }
    const now = new Date().toISOString();
    if (governance.specialistId && !this.getSpecialist(governance.specialistId)) {
      throw new Error("Specialist not found");
    }
    const remoteRunnerHostIds = governance.remoteRunnerHostIds === undefined
      ? undefined
      : this.validateSessionRemoteRunnerHosts(projectId, governance.remoteRunnerHostIds);
    const sessionId = randomUUID();
    const permissionEpoch = createPermissionEpoch(
      sessionId,
      "Session created",
      undefined,
      undefined,
      this.currentSandboxNetworkAccess(),
    );
    const session: Session = {
      approvalMode: governance.approvalMode ?? "ask_for_dangerous",
      createdAt: now,
      enabledConnectorIds: [...resolved.effective.enabledConnectorIds],
      enabledSkillIds: [...resolved.effective.enabledSkillIds],
      id: sessionId,
      modelId: resolved.effective.modelId,
      permissionEpochId: permissionEpoch.id,
      projectId,
      reviewModelId: resolved.effective.reviewModelId,
      reviewCriteria: this.normalizeReviewCriteria(governance.reviewCriteria),
      reviewMode: governance.reviewMode === "manual" ? "manual" : "auto",
      ...(remoteRunnerHostIds ? { remoteRunnerHostIds } : {}),
      ...(remoteRunnerHostIds ? { remoteRunnerHostIds } : {}),
      reviewerAutomaticReviewEnabled: true,
      reviewerSpecialistLevel: DEFAULT_REVIEWER_SPECIALIST_LEVEL,
      semanticReviewEnabled: resolved.effective.semanticReviewEnabled,
      settingsOverrides,
      ...(governance.specialistId ? { specialistId: governance.specialistId } : {}),
      title: cleanLabel(title, UNTITLED_SESSION_TITLE),
      updatedAt: now,
    };
    return withWorkspaceAdmission(new VersionStore(this.dataDir),
      resolve(this.dataDir, "projects", projectId, "sessions", session.id, "workspace"), async () => {
    await mkdir(resolve(this.dataDir, "messages"), { recursive: true });
    await writeFile(this.messagesPath(session.id), "[]\n", "utf8");
    await mkdir(resolve(this.dataDir, "session-runs"), { recursive: true });
    await writeFile(this.sessionRunsPath(session.id), "[]\n", "utf8");
    await mkdir(resolve(this.dataDir, "projects", projectId, "sessions", session.id, "workspace"), { recursive: true });
    this.catalog.permissionEpochs.push(permissionEpoch);
    this.catalog.sessions.push(session);
    await this.saveCatalog();
    return session;
    });
  }

  getSession(sessionId: string): Session | undefined {
    return this.catalog.sessions.find((session) => session.id === sessionId);
  }

  listSpecialists(): Specialist[] {
    return structuredClone(this.catalog.specialists).toSorted((left, right) => left.name.localeCompare(right.name));
  }

  getSpecialist(specialistId?: string): Specialist | undefined {
    if (!specialistId) return undefined;
    const specialist = this.catalog.specialists.find((candidate) => candidate.id === specialistId);
    return specialist ? structuredClone(specialist) : undefined;
  }

  private normalizeSpecialistInput(input: CreateSpecialistRequest | UpdateSpecialistRequest): Omit<Specialist, "createdAt" | "id" | "updatedAt"> {
    const name = requiredLabel(input.name, "Specialist name");
    const description = requiredText(input.description, "Specialist description", 500);
    const instructions = input.instructions?.trim();
    if (!instructions || instructions.length > 20_000) throw new Error("Specialist instructions must be 1-20000 characters");
    const enabledSkillIds = [...new Set(input.enabledSkillIds ?? [])];
    const unavailableSkills = enabledSkillIds.filter((id) => !this.skillIds.has(id));
    if (unavailableSkills.length) throw new Error(`Specialist skills are unavailable: ${unavailableSkills.join(", ")}`);
    const connectorIds = [...new Set(input.connectorIds ?? [])];
    const unavailableConnectors = connectorIds.filter((id) => !this.connectorIds.has(id));
    if (unavailableConnectors.length) throw new Error(`Specialist connectors are unavailable: ${unavailableConnectors.join(", ")}`);
    return { connectorIds, description, enabledSkillIds, instructions, name };
  }

  async createSpecialist(input: CreateSpecialistRequest): Promise<Specialist> {
    const normalized = this.normalizeSpecialistInput(input);
    if (this.catalog.specialists.some((specialist) => specialist.name.toLocaleLowerCase() === normalized.name.toLocaleLowerCase())) {
      throw new Error("Specialist name already exists");
    }
    const now = new Date().toISOString();
    const specialist: Specialist = { ...normalized, createdAt: now, id: randomUUID(), updatedAt: now };
    this.catalog.specialists.push(specialist);
    await this.saveCatalog();
    return structuredClone(specialist);
  }

  async updateSpecialist(specialistId: string, input: UpdateSpecialistRequest): Promise<Specialist> {
    const specialist = this.catalog.specialists.find((candidate) => candidate.id === specialistId);
    if (!specialist) throw new Error("Specialist not found");
    if (specialist.builtIn) {
      // Built-in specialists are read-only except for the on/off `enabled` toggle.
      const touchedCoreField = "name" in input || "description" in input || "instructions" in input
        || "connectorIds" in input || "enabledSkillIds" in input;
      if (touchedCoreField) {
        throw new Error("Built-in specialists are read-only; only their enabled flag can be toggled");
      }
      if (input.enabled === undefined) {
        return structuredClone(specialist);
      }
      if (typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean");
      specialist.enabled = input.enabled;
      specialist.updatedAt = new Date().toISOString();
      await this.saveCatalog();
      return structuredClone(specialist);
    }
    const normalized = this.normalizeSpecialistInput(input);
    if (this.catalog.specialists.some((candidate) => candidate.id !== specialistId
      && candidate.name.toLocaleLowerCase() === normalized.name.toLocaleLowerCase())) {
      throw new Error("Specialist name already exists");
    }
    Object.assign(specialist, normalized, { updatedAt: new Date().toISOString() });
    await this.saveCatalog();
    return structuredClone(specialist);
  }

  async deleteSpecialist(specialistId: string): Promise<void> {
    const specialist = this.catalog.specialists.find((candidate) => candidate.id === specialistId);
    if (!specialist) throw new Error("Specialist not found");
    if (specialist.builtIn) throw new Error("Built-in specialists cannot be deleted");
    if (this.catalog.sessions.some((session) => session.specialistId === specialistId)
      || this.catalog.subagents.some((subagent) => subagent.specialistId === specialistId)) {
      throw new Error("Specialist is referenced by a Session or subagent and cannot be deleted");
    }
    this.catalog.specialists = this.catalog.specialists.filter((candidate) => candidate.id !== specialistId);
    await this.saveCatalog();
  }

  listSubagents(sessionId: string): Subagent[] {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return structuredClone(this.catalog.subagents.filter((subagent) => subagent.sessionId === sessionId))
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async createSubagent(
    sessionId: string,
    parentTurnId: string,
    input: SubagentInput,
    execution: {
      maxTurns?: number;
      model?: ModelRunInfo;
      specialistConfigHash?: string;
      timeoutSeconds?: number;
    } = {},
  ): Promise<Subagent> {
    this.assertSessionWritable(sessionId);
    const description = requiredLabel(input.description, "Subagent description");
    const prompt = input.prompt?.trim();
    if (!prompt || prompt.length > 20_000) throw new Error("Subagent prompt is required and must not exceed 20,000 characters");
    const specialistId = input.specialistId?.trim();
    const validSpecialistId = specialistId && this.getSpecialist(specialistId) ? specialistId : undefined;
    const brief = normalizeSubagentBrief(input.brief, input.brief ? { version: 1 } : {});
    const inputPaths = normalizeSubagentInputPaths(input.inputPaths);
    const now = new Date().toISOString();
    const normalizedInput = structuredClone(input);
    delete normalizedInput.specialistId;
    const subagent: Subagent = {
      createdAt: now,
      id: randomUUID(),
      input: {
        ...normalizedInput,
        ...(brief ? { brief } : {}),
        description,
        ...(inputPaths ? { inputPaths } : {}),
        prompt,
        ...(validSpecialistId ? { specialistId: validSpecialistId } : {}),
        subagentType: input.subagentType?.trim() || "general-purpose",
      },
      maxTurns: execution.maxTurns ?? input.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
      ...(execution.model ? { model: structuredClone(execution.model) } : {}),
      parentTurnId,
      sessionId,
      ...(execution.specialistConfigHash ? { specialistConfigHash: execution.specialistConfigHash } : {}),
      ...(validSpecialistId ? { specialistId: validSpecialistId } : {}),
      status: "running",
      steps: [{
        content: [
          `Subagent type: ${input.subagentType?.trim() || "general-purpose"}`,
          `Task: ${description}`,
          ...(brief ? [`Brief v${brief.version ?? 1}`, `Goal: ${brief.goal}`] : []),
        ].join("\n"),
        createdAt: now,
        id: randomUUID(),
        kind: "system",
        status: "completed",
      }],
      timeoutSeconds: execution.timeoutSeconds ?? input.timeoutSeconds ?? DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
      turnCount: 0,
    };
    this.catalog.subagents.push(subagent);
    await this.saveCatalog();
    return structuredClone(subagent);
  }

  async updateSubagent(subagent: Subagent): Promise<Subagent> {
    const index = this.catalog.subagents.findIndex((candidate) => candidate.id === subagent.id);
    if (index < 0) throw new Error("Subagent not found");
    this.catalog.subagents[index] = structuredClone(subagent);
    await this.saveCatalog();
    return structuredClone(subagent);
  }

  async updateSubagentBrief(
    sessionId: string,
    subagentId: string,
    input: UpdateSubagentBriefRequest,
  ): Promise<Subagent> {
    this.assertSessionWritable(sessionId);
    const subagent = this.catalog.subagents.find(
      (candidate) => candidate.id === subagentId && candidate.sessionId === sessionId,
    );
    if (!subagent) throw new SessionStoreHttpError("Subagent not found", 404);
    if (subagent.status === "running") {
      throw new SessionStoreHttpError("Subagent is running; brief cannot be updated until it finishes", 409);
    }
    if (subagent.status === "cancelled" || subagent.status === "timed_out") {
      throw new SessionStoreHttpError(`Subagent is ${subagent.status}; brief cannot be updated`, 409);
    }
    return await this.withSubagentMutation(subagent.id, async () => {
      const latest = this.catalog.subagents.find(
        (candidate) => candidate.id === subagentId && candidate.sessionId === sessionId,
      );
      if (!latest) throw new SessionStoreHttpError("Subagent not found", 404);
      if (latest.status === "running") {
        throw new SessionStoreHttpError("Subagent is running; brief cannot be updated until it finishes", 409);
      }
      if (latest.status === "cancelled" || latest.status === "timed_out") {
        throw new SessionStoreHttpError(`Subagent is ${latest.status}; brief cannot be updated`, 409);
      }
      const previousVersion = latest.input.brief?.version ?? 0;
      const brief = normalizeSubagentBrief(input.brief, { version: previousVersion + 1 });
      if (!brief) throw new SessionStoreHttpError("Subagent brief is required", 400);
      const now = new Date().toISOString();
      const updated: Subagent = {
        ...latest,
        input: { ...latest.input, brief },
        steps: [...latest.steps, {
          content: `Brief updated to v${brief.version}: ${brief.goal}`,
          createdAt: now,
          id: randomUUID(),
          kind: "system",
          status: "completed",
        }],
      };
      const index = this.catalog.subagents.findIndex((candidate) => candidate.id === updated.id);
      this.catalog.subagents[index] = structuredClone(updated);
      await this.saveCatalog();
      return structuredClone(updated);
    });
  }

  async reconcileWorkspaceFiles(
    sessionId: string,
    files: Array<Pick<WorkspaceFile, "modifiedAt" | "path" | "size">>,
    baseline?: ReadonlyMap<string, string>,
    options: { scanComplete?: boolean } = {},
  ): Promise<Map<string, WorkspaceFileProvenanceSummary>> {
    const workspaceRoot = this.workspacePath(sessionId);
    const reconciliationBaseline = baseline ?? this.snapshotWorkspaceFileRevisions(sessionId);
    const normalizedFiles = files.map((file) => ({
      modifiedAt: file.modifiedAt,
      path: normalizeWorkspaceRelativePath(workspaceRoot, file.path),
      size: file.size,
    }));
    return await this.withWorkspaceFileMutation(sessionId, async () => {
      const session = this.getSession(sessionId);
      if (!session) throw new Error("Session not found");
      const scannedPaths = new Set(normalizedFiles.map((file) => file.path));
      const now = new Date().toISOString();
      let changed = false;

      if (options.scanComplete !== false) {
        for (const record of this.catalog.workspaceFileRecords) {
          if (record.sessionId === sessionId
            && !record.deletedAt
            && reconciliationBaseline.get(record.path) === record.currentRevisionId
            && !scannedPaths.has(record.path)) {
            record.deletedAt = now;
            record.updatedAt = now;
            changed = true;
          }
        }
      }

      const summaries = new Map<string, WorkspaceFileProvenanceSummary>();
      for (const file of normalizedFiles) {
        let record = this.catalog.workspaceFileRecords.find((candidate) =>
          candidate.sessionId === sessionId && candidate.path === file.path && !candidate.deletedAt);
        let revision = record
          ? this.catalog.workspaceFileRevisions.find((candidate) => candidate.id === record!.currentRevisionId)
          : undefined;
        if (!record || !revision) {
          const fileId = randomUUID();
          revision = {
            artifactVersionIds: [],
            createdAt: now,
            fileId,
            id: randomUUID(),
            modifiedAt: file.modifiedAt,
            origin: "unknown",
            path: file.path,
            projectId: session.projectId,
            sessionId,
            size: file.size,
          };
          record = {
            createdAt: now,
            currentRevisionId: revision.id,
            id: fileId,
            path: file.path,
            projectId: session.projectId,
            sessionId,
            sessionTitle: session.title,
            updatedAt: now,
          };
          this.catalog.workspaceFileRevisions.push(revision);
          this.catalog.workspaceFileRecords.push(record);
          changed = true;
        } else if (reconciliationBaseline.get(file.path) === revision.id
          && (revision.modifiedAt !== file.modifiedAt || revision.size !== file.size)) {
          revision = {
            artifactVersionIds: [],
            createdAt: now,
            fileId: record.id,
            id: randomUUID(),
            modifiedAt: file.modifiedAt,
            origin: "unknown",
            path: file.path,
            projectId: session.projectId,
            sessionId,
            size: file.size,
          };
          this.catalog.workspaceFileRevisions.push(revision);
          record.currentRevisionId = revision.id;
          record.sessionTitle = session.title;
          record.updatedAt = now;
          changed = true;
        }
        summaries.set(file.path, {
          fileId: record.id,
          origin: revision.origin,
          recordedAt: revision.createdAt,
          revisionId: revision.id,
        });
      }
      if (changed) await this.saveCatalog();
      return summaries;
    });
  }

  snapshotWorkspaceFileRevisions(sessionId: string): Map<string, string> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return new Map(this.catalog.workspaceFileRecords
      .filter((record) => record.sessionId === sessionId && !record.deletedAt)
      .map((record) => [record.path, record.currentRevisionId]));
  }

  async recordWorkspaceFileRevision(
    sessionId: string,
    input: WorkspaceFileRevisionInput,
  ): Promise<WorkspaceFileRevision> {
    return (await this.recordWorkspaceFileRevisions(sessionId, [input]))[0]!;
  }

  async recordWorkspaceFileRevisions(
    sessionId: string,
    inputs: WorkspaceFileRevisionInput[],
  ): Promise<WorkspaceFileRevision[]> {
    const workspaceRoot = this.workspacePath(sessionId);
    const prepared = inputs.map((input) => {
      const path = normalizeWorkspaceRelativePath(workspaceRoot, input.path);
      if (!Number.isSafeInteger(input.size) || input.size < 0) throw new Error("Workspace file size is invalid");
      if (!input.modifiedAt || Number.isNaN(Date.parse(input.modifiedAt))) {
        throw new Error("Workspace file modification time is invalid");
      }
      if (input.contentHash && !/^[a-f0-9]{64}$/.test(input.contentHash)) {
        throw new Error("Workspace file content hash is invalid");
      }
      return { input, path };
    });
    if (!prepared.length) return [];
    return await this.withWorkspaceFileMutation(sessionId, async () => {
      const session = this.getSession(sessionId);
      if (!session) throw new Error("Session not found");
      for (const { input } of prepared) {
        if (input.parentRevisionId && !this.catalog.workspaceFileRevisions.some((candidate) =>
          candidate.id === input.parentRevisionId && candidate.projectId === session.projectId)) {
          throw new Error("Workspace file parent revision must belong to the same Project");
        }
        if (input.artifactVersionId && !this.catalog.artifactVersions.some((candidate) =>
          candidate.id === input.artifactVersionId && candidate.projectId === session.projectId)) {
          throw new Error("Workspace file Artifact version must belong to the same Project");
        }
      }
      let catalogChanged = false;
      const revisions: WorkspaceFileRevision[] = [];
      // Resolve order inside the same metadata barrier as the pointer update.
      // An unreceipted writer observes the current head (and wins ties), so a
      // prior execution cannot overwrite its projection while it commits.
      const refs = await RefStore.open(new VersionStore(this.dataDir));
      const publicationSequences = new Map<WorkspaceFileRevisionInput, number>();
      try {
        for (const { input, path } of prepared) {
          const root = await realpath(this.workspaceLocation(sessionId, path).root);
          const sequence = refs.publicationSequence(workspaceHeadName(root), input.publicationVersion);
          if (input.publicationVersion && sequence === undefined) throw new Error("Workspace publication receipt is not rooted in this Workspace");
          publicationSequences.set(input, sequence ?? 0);
        }
      } finally { refs.close(); }
      for (const { input, path } of prepared) {
        const parent = input.parentRevisionId
          ? this.catalog.workspaceFileRevisions.find((candidate) => candidate.id === input.parentRevisionId)
          : undefined;
        let record = this.catalog.workspaceFileRecords.find((candidate) =>
          candidate.sessionId === sessionId && candidate.path === path && !candidate.deletedAt);
        const current = record
          ? this.catalog.workspaceFileRevisions.find((candidate) => candidate.id === record!.currentRevisionId)
          : undefined;
        const sameObservedState = current
          && current.size === input.size
          && current.modifiedAt === input.modifiedAt
          && (!input.contentHash || !current.contentHash || current.contentHash === input.contentHash);

        if (current && input.mode === "observe" && sameObservedState) {
          revisions.push(structuredClone(current));
          continue;
        }
        if (current && input.mode === "link" && sameObservedState) {
          if (input.contentHash && !current.contentHash) {
            current.contentHash = input.contentHash;
            catalogChanged = true;
          }
          if (input.artifactVersionId && !current.artifactVersionIds.includes(input.artifactVersionId)) {
            current.artifactVersionIds.push(input.artifactVersionId);
            catalogChanged = true;
          }
          revisions.push(structuredClone(current));
          continue;
        }

        const now = new Date().toISOString();
        const fileId = record?.id ?? randomUUID();
        const contentHash = input.contentHash ?? parent?.contentHash;
        const revision: WorkspaceFileRevision = {
          publicationSequence: publicationSequences.get(input)!,
          artifactVersionIds: input.artifactVersionId ? [input.artifactVersionId] : [],
          ...(contentHash ? { contentHash } : {}),
          createdAt: now,
          ...(input.executionRunId ? { executionRunId: input.executionRunId } : {}),
          fileId,
          id: randomUUID(),
          modifiedAt: input.modifiedAt,
          origin: input.origin,
          ...(input.originMeta ? { originMeta: structuredClone(input.originMeta) } : {}),
          ...(parent ? { parentRevisionId: parent.id } : {}),
          path,
          projectId: session.projectId,
          ...(input.runId ? { runId: input.runId } : {}),
          sessionId,
          size: input.size,
          ...(input.subagentId ? { subagentId: input.subagentId } : {}),
          ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
          ...(input.toolName ? { toolName: input.toolName } : {}),
        };
        this.catalog.workspaceFileRevisions.push(revision);
        if (!record) {
          record = {
            createdAt: now,
            currentRevisionId: revision.id,
            id: fileId,
            path,
            projectId: session.projectId,
            sessionId,
            sessionTitle: session.title,
            updatedAt: now,
          };
          this.catalog.workspaceFileRecords.push(record);
        } else if (!input.publicationVersion || !current || (publicationSequences.get(input)! > (current.publicationSequence ?? -1))) {
          record.currentRevisionId = revision.id;
          record.sessionTitle = session.title;
          record.updatedAt = now;
        }
        catalogChanged = true;
        revisions.push(structuredClone(revision));
      }
      if (catalogChanged) await this.saveCatalog();
      return revisions;
    });
  }

  getWorkspaceFileProvenance(sessionId: string, pathInput: string): WorkspaceFileProvenance | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    const path = normalizeWorkspaceRelativePath(this.workspacePath(sessionId), pathInput);
    const file = this.catalog.workspaceFileRecords.find((candidate) =>
      candidate.sessionId === sessionId && candidate.path === path && !candidate.deletedAt);
    if (!file) return undefined;
    const currentRevision = this.catalog.workspaceFileRevisions.find((candidate) =>
      candidate.id === file.currentRevisionId && candidate.fileId === file.id);
    if (!currentRevision) return undefined;
    const revisions = this.catalog.workspaceFileRevisions
      .filter((candidate) => candidate.fileId === file.id)
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
    const sourceSessionFor = (record: WorkspaceFileRecord) => {
      const liveSession = this.catalog.sessions.find((candidate) => candidate.id === record.sessionId);
      return {
        deleted: !liveSession,
        id: record.sessionId,
        title: liveSession?.title ?? record.sessionTitle,
      };
    };
    const lineage: WorkspaceFileProvenance["lineage"] = [];
    const visited = new Set<string>();
    let parentRevisionId = currentRevision.parentRevisionId;
    while (parentRevisionId && lineage.length < 20 && !visited.has(parentRevisionId)) {
      visited.add(parentRevisionId);
      const parentRevision = this.catalog.workspaceFileRevisions.find((candidate) =>
        candidate.id === parentRevisionId && candidate.projectId === session.projectId);
      if (!parentRevision) break;
      const parentFile = this.catalog.workspaceFileRecords.find((candidate) => candidate.id === parentRevision.fileId);
      if (!parentFile) break;
      lineage.push({
        fileId: parentFile.id,
        origin: parentRevision.origin,
        path: parentRevision.path,
        revisionId: parentRevision.id,
        session: sourceSessionFor(parentFile),
      });
      parentRevisionId = parentRevision.parentRevisionId;
    }
    const artifacts = currentRevision.artifactVersionIds.flatMap((versionId) => {
      const version = this.catalog.artifactVersions.find((candidate) =>
        candidate.id === versionId && candidate.projectId === session.projectId);
      if (!version) return [];
      const artifact = this.catalog.artifacts.find((candidate) => candidate.id === version.artifactId);
      if (!artifact) return [];
      return [{ artifactId: artifact.id, name: artifact.name, version: version.version, versionId }];
    });
    return structuredClone({
      artifacts,
      currentRevision,
      file,
      lineage,
      revisions,
      sourceSession: sourceSessionFor(file),
    });
  }

  listArtifacts(sessionId: string): ScientificArtifact[] {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return this.listProjectArtifacts(session.projectId);
  }

  /**
   * Declared Artifact versions that this Session's agent or subagents produced.
   *
   * The project-level Artifact catalog intentionally represents the latest
   * logical product, while a conversation needs the exact version generated in
   * one Session. `turnId` is required because older or user-uploaded versions
   * cannot be safely attached to a chat Run.
   */
  listSessionArtifactOutputs(sessionId: string): SessionArtifactOutput[] {
    const session = this.getSession(sessionId);
    if (!session) throw new SessionStoreHttpError("Session not found", 404);
    const artifactsById = new Map(this.catalog.artifacts
      .filter((artifact) => artifact.projectId === session.projectId && !artifact.deletedAt)
      .map((artifact) => [artifact.id, artifact]));
    const outputs = this.catalog.artifactVersions.flatMap((version) => {
      if (version.projectId !== session.projectId || version.sessionId !== sessionId || !version.turnId) return [];
      const artifact = artifactsById.get(version.artifactId);
      return artifact ? [{ artifact, version } satisfies SessionArtifactOutput] : [];
    });
    return structuredClone(outputs).toSorted((left, right) =>
      left.version.createdAt.localeCompare(right.version.createdAt)
      || left.version.version - right.version.version,
    );
  }

  listProjectArtifacts(projectId: string): ScientificArtifact[] {
    if (!this.getProject(projectId)) throw new Error("Project not found");
    return structuredClone(this.catalog.artifacts.filter((artifact) => artifact.projectId === projectId && !artifact.deletedAt))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getArtifact(sessionId: string, artifactId: string): ScientificArtifact | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    return this.getProjectArtifact(session.projectId, artifactId);
  }

  getProjectArtifact(projectId: string, artifactId: string): ScientificArtifact | undefined {
    const artifact = this.catalog.artifacts.find((candidate) => candidate.id === artifactId && candidate.projectId === projectId);
    return artifact ? structuredClone(artifact) : undefined;
  }

  async deleteArtifact(projectId: string, artifactId: string): Promise<ScientificArtifact> {
    if (!this.getProject(projectId)) throw new SessionStoreHttpError("Project not found", 404);
    const artifact = this.catalog.artifacts.find((candidate) => candidate.id === artifactId && candidate.projectId === projectId);
    if (!artifact) throw new SessionStoreHttpError("Artifact not found", 404);
    if (artifact.deletedAt) return structuredClone(artifact);
    const now = new Date().toISOString();
    artifact.deletedAt = now;
    artifact.updatedAt = now;
    await this.saveCatalog();
    return structuredClone(artifact);
  }

  getArtifactByName(sessionId: string, name: string): ScientificArtifact | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    const artifact = this.catalog.artifacts.find((candidate) =>
      candidate.projectId === session.projectId && candidate.name === name && !candidate.deletedAt);
    return artifact ? structuredClone(artifact) : undefined;
  }

  listArtifactVersions(sessionId: string, artifactId: string): ScientificArtifactVersion[] {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return this.listProjectArtifactVersions(session.projectId, artifactId);
  }

  listProjectArtifactVersions(projectId: string, artifactId: string): ScientificArtifactVersion[] {
    if (!this.getProjectArtifact(projectId, artifactId)) throw new Error("Artifact not found");
    return structuredClone(this.catalog.artifactVersions.filter((version) => version.artifactId === artifactId))
      .toSorted((left, right) => left.version - right.version);
  }

  getArtifactVersion(sessionId: string, versionId: string): ScientificArtifactVersion | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    return this.getProjectArtifactVersion(session.projectId, versionId);
  }

  getProjectArtifactVersion(projectId: string, versionId: string): ScientificArtifactVersion | undefined {
    const version = this.catalog.artifactVersions.find((candidate) => candidate.id === versionId && candidate.projectId === projectId);
    return version ? structuredClone(version) : undefined;
  }

  /** The newest version of a report-style artifact (markdown/latex/report)
   * in a session. Used to back-fill chip references after declare_claim runs,
   * because the report file is written (and its version created) BEFORE
   * declare_claim produces the chip_map — see the provenance recorder. */
  latestReportVersion(sessionId: string): { artifactId: string; versionId: string } | undefined {
    const reportKinds = new Set(["markdown", "latex", "report"]);
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    const reportArtifacts = this.catalog.artifacts
      .filter((artifact) => artifact.projectId === session.projectId && !artifact.deletedAt && reportKinds.has(artifact.kind))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    for (const artifact of reportArtifacts) {
      const versions = this.catalog.artifactVersions
        .filter((version) => version.artifactId === artifact.id && version.sessionId === sessionId)
        .sort((left, right) => right.version - left.version);
      const latest = versions[0];
      if (latest) return { artifactId: artifact.id, versionId: latest.id };
    }
    return undefined;
  }

  /** Back-fill chip references onto a report version after declare_claim
   * produced its chip_map. Idempotent: callers skip when references already
   * set. Persists immediately so chips survive reloads. */
  updateArtifactVersionReferences(sessionId: string, versionId: string, references: ComposerReference[]): void {
    const version = this.catalog.artifactVersions
      .find((candidate) => candidate.id === versionId && candidate.sessionId === sessionId);
    if (!version) return;
    version.references = structuredClone(references);
    void this.saveCatalog();
  }

  /** Non-destructive snapshot of the chip references on the newest report
   * version (markdown/latex/report). Returns the cloned list so a caller can
   * copy them onto the assistant message that carries the same report prose —
   * the message is what the conversation transcript renders when a run has no
   * replayable timeline (failed run, empty assistantMessageId), and without
   * these references its [alias] tokens would render as plain text. Empty
   * when the session has no report version or the version carries no chips. */
  latestReportReferences(sessionId: string): ComposerReference[] {
    const latest = this.latestReportVersion(sessionId);
    if (!latest) return [];
    const version = this.getArtifactVersion(sessionId, latest.versionId);
    return structuredClone(version?.references ?? []);
  }

  /** Back-fill chip references onto an assistant message so the conversation
   * transcript renders [alias] tokens as clickable chips the same way the
   * report Artifact preview does. Persists immediately so chips survive
   * reloads. No-op when the message is gone or already carries references. */
  async updateMessageReferences(sessionId: string, messageId: string, references: ComposerReference[]): Promise<void> {
    if (!references.length) return;
    const messages = await this.readMessages(sessionId);
    const message = messages.find((candidate) => candidate.id === messageId);
    if (!message || message.references?.length) return;
    message.references = structuredClone(references);
    await writeFile(this.messagesPath(sessionId), `${JSON.stringify(messages, null, 2)}\n`, "utf8");
  }

  async createArtifactVersion(input: {
    content: CasObjectRef;
    description?: string;
    executionRunIds?: string[];
    inputArtifactVersionIds?: string[];
    kind: ScientificArtifactKind;
    logicalName: string;
    mediaType: string;
    origin?: ArtifactOrigin;
    originMeta?: ArtifactOriginMeta;
    /** Chip references for a report version (alias → graph node). Persisted on
     * the version so chips survive reloads; absent on non-report versions. */
    references?: ComposerReference[];
    sessionId: string;
    sourcePath?: string;
    title?: string;
    turnId?: string;
  }): Promise<{ artifact: ScientificArtifact; version: ScientificArtifactVersion }> {
    this.assertSessionWritable(input.sessionId);
    const session = this.getSession(input.sessionId)!;
    const projectId = session.projectId;
    const logicalName = input.logicalName?.trim();
    if (!logicalName || logicalName.startsWith("/") || logicalName.includes("\0") || logicalName.includes("\n")
      || logicalName.split("/").some((part) => !part || part === "." || part === "..") || logicalName.length > 2_000) {
      throw new Error("Artifact logical name must be a safe relative workspace path");
    }
    const allowedKinds = SCIENTIFIC_ARTIFACT_KIND_SET;
    if (!allowedKinds.has(input.kind)) throw new Error("Unsupported scientific artifact kind");
    if (!/^[a-f0-9]{64}$/.test(input.content.hash) || !Number.isSafeInteger(input.content.size) || input.content.size < 0) {
      throw new Error("Artifact content reference is invalid");
    }
    const dependencies = [...new Set(input.inputArtifactVersionIds ?? [])];
    if (dependencies.some((id) => !this.catalog.artifactVersions.some((version) => version.id === id && version.projectId === projectId))) {
      throw new Error("Artifact dependency must reference a version in the same Project");
    }
    const now = new Date().toISOString();
    let artifact = this.catalog.artifacts.find((candidate) =>
      candidate.projectId === projectId && candidate.name === logicalName && !candidate.deletedAt);
    if (artifact && artifact.kind !== input.kind) throw new Error("Artifact kind cannot change across versions");
    if (artifact?.origin === "server_generated" && (input.origin ?? "llm_declared") !== "server_generated") {
      throw new Error("Server-generated Artifacts accept new versions only from a server-generated writer");
    }
    if (!artifact) {
      artifact = {
        createdAt: now,
        createdInSessionId: input.sessionId,
        createdInSessionTitle: session.title,
        currentVersion: 0,
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
        id: randomUUID(),
        kind: input.kind,
        logicalName,
        name: logicalName,
        origin: input.origin ?? "llm_declared",
        ...(input.originMeta ? { originMeta: structuredClone(input.originMeta) } : {}),
        projectId,
        sessionId: input.sessionId,
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        updatedAt: now,
      };
      this.catalog.artifacts.push(artifact);
    } else {
      if (input.description?.trim()) artifact.description = input.description.trim();
      if (input.title?.trim()) artifact.title = input.title.trim();
    }
    const version: ScientificArtifactVersion = {
      artifactId: artifact.id,
      content: structuredClone(input.content),
      createdAt: now,
      executionRunIds: [...new Set(input.executionRunIds ?? [])],
      id: randomUUID(),
      inputArtifactVersionIds: dependencies,
      mediaType: input.mediaType,
      projectId,
      ...(input.references?.length ? { references: structuredClone(input.references) } : {}),
      sessionId: input.sessionId,
      ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      version: artifact.currentVersion + 1,
    };
    artifact.currentVersion = version.version;
    artifact.updatedAt = now;
    this.catalog.artifactVersions.push(version);
    await this.saveCatalog();
    return { artifact: structuredClone(artifact), version: structuredClone(version) };
  }

  listArtifactAnnotations(sessionId: string, versionId?: string): ArtifactAnnotation[] {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return structuredClone(this.catalog.artifactAnnotations.filter((annotation) => annotation.sessionId === sessionId
      && (!versionId || annotation.artifactVersionId === versionId)));
  }

  async createArtifactAnnotation(
    sessionId: string,
    versionId: string,
    input: CreateArtifactAnnotationRequest,
  ): Promise<ArtifactAnnotation> {
    this.assertSessionWritable(sessionId);
    const version = this.getArtifactVersion(sessionId, versionId);
    if (!version) throw new Error("Artifact version not found");
    const artifact = this.getArtifact(sessionId, version.artifactId);
    if (!artifact || (artifact.kind !== "figure" && artifact.kind !== "html")) {
      throw new Error("Annotations are supported for figure and HTML artifacts");
    }
    const note = input.note?.trim();
    if (!note || note.length > 2_000) throw new Error("Annotation note must be 1-2000 characters");
    for (const [name, value] of Object.entries({ height: input.height, width: input.width, x: input.x, y: input.y })) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) throw new Error(`Annotation ${name} must be between 0 and 1`);
    }
    if ((input.width ?? 0) + input.x > 1 || (input.height ?? 0) + input.y > 1) throw new Error("Annotation region must stay inside the artifact");
    const annotation: ArtifactAnnotation = {
      artifactLogicalName: artifact.logicalName,
      artifactVersionId: version.id,
      createdAt: new Date().toISOString(),
      ...(input.height !== undefined ? { height: input.height } : {}),
      id: randomUUID(),
      note,
      sessionId,
      status: "pending",
      ...(input.width !== undefined ? { width: input.width } : {}),
      x: input.x,
      y: input.y,
    };
    this.catalog.artifactAnnotations.push(annotation);
    await this.saveCatalog();
    return structuredClone(annotation);
  }

  async attachArtifactAnnotations(sessionId: string, annotationIds: string[], messageId: string): Promise<ArtifactAnnotation[]> {
    if (annotationIds.length > 16) throw new Error("A message can attach at most 16 artifact annotations");
    const uniqueIds = [...new Set(annotationIds)];
    const annotations = uniqueIds.map((id) => this.catalog.artifactAnnotations.find((annotation) => annotation.id === id
      && annotation.sessionId === sessionId));
    if (annotations.some((annotation) => !annotation || annotation.status !== "pending")) {
      throw new Error("Artifact annotation is unavailable or already attached");
    }
    for (const annotation of annotations as ArtifactAnnotation[]) {
      annotation.attachedMessageId = messageId;
      annotation.status = "attached";
    }
    await this.saveCatalog();
    return structuredClone(annotations as ArtifactAnnotation[]);
  }

  /** Which secrets exist for a machine; the values themselves never leave the API. */
  private describeRemoteHostSecrets(host: RemoteHostTarget): RemoteHostTarget {
    const privateKey = this.remoteHostSecret(host.id, "privateKey");
    // Only the public half is ever described: it is what the user has to install
    // on the remote machine, and it is safe to show.
    const publicKey = privateKey ? openSshPublicKey(privateKey, `sciencediscovery@${host.alias}`) : undefined;
    return {
      ...host,
      hasPassword: this.remoteHostSecret(host.id, "password") !== undefined,
      hasPrivateKey: privateKey !== undefined,
      hasToken: this.remoteHostSecret(host.id, "token") !== undefined,
      ...(publicKey ? { publicKey } : {}),
      ...(host.trustedHostKey
        ? {
          hostKey: {
            algorithm: host.trustedHostKey.algorithm,
            fingerprint: host.trustedHostKey.fingerprint,
            trusted: true,
          },
        }
        : {}),
    };
  }

  listRemoteHosts(): RemoteHostTarget[] {
    return structuredClone(this.catalog.remoteHosts)
      .map((host) => this.describeRemoteHostSecrets(host))
      .toSorted((left, right) => left.alias.localeCompare(right.alias));
  }

  getRemoteHost(hostId: string): RemoteHostTarget | undefined {
    const host = this.catalog.remoteHosts.find((candidate) => candidate.id === hostId);
    return host ? this.describeRemoteHostSecrets(structuredClone(host)) : undefined;
  }

  /**
   * Everything needed to reach an SSH machine: where it is, who to log in as,
   * the secret that proves it, and the key the user accepted. Assembled here so
   * probing, deployment and the runner tunnel cannot drift apart.
   */
  remoteHostSshAccess(hostId: string): {
    credentials: { passphrase?: string; password?: string; privateKey?: string; username: string };
    destination: string;
    port?: number;
    trustedHostKey?: { algorithm: string; fingerprint: string };
  } {
    const host = this.getRemoteHost(hostId);
    if (!host) throw new Error("Remote host not found");
    if (host.connectionKind !== "ssh") throw new Error(`${host.alias} is a self-deployed runner, not an SSH machine`);
    const passphrase = this.remoteHostSecret(hostId, "passphrase");
    const password = this.remoteHostSecret(hostId, "password");
    const privateKey = this.remoteHostSecret(hostId, "privateKey");
    return {
      credentials: {
        ...(passphrase ? { passphrase } : {}),
        ...(password ? { password } : {}),
        ...(privateKey ? { privateKey } : {}),
        username: host.username ?? "",
      },
      // The name the user typed is the record's identity; what it resolves to
      // is only different when an `ssh_config` entry named a different HostName.
      destination: host.hostName ?? host.alias,
      ...(host.port === undefined ? {} : { port: host.port }),
      ...(host.trustedHostKey
        ? { trustedHostKey: { algorithm: host.trustedHostKey.algorithm, fingerprint: host.trustedHostKey.fingerprint } }
        : {}),
    };
  }

  /**
   * Store key material for a machine: either a key file this host could read or
   * a pair the product generated. The material only ever arrives from the API
   * process itself — it is never accepted from a browser.
   */
  async setRemoteHostPrivateKey(hostId: string, privateKey: string | null): Promise<RemoteHostTarget> {
    const host = this.catalog.remoteHosts.find((candidate) => candidate.id === hostId);
    if (!host) throw new Error("Remote host not found");
    this.setRemoteHostSecret(hostId, "privateKey", privateKey);
    host.updatedAt = new Date().toISOString();
    await this.saveCatalog();
    return this.describeRemoteHostSecrets(structuredClone(host));
  }

  /** Record the key a user accepted for a machine, replacing any earlier one. */
  async trustRemoteHostKey(hostId: string, key: { algorithm: string; fingerprint: string }): Promise<RemoteHostTarget> {
    const host = this.catalog.remoteHosts.find((candidate) => candidate.id === hostId);
    if (!host) throw new Error("Remote host not found");
    const algorithm = key.algorithm?.trim();
    const fingerprint = key.fingerprint?.trim();
    if (!algorithm || !/^[A-Za-z0-9@.-]{1,80}$/.test(algorithm)) throw new Error("The host key algorithm is invalid");
    if (!fingerprint || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new Error("The host key fingerprint is invalid");
    host.trustedHostKey = { algorithm, fingerprint, trustedAt: new Date().toISOString() };
    host.updatedAt = new Date().toISOString();
    await this.saveCatalog();
    return this.describeRemoteHostSecrets(structuredClone(host));
  }

  async registerRemoteHost(input: {
    id?: string;
    runnerName?: string;
    description?: string;
    alias: string;
    capabilities?: RemoteHostCapabilities;
    connectionKind?: RemoteHostConnectionKind;
    endpoint?: RemoteHostEndpoint;
    error?: string;
    /** SSH port; undefined preserves an existing value, null clears it. */
    port?: number | null;
    runnerCommand?: string;
    /** Connection token of a self-deployed runner; `undefined` keeps the stored one. */
    token?: string;
    /** SSH login user; `undefined` keeps the stored one. */
    username?: string;
    /** Address to connect to when it differs from the name the user typed. */
    hostName?: string;
    /** SSH secrets; `undefined` keeps what is stored, `null` forgets it. */
    password?: string | null;
    privateKey?: string | null;
    passphrase?: string | null;
    trustHostKey?: { algorithm: string; fingerprint: string };
  }): Promise<RemoteHostTarget> {
    const alias = input.alias.trim();
    if (!/^[A-Za-z0-9._-]{1,255}$/.test(alias)) {
      throw new Error("A machine name must be an alias, hostname, or IP address using only letters, numbers, dots, underscores, and hyphens");
    }
    const port = input.connectionKind === "direct" ? undefined : normalizeSshPort(input.port);
    const runnerCommand = (input.runnerCommand ?? "sciencediscovery-runner").trim();
    if (!/^(?:[A-Za-z0-9._-]+|\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+)$/.test(runnerCommand)) {
      throw new Error("Invalid remote runner executable");
    }
    const connectionKind = input.connectionKind ?? "ssh";
    const endpoint = connectionKind === "direct" ? normalizeRemoteHostEndpoint(input.endpoint) : undefined;
    const now = new Date().toISOString();
    const existing = input.id
      ? this.catalog.remoteHosts.find((host) => host.id === input.id)
      : input.runnerName === undefined ? this.catalog.remoteHosts.find((host) => host.alias === alias) : undefined;
    if (input.id && !existing) throw new Error("Runner not found");
    const runnerName = input.runnerName?.trim();
    if (runnerName !== undefined && (!runnerName || runnerName.length > 120)) throw new Error("Runner name must contain 1-120 characters");
    if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 2000)) throw new Error("Runner description must contain at most 2000 characters");
    if (existing && existing.connectionKind !== connectionKind) {
      throw new Error(`A ${existing.connectionKind === "ssh" ? "SSH" : "self-deployed"} runner named ${alias} already exists`);
    }
    const host: RemoteHostTarget = existing ?? {
      alias,
      connectionKind,
      createdAt: now,
      id: randomUUID(),
      runnerCommand,
      status: "error",
      updatedAt: now,
    };
    host.updatedAt = now;
    if (!existing && runnerName) host.workspaceNamespace = host.id;
    if (runnerName !== undefined) host.runnerName = runnerName;
    if (input.description !== undefined) host.description = input.description.trim();
    host.runnerCommand = runnerCommand;
    if (endpoint) host.endpoint = endpoint;
    if (input.port !== undefined || connectionKind === "direct") {
      if (port === undefined) delete host.port;
      else host.port = port;
    }
    if (input.capabilities) {
      host.capabilities = structuredClone(input.capabilities);
      host.status = "ready";
      delete host.error;
    } else {
      host.status = "error";
      host.error = input.error?.slice(0, 2_000) || "SSH probe failed";
    }
    if (connectionKind === "ssh" && input.hostName !== undefined) {
      const hostName = input.hostName.trim();
      if (hostName) host.hostName = hostName;
      else delete host.hostName;
    }
    if (connectionKind === "ssh" && input.username !== undefined) {
      const username = input.username.trim();
      if (username && !/^[A-Za-z0-9._@-]{1,64}$/.test(username)) throw new Error("The SSH user name contains unsupported characters");
      if (username) host.username = username;
      else delete host.username;
    }
    if (!existing) this.catalog.remoteHosts.push(host);
    if (input.token !== undefined) this.setRemoteHostSecret(host.id, "token", input.token);
    if (input.password !== undefined) this.setRemoteHostSecret(host.id, "password", input.password);
    if (input.privateKey !== undefined) this.setRemoteHostSecret(host.id, "privateKey", input.privateKey);
    if (input.passphrase !== undefined) this.setRemoteHostSecret(host.id, "passphrase", input.passphrase);
    if (input.trustHostKey) {
      host.trustedHostKey = {
        algorithm: input.trustHostKey.algorithm,
        fingerprint: input.trustHostKey.fingerprint,
        trustedAt: now,
      };
    }
    await this.saveCatalog();
    return this.describeRemoteHostSecrets(structuredClone(host));
  }

  /**
   * A stored secret of a remote machine: the runner token of a self-deployed
   * runner, or the password, private key or passphrase used to log into an SSH
   * machine. They stay encrypted beside the model credentials and are never
   * written to the catalog JSON or returned over HTTP; only the outbound
   * connection reads them back.
   */
  remoteHostSecret(hostId: string, kind: RemoteHostSecretKind): string | undefined {
    if (!this.database || !this.secretKey) return undefined;
    const row = this.database.prepare("SELECT encrypted_value FROM remote_host_credentials WHERE host_id = ? AND kind = ?")
      .get(hostId, kind) as { encrypted_value: string } | undefined;
    if (!row) return undefined;
    try {
      return decryptSecretValue(this.secretKey, `remote-host:${hostId}:${kind}`, row.encrypted_value);
    } catch {
      // A row this key cannot open is unusable; reporting it as absent lets the
      // user re-enter the secret instead of breaking every host listing.
      return undefined;
    }
  }

  /** Back-compatible name for the self-deployed runner's connection token. */
  remoteHostToken(hostId: string): string | undefined {
    return this.remoteHostSecret(hostId, "token");
  }

  /**
   * Runner tokens lived one-per-host before SSH passwords and keys needed rows
   * of their own. Each is re-encrypted under its new context so a machine's
   * secrets all live in one table under one rule, rather than leaving a row
   * that would fail to decrypt.
   */
  private migrateRemoteHostTokens(): void {
    if (!this.database || !this.secretKey) return;
    const rows = this.database.prepare("SELECT host_id, encrypted_token FROM remote_host_secrets")
      .all() as Array<{ encrypted_token: string; host_id: string }>;
    for (const row of rows) {
      try {
        const token = decryptSecretValue(this.secretKey, `remote-host:${row.host_id}`, row.encrypted_token);
        this.setRemoteHostSecret(row.host_id, "token", token);
      } catch {
        // An unreadable row cannot be used anyway; dropping it lets the user
        // re-enter the token instead of failing every later host read.
      }
    }
    if (rows.length) this.database.exec("DELETE FROM remote_host_secrets");
  }

  private setRemoteHostSecret(hostId: string, kind: RemoteHostSecretKind, value: string | null): void {
    if (!this.database || !this.secretKey) throw new Error("Remote host credential storage is not initialized");
    // Key material is stored byte for byte: an OpenSSH key ends in a newline
    // and trimming it would hand the SSH client something it may not parse.
    const normalized = value === null ? ""
      : kind === "privateKey" ? (value.trim() ? value : "")
      : kind === "token" ? value.trim() : value;
    if (!normalized) {
      this.database.prepare("DELETE FROM remote_host_credentials WHERE host_id = ? AND kind = ?").run(hostId, kind);
      return;
    }
    if (normalized.length > 32_768) throw new Error(`The stored ${kind} is too long`);
    this.database.prepare(
      "INSERT INTO remote_host_credentials (host_id, kind, encrypted_value) VALUES (?, ?, ?)"
      + " ON CONFLICT(host_id, kind) DO UPDATE SET encrypted_value = excluded.encrypted_value",
    ).run(hostId, kind, encryptSecretValue(this.secretKey, `remote-host:${hostId}:${kind}`, normalized));
  }

  async deleteRemoteHost(hostId: string): Promise<void> {
    if (!this.catalog.remoteHosts.some((host) => host.id === hostId)) throw new Error("Remote host not found");
    if (this.catalog.remoteJobs.some((job) => job.card.targetId === hostId)) {
      throw new Error("Remote host is referenced by a job and cannot be deleted");
    }
    if (this.catalog.projects.some((project) => project.remoteRunnerHostIds.includes(hostId))) {
      throw new Error("Remote host is allowed by a Project and cannot be deleted");
    }
    if (this.catalog.sessions.some((session) => session.remoteRunnerHostIds?.includes(hostId))) {
      throw new Error("Remote host is selected by a Session and cannot be deleted");
    }
    this.catalog.remoteHosts = this.catalog.remoteHosts.filter((host) => host.id !== hostId);
    this.database?.prepare("DELETE FROM remote_host_credentials WHERE host_id = ?").run(hostId);
    await this.saveCatalog();
  }

  listRemoteWorkspaceSyncs(sessionId: string): RemoteWorkspaceSyncRecord[] {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return structuredClone(this.catalog.remoteWorkspaceSyncs.filter((record) => record.sessionId === sessionId))
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async appendRemoteWorkspaceSync(record: RemoteWorkspaceSyncRecord): Promise<void> {
    this.assertSessionWritable(record.sessionId);
    this.assertSessionAllowsRemoteRunner(record.sessionId, record.hostId);
    this.catalog.remoteWorkspaceSyncs.push(structuredClone(record));
    await this.saveCatalog();
  }

  listRemoteJobs(sessionId: string): RemoteJob[] {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return structuredClone(this.catalog.remoteJobs.filter((job) => job.sessionId === sessionId))
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRemoteJob(sessionId: string, jobId: string): RemoteJob | undefined {
    const job = this.catalog.remoteJobs.find((candidate) => candidate.id === jobId && candidate.sessionId === sessionId);
    return job ? structuredClone(job) : undefined;
  }

  async createRemoteJob(
    sessionId: string,
    input: CreateRemoteJobRequest,
    context: { executionId?: string; toolCallId?: string } = {},
  ): Promise<RemoteJob> {
    const session = this.assertSessionWritable(sessionId);
    const host = this.getRemoteHost(input.hostId);
    if (!host || host.status !== "ready" || !host.capabilities) throw new Error("Remote host is not ready");
    if (input.mode !== "ssh" && input.mode !== "slurm") throw new Error("Remote job mode must be ssh or slurm");
    if (input.mode === "slurm" && !host.capabilities.slurm) throw new Error("Remote host is not SLURM-capable");
    const command = input.command?.trim();
    if (!command || command.length > 50_000 || command.includes("\0")) throw new Error("Remote command must be 1-50000 characters");
    const resources = input.resources;
    if (!resources
      || !Number.isSafeInteger(resources.cpus) || resources.cpus < 1 || resources.cpus > 1_024
      || !Number.isSafeInteger(resources.gpus) || resources.gpus < 0 || resources.gpus > 64
      || !Number.isSafeInteger(resources.memoryMb) || resources.memoryMb < 64 || resources.memoryMb > 16 * 1024 * 1024
      || !Number.isSafeInteger(resources.walltimeMinutes) || resources.walltimeMinutes < 1 || resources.walltimeMinutes > 7 * 24 * 60) {
      throw new Error("Remote resource specification is outside supported bounds");
    }
    if (resources.partition && !/^[A-Za-z0-9._-]{1,80}$/.test(resources.partition)) {
      throw new Error("SLURM partition contains unsupported characters");
    }
    const inputPaths = [...new Set((input.inputPaths ?? []).map((path) => remotePath(path, "Remote input path")))];
    if (inputPaths.length > 50) throw new Error("Remote jobs support at most 50 input paths");
    const outputs = (input.outputs ?? []).map((output) => ({
      disposition: output.disposition,
      path: remotePath(output.path, "Remote output path"),
    }));
    if (outputs.length > 20 || outputs.some((output) => output.disposition !== "pull" && output.disposition !== "remote")) {
      throw new Error("Remote jobs support at most 20 outputs with pull or remote disposition");
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const permission = await this.requestPermission(
      sessionId,
      "remote_job",
      `remote_job:${host.id}:${input.mode}:${id}`,
      `Run ${input.mode.toUpperCase()} job on ${host.alias}: ${command.slice(0, 180)}`,
      context,
    );
    const autoAccepted = permission.allowed;
    const job: RemoteJob = {
      ...(autoAccepted ? { approvedAt: now } : {}),
      card: {
        command,
        inputPaths,
        mode: input.mode,
        outputs,
        remoteWorkingDirectory: remotePath(input.remoteWorkingDirectory, "Remote working directory"),
        resources: structuredClone(resources),
        targetAlias: host.alias,
        targetId: host.id,
      },
      createdAt: now,
      id,
      outputRecords: outputs.map((output) => ({ ...output, status: "pending" })),
      ...(permission.allowed
        ? { permissionAuthorizationId: permission.authorization.id }
        : { permissionRequestId: permission.request.id }),
      scriptReference: `pending:${id}`,
      sessionId,
      state: autoAccepted ? "approved" : "awaiting_approval",
      updatedAt: now,
      version: 1,
    };
    this.catalog.remoteJobs.push(job);
    await this.saveCatalog();
    return structuredClone(job);
  }

  async decideRemoteJob(
    sessionId: string,
    jobId: string,
    input: DecideRemoteJobRequest,
    memoryLostReason?: string,
  ): Promise<RemoteJob> {
    this.assertSessionWritable(sessionId);
    const job = this.catalog.remoteJobs.find((candidate) => candidate.id === jobId && candidate.sessionId === sessionId);
    if (!job) throw new Error("Remote job not found");
    if (job.state !== "awaiting_approval") throw new Error("Remote job is not awaiting approval");
    if (job.version !== input.expectedVersion) throw new Error("Remote job version changed; refresh before deciding");
    const permissionRequest = job.permissionRequestId
      ? this.catalog.permissionRequests.find((request) => request.id === job.permissionRequestId)
      : this.catalog.permissionRequests.find((request) =>
          request.action === "remote_job" && request.resource === job.id);
    if (permissionRequest?.state === "pending") {
      const permission = await this.decidePermissionRequest(
        permissionRequest.id,
        input.decision,
        memoryLostReason,
      );
      job.permissionAuthorizationId = permission.authorization.id;
    } else if (permissionRequest?.permissionAuthorizationId) {
      job.permissionAuthorizationId = permissionRequest.permissionAuthorizationId;
    }
    const allowed = input.decision !== "deny";
    job.state = allowed ? "approved" : "denied";
    if (allowed) job.approvedAt = new Date().toISOString();
    else job.finishedAt = new Date().toISOString();
    job.updatedAt = new Date().toISOString();
    job.version += 1;
    await this.saveCatalog();
    return structuredClone(job);
  }

  async applyRemoteJobPermissionDecision(permissionRequestId: string): Promise<RemoteJob | undefined> {
    const request = this.getPermissionRequest(permissionRequestId);
    if (!request || request.action !== "remote_job") return undefined;
    const job = this.catalog.remoteJobs.find((candidate) =>
      candidate.permissionRequestId === permissionRequestId || candidate.id === request.resource);
    if (!job || job.state !== "awaiting_approval") return job ? structuredClone(job) : undefined;
    job.permissionAuthorizationId = request.permissionAuthorizationId;
    job.state = request.state === "allowed" ? "approved" : "denied";
    const now = new Date().toISOString();
    if (request.state === "allowed") job.approvedAt = now;
    else job.finishedAt = now;
    job.updatedAt = now;
    job.version += 1;
    await this.saveCatalog();
    return structuredClone(job);
  }

  async updateRemoteJob(job: RemoteJob): Promise<RemoteJob> {
    const index = this.catalog.remoteJobs.findIndex((candidate) => candidate.id === job.id && candidate.sessionId === job.sessionId);
    if (index < 0) throw new Error("Remote job not found");
    if (JSON.stringify(this.catalog.remoteJobs[index]!.card) !== JSON.stringify(job.card)) {
      throw new Error("Remote job approval card is immutable");
    }
    this.catalog.remoteJobs[index] = structuredClone(job);
    await this.saveCatalog();
    return structuredClone(job);
  }

  assertSessionWritable(sessionId: string): Session {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (session.archivedAt) throw new Error("Session is archived and read-only");
    return session;
  }

  async archiveSession(sessionId: string): Promise<Session> {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    // Close the wake gate before yielding to catalog persistence. Restore does not reopen it.
    this.notifications.stop(sessionId);
    if (!session.archivedAt) {
      session.archivedAt = new Date().toISOString();
      session.updatedAt = session.archivedAt;
      await this.saveCatalog();
    }
    return session;
  }

  async restoreSession(sessionId: string): Promise<Session> {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (session.archivedAt) {
      delete session.archivedAt;
      session.updatedAt = new Date().toISOString();
      await this.saveCatalog();
    }
    return session;
  }

  getSessionDeletionImpact(sessionId: string): DeletionImpact {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return {
      activeSessionCount: session.archivedAt ? 0 : 1,
      archivedSessionCount: session.archivedAt ? 1 : 0,
      dataCategories: [...SESSION_DATA_CATEGORIES],
      sessionIds: [session.id],
      targetId: session.id,
      targetType: "session",
      totalSessionCount: 1,
    };
  }

  getProjectDeletionImpact(projectId: string): DeletionImpact {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found");
    const sessions = this.listSessions(projectId, "all");
    return {
      activeSessionCount: sessions.filter((session) => !session.archivedAt).length,
      archivedSessionCount: sessions.filter((session) => Boolean(session.archivedAt)).length,
      dataCategories: [...SESSION_DATA_CATEGORIES],
      sessionIds: sessions.map((session) => session.id),
      targetId: project.id,
      targetType: "project",
      totalSessionCount: sessions.length,
    };
  }

  async deleteSession(sessionId: string, confirmationId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (confirmationId !== session.id) throw new Error("Session deletion confirmation does not match the target");
    return this.withDeletionBoundary(() => this.knownSessionDataPaths(session), () => [session.id],
      [resolve(this.dataDir, "projects", session.projectId, "sessions", session.id)], async (operation) => {
    await this.stageDeletion(operation);
    const previousSessions = this.catalog.sessions;
    const previousPermissionEpochs = this.catalog.permissionEpochs;
    const previousPermissionGrants = this.catalog.permissionGrants;
    const previousPermissionRequests = this.catalog.permissionRequests;
    const previousSubagents = this.catalog.subagents;
    const previousRemoteJobs = this.catalog.remoteJobs;
    const previousWorkspaceFileRecords = this.catalog.workspaceFileRecords;
    const previousRemoteWorkspaceSyncs = this.catalog.remoteWorkspaceSyncs;
    const remoteJobIds = new Set(this.catalog.remoteJobs.filter((job) => job.sessionId === session.id).map((job) => job.id));
    try {
      this.catalog.sessions = this.catalog.sessions.filter((item) => item.id !== session.id);
      this.catalog.permissionEpochs = this.catalog.permissionEpochs.filter((epoch) => epoch.sessionId !== session.id);
      this.catalog.permissionRequests = this.catalog.permissionRequests.filter((request) => request.sessionId !== session.id);
      this.catalog.permissionGrants = this.catalog.permissionGrants.filter((grant) => grant.sessionId !== session.id
        && !(grant.action === "remote_job" && remoteJobIds.has(grant.resource)));
      this.catalog.subagents = this.catalog.subagents.filter((subagent) => subagent.sessionId !== session.id);
      this.catalog.remoteJobs = this.catalog.remoteJobs.filter((job) => job.sessionId !== session.id);
      this.catalog.workspaceFileRecords = this.catalog.workspaceFileRecords.map((record) =>
        record.sessionId === session.id ? { ...record, sessionTitle: session.title } : record);
      this.catalog.remoteWorkspaceSyncs = this.catalog.remoteWorkspaceSyncs.filter((record) => record.sessionId !== session.id);
      await this.saveCatalog();
      operation.committed = true;
    } catch (error) {
      this.catalog.sessions = previousSessions;
      this.catalog.permissionEpochs = previousPermissionEpochs;
      this.catalog.permissionGrants = previousPermissionGrants;
      this.catalog.permissionRequests = previousPermissionRequests;
      this.catalog.subagents = previousSubagents;
      this.catalog.remoteJobs = previousRemoteJobs;
      this.catalog.workspaceFileRecords = previousWorkspaceFileRecords;
      this.catalog.remoteWorkspaceSyncs = previousRemoteWorkspaceSyncs;
      await this.rollbackStagedDeletion(operation);
      throw error;
    }
    this.database?.prepare("DELETE FROM permission_authorizations WHERE session_id = ?").run(session.id);
    this.notifications.deleteSession(session.id);
    await this.finishStagedDeletion(operation);
    });
  }

  async deleteProject(projectId: string, confirmationId: string): Promise<void> {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found");
    if (confirmationId !== project.id) throw new Error("Project deletion confirmation does not match the target");
    let sessions: Session[] = [];
    return this.withDeletionBoundary(() => {
      sessions = this.listSessions(projectId, "all");
      return [...sessions.flatMap((session) => this.knownSessionDataPaths(session)), resolve(this.dataDir, "projects", projectId)];
    }, () => sessions.map((session) => session.id),
      [resolve(this.dataDir, "projects", projectId)], async (operation) => {
    await this.stageDeletion(operation);
    const sessionIds = new Set(sessions.map((session) => session.id));
    const previousProjects = this.catalog.projects;
    const previousSessions = this.catalog.sessions;
    const previousPermissionEpochs = this.catalog.permissionEpochs;
    const previousPermissionGrants = this.catalog.permissionGrants;
    const previousPermissionRequests = this.catalog.permissionRequests;
    const previousSubagents = this.catalog.subagents;
    const previousRemoteJobs = this.catalog.remoteJobs;
    const previousRemoteWorkspaceSyncs = this.catalog.remoteWorkspaceSyncs;
    const previousArtifacts = this.catalog.artifacts;
    const previousArtifactVersions = this.catalog.artifactVersions;
    const previousArtifactAnnotations = this.catalog.artifactAnnotations;
    const previousWorkspaceFileRecords = this.catalog.workspaceFileRecords;
    const previousWorkspaceFileRevisions = this.catalog.workspaceFileRevisions;
    const remoteJobIds = new Set(this.catalog.remoteJobs.filter((job) => sessionIds.has(job.sessionId)).map((job) => job.id));
    const projectArtifactIds = new Set(this.catalog.artifacts.filter((artifact) => artifact.projectId === projectId).map((artifact) => artifact.id));
    const projectArtifactVersionIds = new Set(this.catalog.artifactVersions
      .filter((version) => projectArtifactIds.has(version.artifactId))
      .map((version) => version.id));
    try {
      this.catalog.projects = this.catalog.projects.filter((item) => item.id !== projectId);
      this.catalog.sessions = this.catalog.sessions.filter((session) => !sessionIds.has(session.id));
      this.catalog.permissionEpochs = this.catalog.permissionEpochs.filter((epoch) => !sessionIds.has(epoch.sessionId));
      this.catalog.permissionRequests = this.catalog.permissionRequests.filter((request) => request.projectId !== projectId
        && (!request.sessionId || !sessionIds.has(request.sessionId)));
      this.catalog.permissionGrants = this.catalog.permissionGrants.filter((grant) => grant.projectId !== projectId
        && (!grant.sessionId || !sessionIds.has(grant.sessionId))
        && !(grant.action === "remote_job" && remoteJobIds.has(grant.resource)));
      this.catalog.subagents = this.catalog.subagents.filter((subagent) => !sessionIds.has(subagent.sessionId));
      this.catalog.remoteJobs = this.catalog.remoteJobs.filter((job) => !sessionIds.has(job.sessionId));
      this.catalog.remoteWorkspaceSyncs = this.catalog.remoteWorkspaceSyncs.filter((record) => !sessionIds.has(record.sessionId));
      this.catalog.artifacts = this.catalog.artifacts.filter((artifact) => artifact.projectId !== projectId);
      this.catalog.artifactVersions = this.catalog.artifactVersions.filter((version) => !projectArtifactIds.has(version.artifactId));
      this.catalog.artifactAnnotations = this.catalog.artifactAnnotations.filter((annotation) => !projectArtifactVersionIds.has(annotation.artifactVersionId));
      this.catalog.workspaceFileRecords = this.catalog.workspaceFileRecords.filter((record) => record.projectId !== projectId);
      this.catalog.workspaceFileRevisions = this.catalog.workspaceFileRevisions.filter((revision) => revision.projectId !== projectId);
      await this.saveCatalog();
      operation.committed = true;
    } catch (error) {
      this.catalog.projects = previousProjects;
      this.catalog.sessions = previousSessions;
      this.catalog.permissionEpochs = previousPermissionEpochs;
      this.catalog.permissionGrants = previousPermissionGrants;
      this.catalog.permissionRequests = previousPermissionRequests;
      this.catalog.subagents = previousSubagents;
      this.catalog.remoteJobs = previousRemoteJobs;
      this.catalog.remoteWorkspaceSyncs = previousRemoteWorkspaceSyncs;
      this.catalog.artifacts = previousArtifacts;
      this.catalog.artifactVersions = previousArtifactVersions;
      this.catalog.artifactAnnotations = previousArtifactAnnotations;
      this.catalog.workspaceFileRecords = previousWorkspaceFileRecords;
      this.catalog.workspaceFileRevisions = previousWorkspaceFileRevisions;
      await this.rollbackStagedDeletion(operation);
      throw error;
    }
    this.database?.prepare("DELETE FROM permission_authorizations WHERE project_id = ?").run(projectId);
    for (const session of sessions) this.notifications.deleteSession(session.id);
    await this.finishStagedDeletion(operation);
    }, projectId);
  }

  async updateSession(
    sessionId: string,
    changes: UpdateSessionRequest,
  ): Promise<Session> {
    const session = this.assertSessionWritable(sessionId);
    const { approvalMode, remoteRunnerHostIds, reviewCriteria, reviewMode, specialistId, title, ...settingsChanges } = changes;
    const nextTitle = hasOwn(changes, "title") ? requiredLabel(title, "Session title") : session.title;
    const nextSettings = this.normalizeSettings({ ...session.settingsOverrides, ...settingsChanges });
    const nextModel = this.getModel(nextSettings.modelId);
    if (nextModel && (nextSettings.thinkingMode !== undefined || nextSettings.thinkingEffort !== undefined)) {
      const constrained = constrainCatalogThinking(
        nextModel.model,
        nextSettings.thinkingMode,
        nextSettings.thinkingEffort,
        nextModel.facts,
      );
      if (nextSettings.thinkingMode !== undefined) nextSettings.thinkingMode = constrained.mode;
      if (nextSettings.thinkingEffort !== undefined) nextSettings.thinkingEffort = constrained.effort;
    }
    if (approvalMode !== undefined) throw new Error("Use setApprovalMode to change approval policy");
    if (reviewMode !== undefined && reviewMode !== "auto" && reviewMode !== "manual") throw new Error("Invalid review mode");
    if (specialistId && !this.getSpecialist(specialistId)) throw new Error("Specialist not found");
    const nextRemoteRunnerHostIds = remoteRunnerHostIds === undefined || remoteRunnerHostIds === null
      ? undefined
      : this.validateSessionRemoteRunnerHosts(session.projectId, remoteRunnerHostIds);
    session.settingsOverrides = nextSettings;
    session.title = nextTitle;
    if (reviewMode) session.reviewMode = reviewMode;
    if (reviewCriteria !== undefined) session.reviewCriteria = this.normalizeReviewCriteria(reviewCriteria);
    if (specialistId === null) delete session.specialistId;
    else if (specialistId !== undefined) session.specialistId = specialistId;
    // `null` drops the override so the Session follows the Project again; an
    // empty array is a real answer meaning "no remote machine for this Session".
    if (remoteRunnerHostIds === null) delete session.remoteRunnerHostIds;
    else if (nextRemoteRunnerHostIds !== undefined) session.remoteRunnerHostIds = nextRemoteRunnerHostIds;
    session.updatedAt = new Date().toISOString();
    this.syncSessionCompatibility(session);
    await this.saveCatalog();
    return session;
  }

  async compareAndSetSessionTitle(
    sessionId: string,
    expectedTitle: string,
    nextTitle: string,
  ): Promise<Session | undefined> {
    const session = this.assertSessionWritable(sessionId);
    if (session.title !== expectedTitle) return undefined;
    const normalizedTitle = nextTitle.trim().replace(/\s+/gu, " ");
    if (!normalizedTitle) throw new Error("Session title is required");
    session.title = normalizedTitle;
    session.updatedAt = new Date().toISOString();
    await this.saveCatalog();
    return structuredClone(session);
  }

  getPermissionEpoch(epochId: string): PermissionEpoch | undefined {
    return this.catalog.permissionEpochs.find((epoch) => epoch.id === epochId);
  }

  getSessionPermissionEpoch(sessionId: string): PermissionEpoch | undefined {
    const session = this.getSession(sessionId);
    return session ? this.getPermissionEpoch(session.permissionEpochId) : undefined;
  }

  listPermissionEpochs(sessionId: string): PermissionEpoch[] {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return structuredClone(this.catalog.permissionEpochs.filter((epoch) => epoch.sessionId === sessionId));
  }

  async rotatePermissionEpoch(
    sessionId: string,
    reason: string,
    memoryLostReason?: string,
    executeGrantScope?: PermissionGrantScope,
  ): Promise<PermissionEpoch> {
    const session = this.assertSessionWritable(sessionId);
    const epoch = createPermissionEpoch(
      sessionId,
      reason,
      memoryLostReason,
      executeGrantScope,
      this.currentSandboxNetworkAccess(),
    );
    this.catalog.permissionEpochs.push(epoch);
    session.permissionEpochId = epoch.id;
    session.updatedAt = epoch.createdAt;
    await this.saveCatalog();
    return epoch;
  }

  listPermissionRequests(sessionId?: string): PermissionRequest[] {
    const session = sessionId ? this.getSession(sessionId) : undefined;
    if (sessionId && !session) throw new Error("Session not found");
    return structuredClone(this.catalog.permissionRequests.filter((request) => !session
      || request.sessionId === session.id
      || (request.projectId === session.projectId && request.sessionId === undefined)))
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  listPermissionGrants(): PermissionGrant[] {
    return structuredClone(this.catalog.permissionGrants.filter((grant) => grant.state === "active"))
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getPermissionGrant(grantId: string): PermissionGrant | undefined {
    const grant = this.catalog.permissionGrants.find((candidate) => candidate.id === grantId);
    return grant ? structuredClone(grant) : undefined;
  }

  getPermissionRequest(requestId: string): PermissionRequest | undefined {
    const request = this.catalog.permissionRequests.find((candidate) => candidate.id === requestId);
    return request ? structuredClone(request) : undefined;
  }

  listPermissionAuthorizations(
    sessionId: string,
    filters: { executionId?: string } = {},
  ): PermissionAuthorization[] {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    if (!this.database) throw new Error("Catalog database is not initialized");
    const rows = filters.executionId
      ? this.database.prepare(`
          SELECT record_json FROM permission_authorizations
          WHERE session_id = ? AND execution_id = ?
          ORDER BY created_at DESC
        `).all(sessionId, filters.executionId)
      : this.database.prepare(`
          SELECT record_json FROM permission_authorizations
          WHERE session_id = ?
          ORDER BY created_at DESC
        `).all(sessionId);
    return rows.map((row) =>
      parsePermissionAuthorization((row as { record_json: string }).record_json));
  }

  getPermissionAuthorization(authorizationId: string): PermissionAuthorization | undefined {
    if (!this.database) throw new Error("Catalog database is not initialized");
    const row = this.database.prepare(
      "SELECT record_json FROM permission_authorizations WHERE id = ?",
    ).get(authorizationId) as { record_json: string } | undefined;
    return row ? parsePermissionAuthorization(row.record_json) : undefined;
  }

  async ensureLegacyPermissionAuthorization(
    sessionId: string,
    action: PermissionAction,
    resource: string,
    permissionGrantId: string,
  ): Promise<PermissionAuthorization> {
    const existing = this.listPermissionAuthorizations(sessionId)
      .find((authorization) =>
        authorization.action === action
        && authorization.resource === resource
        && authorization.permissionGrantId === permissionGrantId);
    if (existing) return existing;
    const session = this.assertSessionWritable(sessionId);
    const authorization = this.createPermissionAuthorization({
      action,
      outcome: "allowed",
      permissionEpochId: session.permissionEpochId,
      permissionGrantId,
      resource,
      session,
      source: "legacy_grant",
    });
    await this.appendPermissionAuthorizations([authorization]);
    return structuredClone(authorization);
  }

  private createPermissionAuthorization(input: {
    action: PermissionAction;
    executionId?: string;
    outcome: "allowed" | "denied";
    permissionEpochId: string;
    permissionGrantId?: string;
    permissionRequestId?: string;
    resource: string;
    session: Session;
    source: PermissionAuthorizationSource;
    toolCallId?: string;
  }): PermissionAuthorization {
    return {
      action: input.action,
      approvalMode: input.session.approvalMode,
      createdAt: new Date().toISOString(),
      ...(input.executionId ? { executionId: input.executionId } : {}),
      id: randomUUID(),
      outcome: input.outcome,
      permissionEpochId: input.permissionEpochId,
      ...(input.permissionGrantId ? { permissionGrantId: input.permissionGrantId } : {}),
      ...(input.permissionRequestId ? { permissionRequestId: input.permissionRequestId } : {}),
      projectId: input.session.projectId,
      resource: input.resource,
      sessionId: input.session.id,
      source: input.source,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    };
  }

  async requestPermission(
    sessionId: string,
    action: PermissionAction,
    resourceValue: string,
    summaryValue: string,
    context: { executionId?: string; toolCallId?: string } = {},
  ): Promise<
    { allowed: true; authorization: PermissionAuthorization }
    | { allowed: false; request: PermissionRequest }
  > {
    const session = this.assertSessionWritable(sessionId);
    if (!new Set<PermissionAction>(["artifact_download", "code", "connector", "directory", "host", "remote_job"]).has(action)) {
      throw new Error("Unsupported permission action");
    }
    const resource = resourceValue.trim().slice(0, 500);
    const summary = summaryValue.trim().replace(/\s+/g, " ").slice(0, 500);
    if (!resource || !summary) throw new Error("Permission resource and summary are required");
    if (!context.executionId) {
      const approvedPreflight = this.catalog.permissionRequests.findLast((request) =>
        request.sessionId === session.id
        && request.action === action
        && request.resource === resource
        && request.state === "allowed"
        && !request.executionId
        && !request.grantId
        && !request.authorizationConsumedAt
        && Boolean(request.permissionAuthorizationId));
      if (approvedPreflight?.permissionAuthorizationId) {
        const authorization = this.getPermissionAuthorization(approvedPreflight.permissionAuthorizationId);
        if (authorization?.outcome === "allowed") {
          approvedPreflight.authorizationConsumedAt = new Date().toISOString();
          await this.saveCatalog();
          return { allowed: true, authorization };
        }
      }
    }
    if (session.approvalMode === "always_allow") {
      const authorization = this.createPermissionAuthorization({
        action,
        ...context,
        outcome: "allowed",
        permissionEpochId: session.permissionEpochId,
        resource,
        session,
        source: "always_allow",
      });
      await this.appendPermissionAuthorizations([authorization]);
      return { allowed: true, authorization: structuredClone(authorization) };
    }
    const matcherResource = permissionMatcherResource(action, resource);
    const standing = this.catalog.permissionGrants.find((grant) => grant.action === action
      && (grant.resource === matcherResource || grant.resource === resource)
      && grant.state === "active"
      && grant.scope !== "once"
      && (grant.scope === "global"
        || (grant.scope === "project" && grant.projectId === session.projectId)
        || ((grant.scope === "conversation" || grant.scope === "session") && grant.sessionId === session.id)));
    const grant = standing ?? this.catalog.permissionGrants.find((candidate) => candidate.action === action
      && (candidate.resource === matcherResource || candidate.resource === resource)
      && candidate.state === "active"
      && candidate.scope === "once"
      && candidate.sessionId === session.id
      && (candidate.usesRemaining ?? 0) > 0);
    if (grant) {
      if (grant.scope === "once") {
        this.catalog.permissionGrants = this.catalog.permissionGrants.filter((candidate) => candidate.id !== grant.id);
      }
      const authorization = this.createPermissionAuthorization({
        action,
        ...context,
        outcome: "allowed",
        permissionEpochId: session.permissionEpochId,
        permissionGrantId: grant.id,
        resource,
        session,
        source: "existing_grant",
      });
      if (grant.scope === "once") await this.saveCatalogWithAuthorizations([authorization]);
      else await this.appendPermissionAuthorizations([authorization]);
      return { allowed: true, authorization: structuredClone(authorization) };
    }
    const request: PermissionRequest = {
      action,
      createdAt: new Date().toISOString(),
      ...(context.executionId ? { executionId: context.executionId } : {}),
      id: randomUUID(),
      projectId: session.projectId,
      resource,
      sessionId: session.id,
      state: "pending",
      summary,
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
    };
    this.catalog.permissionRequests.push(request);
    await this.saveCatalog();
    return { allowed: false, request: structuredClone(request) };
  }

  async decidePermissionRequest(
    requestId: string,
    decision: PermissionDecision,
    memoryLostReason?: string,
  ): Promise<{
    authorization: PermissionAuthorization;
    authorizations: PermissionAuthorization[];
    grant?: PermissionGrant;
    permissionEpoch: PermissionEpoch;
    request: PermissionRequest;
    resolvedRequests: PermissionRequest[];
  }> {
    const request = this.catalog.permissionRequests.find((candidate) => candidate.id === requestId);
    if (!request) throw new Error("Permission request not found");
    if (request.state !== "pending") throw new Error("Permission request was already decided");
    if (!new Set<PermissionDecision>(["allow_once", "allow_matching", "deny"]).has(decision)) {
      throw new Error("Invalid permission decision");
    }
    if (!request.sessionId) throw new Error("Permission decisions require a Session");
    const session = this.assertSessionWritable(request.sessionId);
    const decidedAt = new Date().toISOString();
    const allowed = decision !== "deny";
    let grant: PermissionGrant | undefined;
    if (decision === "allow_matching") {
      grant = {
        action: request.action,
        createdAt: decidedAt,
        id: randomUUID(),
        resource: permissionMatcherResource(request.action, request.resource),
        scope: "session",
        sessionId: request.sessionId,
        state: "active",
      };
      this.catalog.permissionGrants.push(grant);
    }
    const resolvedRequests = decision === "allow_matching"
      ? this.catalog.permissionRequests.filter((candidate) =>
          candidate.state === "pending"
          && candidate.sessionId === session.id
          && candidate.action === request.action
          && permissionMatcherResource(candidate.action, candidate.resource) === grant!.resource)
      : [request];
    const permissionEpoch = createPermissionEpoch(
      session.id,
      decision === "allow_matching" && resolvedRequests.length > 1
        ? `${resolvedRequests.length} matching ${request.action} permissions allowed`
        : `${request.action} permission ${allowed ? "allowed" : "denied"}`,
      memoryLostReason,
      grant?.scope,
      this.currentSandboxNetworkAccess(),
    );
    this.catalog.permissionEpochs.push(permissionEpoch);
    session.permissionEpochId = permissionEpoch.id;
    session.updatedAt = permissionEpoch.createdAt;
    const authorizations = resolvedRequests.map((resolvedRequest) => {
      resolvedRequest.decidedAt = decidedAt;
      resolvedRequest.decision = allowed ? "allowed" : "denied";
      resolvedRequest.state = allowed ? "allowed" : "denied";
      resolvedRequest.decisionEpochId = permissionEpoch.id;
      if (grant) resolvedRequest.grantId = grant.id;
      const authorization = this.createPermissionAuthorization({
        action: resolvedRequest.action,
        ...(resolvedRequest.executionId ? { executionId: resolvedRequest.executionId } : {}),
        outcome: allowed ? "allowed" : "denied",
        permissionEpochId: permissionEpoch.id,
        ...(grant ? { permissionGrantId: grant.id } : {}),
        permissionRequestId: resolvedRequest.id,
        resource: resolvedRequest.resource,
        session,
        source: decision === "deny"
          ? "user_deny"
          : decision === "allow_matching" && resolvedRequest.id !== request.id
            ? "existing_grant"
            : decision === "allow_matching"
              ? "user_grant"
              : "user_once",
        ...(resolvedRequest.toolCallId ? { toolCallId: resolvedRequest.toolCallId } : {}),
      });
      resolvedRequest.permissionAuthorizationId = authorization.id;
      return authorization;
    });
    const authorization = authorizations.find((candidate) => candidate.permissionRequestId === request.id);
    if (!authorization) throw new Error("Permission decision did not authorize the selected request");
    await this.saveCatalogWithAuthorizations(authorizations);
    return {
      authorization: structuredClone(authorization),
      authorizations: structuredClone(authorizations),
      ...(grant ? { grant: structuredClone(grant) } : {}),
      permissionEpoch: structuredClone(permissionEpoch),
      request: structuredClone(request),
      resolvedRequests: structuredClone(resolvedRequests),
    };
  }

  async cancelPendingPermissionRequest(requestId: string): Promise<PermissionRequest | undefined> {
    const request = this.catalog.permissionRequests.find((candidate) => candidate.id === requestId);
    if (!request || request.state !== "pending") return undefined;
    request.state = "cancelled";
    request.decidedAt = new Date().toISOString();
    await this.saveCatalog();
    return structuredClone(request);
  }

  async cancelPendingPermissionRequests(executionId: string): Promise<PermissionRequest[]> {
    const cancelled = this.catalog.permissionRequests.filter((request) =>
      request.executionId === executionId && request.state === "pending");
    if (!cancelled.length) return [];
    const now = new Date().toISOString();
    for (const request of cancelled) {
      request.state = "cancelled";
      request.decidedAt = now;
    }
    await this.saveCatalog();
    return structuredClone(cancelled);
  }

  async setApprovalMode(
    sessionId: string,
    approvalMode: Session["approvalMode"],
    memoryLostReason?: string,
  ): Promise<{
    authorizations: PermissionAuthorization[];
    permissionEpoch: PermissionEpoch;
    resolvedPendingRequests: PermissionRequest[];
    session: Session;
  }> {
    const session = this.assertSessionWritable(sessionId);
    if (approvalMode !== "always_allow" && approvalMode !== "ask_for_dangerous") {
      throw new Error("Invalid approval mode");
    }
    if (session.approvalMode === approvalMode) {
      const permissionEpoch = this.getSessionPermissionEpoch(sessionId);
      if (!permissionEpoch) throw new Error("Permission Epoch not found");
      return {
        authorizations: [],
        permissionEpoch: structuredClone(permissionEpoch),
        resolvedPendingRequests: [],
        session: structuredClone(session),
      };
    }
    const permissionEpoch = createPermissionEpoch(
      session.id,
      `Approval mode changed to ${approvalMode}`,
      memoryLostReason,
      undefined,
      this.currentSandboxNetworkAccess(),
    );
    session.approvalMode = approvalMode;
    session.permissionEpochId = permissionEpoch.id;
    session.updatedAt = permissionEpoch.createdAt;
    this.catalog.permissionEpochs.push(permissionEpoch);
    const resolvedPendingRequests = approvalMode === "always_allow"
      ? this.catalog.permissionRequests.filter((request) =>
          request.sessionId === session.id && request.state === "pending")
      : [];
    const authorizations = resolvedPendingRequests.map((request) => {
      request.decidedAt = permissionEpoch.createdAt;
      request.decision = "allowed";
      request.decisionEpochId = permissionEpoch.id;
      request.state = "allowed";
      const authorization = this.createPermissionAuthorization({
        action: request.action,
        ...(request.executionId ? { executionId: request.executionId } : {}),
        outcome: "allowed",
        permissionEpochId: permissionEpoch.id,
        permissionRequestId: request.id,
        resource: request.resource,
        session,
        source: "always_allow",
      });
      request.permissionAuthorizationId = authorization.id;
      return authorization;
    });
    await this.saveCatalogWithAuthorizations(authorizations);
    return {
      authorizations: structuredClone(authorizations),
      permissionEpoch: structuredClone(permissionEpoch),
      resolvedPendingRequests: structuredClone(resolvedPendingRequests),
      session: structuredClone(session),
    };
  }

  async revokePermissionGrant(grantId: string, memoryLostReason?: string): Promise<PermissionGrant> {
    const grant = this.catalog.permissionGrants.find((candidate) => candidate.id === grantId);
    if (!grant) throw new Error("Permission grant not found");
    if (grant.state === "revoked") return structuredClone(grant);
    grant.state = "revoked";
    grant.revokedAt = new Date().toISOString();
    if (grant.sessionId) {
      const session = this.assertSessionWritable(grant.sessionId);
      const permissionEpoch = createPermissionEpoch(
        session.id,
        "Permission grant revoked",
        memoryLostReason,
        undefined,
        this.currentSandboxNetworkAccess(),
      );
      this.catalog.permissionEpochs.push(permissionEpoch);
      session.permissionEpochId = permissionEpoch.id;
      session.updatedAt = permissionEpoch.createdAt;
    }
    await this.saveCatalog();
    return structuredClone(grant);
  }

  listEnvironmentRevisions(): EnvironmentRevision[] {
    return [...this.catalog.environmentRevisions];
  }

  listEnvironments(): Environment[] {
    return [...this.catalog.environments];
  }

  async replaceScientificEnvironmentCatalog(
    environments: Environment[],
    revisions: EnvironmentRevision[],
    runnerId = "local",
  ): Promise<void> {
    // Remote execution imports immutable audit revisions, not the local
    // environment picker. Refreshing either Runner must retain past run refs.
    if (runnerId === "local") this.catalog.environments = structuredClone(environments);
    const systemRevisions = this.catalog.environmentRevisions
      .filter((revision) => isSystemEnvironmentRevisionId(revision.id));
    if (!systemRevisions.some((revision) => revision.id === DEFAULT_ENVIRONMENT_REVISION_ID)) {
      systemRevisions.push(defaultEnvironmentRevision());
    }
    if (!systemRevisions.some((revision) => revision.id === defaultShellEnvironmentRevision().id)) {
      systemRevisions.push(defaultShellEnvironmentRevision());
    }
    const retained = new Map(this.catalog.environmentRevisions.map((revision) => [revision.id, revision]));
    for (const revision of [...systemRevisions, ...structuredClone(revisions)]) retained.set(revision.id, revision);
    this.catalog.environmentRevisions = [...retained.values()];
    await this.saveCatalog();
  }

  async getSessionDetail(sessionId: string): Promise<SessionDetail | undefined> {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    return { ...session, messages: await this.readMessages(sessionId) };
  }

  async readMessages(sessionId: string): Promise<ChatMessage[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    try {
      return JSON.parse(await readFile(this.messagesPath(sessionId), "utf8")) as ChatMessage[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async listSessionRuns(sessionId: string): Promise<SessionRun[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return (await this.readArray<SessionRun>(this.sessionRunsPath(sessionId)))
      .toSorted((left, right) => left.queueOrder - right.queueOrder || left.createdAt.localeCompare(right.createdAt));
  }

  async getSessionRun(sessionId: string, runId: string): Promise<SessionRun | undefined> {
    return (await this.listSessionRuns(sessionId)).find((run) => run.id === runId);
  }

  async createSessionRun(input: {
    notificationDelivery?: SessionRun["notificationDelivery"];
    automaticWake?: boolean;
    annotationIds?: string[];
    prompt: string;
    references?: ComposerReference[];
    retryOfRunId?: string;
    sessionId: string;
    settingsSnapshot: SessionRun["settingsSnapshot"];
    skillLibraryRefs?: SessionRun["skillLibraryRefs"];
    webForceRefresh?: boolean;
  }): Promise<SessionRun> {
    this.assertSessionWritable(input.sessionId);
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Message content is required");
    // The whole read-modify-write must stay inside mutateArray: concurrent
    // writers to the same session-runs file would otherwise overwrite each
    // other with stale snapshots (lost update). queueOrder is derived from the
    // latest array inside the barrier for the same reason.
    return await this.mutateArray<SessionRun, SessionRun>(this.sessionRunsPath(input.sessionId), (runs) => {
      const run: SessionRun = {
        ...(input.notificationDelivery ? { notificationDelivery: structuredClone(input.notificationDelivery) } : {}),
        ...(input.automaticWake ? { automaticWake: true } : {}),
        annotationIds: [...new Set(input.annotationIds ?? [])],
        createdAt: new Date().toISOString(),
        id: randomUUID(),
        prompt,
        queueOrder: runs.reduce((max, candidate) => Math.max(max, candidate.queueOrder), 0) + 1,
        references: structuredClone(input.references ?? []),
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
        sessionId: input.sessionId,
        settingsSnapshot: {
          ...structuredClone(input.settingsSnapshot),
          ideaTreeEnabled: input.settingsSnapshot.ideaTreeEnabled === true,
        },
        ...(input.skillLibraryRefs?.length ? { skillLibraryRefs: structuredClone(input.skillLibraryRefs) } : {}),
        ...(input.webForceRefresh ? { webForceRefresh: true } : {}),
        status: "queued",
      };
      runs.push(run);
      return structuredClone(run);
    });
  }

  async updateSessionRun(
    sessionId: string,
    runId: string,
    changes: Partial<Omit<SessionRun, "id" | "queueOrder" | "sessionId">>,
  ): Promise<SessionRun> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.mutateArray<SessionRun, SessionRun>(this.sessionRunsPath(sessionId), (runs) => {
      const index = runs.findIndex((run) => run.id === runId);
      if (index < 0) throw new Error("Run not found");
      const next = { ...runs[index]!, ...structuredClone(changes) };
      runs[index] = next;
      return structuredClone(next);
    });
  }

  async updateSessionRunStatus(
    sessionId: string,
    runId: string,
    status: SessionRunStatus,
    details: Partial<Pick<SessionRun, "assistantMessageId" | "error" | "finishedAt" | "startedAt" | "userMessageId">> = {},
  ): Promise<SessionRun> {
    return await this.updateSessionRun(sessionId, runId, { ...details, status });
  }

  async updateSessionRunStatusIfCurrent(
    sessionId: string,
    runId: string,
    expectedStatus: SessionRunStatus,
    status: SessionRunStatus,
    details: Partial<Pick<SessionRun, "assistantMessageId" | "error" | "finishedAt" | "startedAt" | "userMessageId">> = {},
  ): Promise<SessionRun | undefined> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.mutateArray<SessionRun, SessionRun | undefined>(this.sessionRunsPath(sessionId), (runs) => {
      const index = runs.findIndex((run) => run.id === runId);
      if (index < 0) throw new Error("Run not found");
      if (runs[index]!.status !== expectedStatus) return undefined;
      const next = { ...runs[index]!, ...structuredClone(details), status };
      runs[index] = next;
      return structuredClone(next);
    });
  }

  async listSessionRunEvents(sessionId: string, runId: string, after = 0): Promise<SessionRunEvent[]> {
    return await this.listRunStreamEvents(sessionId, runId, MAIN_RUN_STREAM, after);
  }

  async listRunStreamEvents(
    sessionId: string,
    runId: string,
    streamId: string,
    after = 0,
  ): Promise<SessionRunEvent[]> {
    const run = await this.getSessionRun(sessionId, runId);
    if (!run) throw new Error("Run not found");
    assertValidStreamId(streamId);
    const records: SessionRunEvent[] = [];
    if (streamId === MAIN_RUN_STREAM) {
      records.push(...await this.readArray<SessionRunEvent>(this.sessionRunEventsPath(sessionId, runId)));
    }
    for (const line of await this.readStreamLines(this.runStreamPath(sessionId, runId, streamId))) {
      records.push({ createdAt: line.createdAt, event: line.event, runId, sequence: line.sequence, sessionId });
    }
    return records
      .filter((record) => record.sequence > after)
      .toSorted((left, right) => left.sequence - right.sequence);
  }

  async appendSessionRunEvent(
    sessionId: string,
    runId: string,
    event: SessionRunEvent["event"],
  ): Promise<SessionRunEvent> {
    return await this.appendRunStreamEvent(sessionId, runId, MAIN_RUN_STREAM, event);
  }

  async appendRunStreamEvent(
    sessionId: string,
    runId: string,
    streamId: string,
    event: SessionRunEvent["event"],
  ): Promise<SessionRunEvent> {
    const run = await this.getSessionRun(sessionId, runId);
    if (!run) throw new Error("Run not found");
    assertValidStreamId(streamId);
    const path = this.runStreamPath(sessionId, runId, streamId);
    const previous = this.streamAppendQueues.get(path) ?? Promise.resolve();
    const append = previous.then(async () => {
      let last = this.streamTailSequences.get(path);
      if (last === undefined) {
        await mkdir(this.runStreamDir(sessionId, runId), { recursive: true });
        last = await this.recoverStreamTail(sessionId, runId, streamId);
      }
      const sequence = last + 1;
      const createdAt = new Date().toISOString();
      // The persisted line omits sessionId/runId: both are implied by the file
      // path, and the envelope repeats for every streamed delta.
      await appendFile(path, `${JSON.stringify({ createdAt, event, sequence })}\n`, "utf8");
      this.streamTailSequences.set(path, sequence);
      return {
        createdAt,
        event: structuredClone(event),
        runId,
        sequence,
        sessionId,
      } satisfies SessionRunEvent;
    });
    const barrier = append.then(() => undefined, () => undefined);
    this.streamAppendQueues.set(path, barrier);
    try {
      return await append;
    } finally {
      if (this.streamAppendQueues.get(path) === barrier) this.streamAppendQueues.delete(path);
    }
  }

  /**
   * First append to a stream in this process: repair a torn tail left by a
   * crash mid-write, then resume the sequence counter. The main stream also
   * continues past a pre-stream `<runId>.json` array so recovery events for
   * legacy runs keep monotonic sequences.
   */
  private async recoverStreamTail(sessionId: string, runId: string, streamId: string): Promise<number> {
    const path = this.runStreamPath(sessionId, runId, streamId);
    let last = 0;
    let content = "";
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (content && !content.endsWith("\n")) {
      const lastNewline = content.lastIndexOf("\n");
      content = lastNewline >= 0 ? content.slice(0, lastNewline + 1) : "";
      await writeFile(path, content, "utf8");
    }
    for (const record of parseStreamLines(content)) {
      last = Math.max(last, record.sequence);
    }
    if (streamId === MAIN_RUN_STREAM) {
      for (const record of await this.readArray<SessionRunEvent>(this.sessionRunEventsPath(sessionId, runId))) {
        last = Math.max(last, record.sequence);
      }
    }
    return last;
  }

  private async readStreamLines(path: string): Promise<RunStreamLine[]> {
    let content = "";
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return parseStreamLines(content);
  }

  async listExecutionRuns(sessionId: string): Promise<ExecutionRun[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.readArray<ExecutionRun>(this.executionRunsPath(sessionId));
  }

  async appendExecutionRun(run: ExecutionRun): Promise<void> {
    this.assertSessionWritable(run.sessionId);
    await this.mutateArray<ExecutionRun, void>(this.executionRunsPath(run.sessionId), (runs) => {
      runs.push(run);
    });
  }

  async listArtifactDerivations(sessionId: string): Promise<ArtifactDerivation[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.readArray<ArtifactDerivation>(this.artifactDerivationsPath(sessionId));
  }

  async appendArtifactPlan(plan: ArtifactPlan): Promise<void> {
    this.assertSessionWritable(plan.sessionId);
    const values = await this.listArtifactPlans(plan.sessionId);
    values.push(plan);
    await this.writeArray(this.artifactPlansPath(plan.sessionId), values);
  }

  async listArtifactPlans(sessionId: string): Promise<ArtifactPlan[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.readArray<ArtifactPlan>(this.artifactPlansPath(sessionId));
  }

  async replaceArtifactPlan(plan: ArtifactPlan): Promise<void> {
    this.assertSessionWritable(plan.sessionId);
    const values = await this.listArtifactPlans(plan.sessionId);
    const index = values.findIndex((candidate) => candidate.id === plan.id);
    if (index < 0) throw new Error("Artifact plan not found");
    values[index] = plan;
    await this.writeArray(this.artifactPlansPath(plan.sessionId), values);
  }

  async appendArtifactJob(job: ArtifactJob): Promise<void> {
    this.assertSessionWritable(job.sessionId);
    await this.mutateArray<ArtifactJob, void>(this.artifactJobsPath(job.sessionId), (values) => {
      values.push(job);
    });
  }

  async listArtifactJobs(sessionId: string): Promise<ArtifactJob[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.readArray<ArtifactJob>(this.artifactJobsPath(sessionId));
  }

  async replaceArtifactJob(job: ArtifactJob): Promise<void> {
    this.assertSessionWritable(job.sessionId);
    await this.mutateArray<ArtifactJob, void>(this.artifactJobsPath(job.sessionId), (values) => {
      const index = values.findIndex((candidate) => candidate.id === job.id);
      if (index < 0) throw new Error("Artifact job not found");
      values[index] = job;
    });
  }

  async appendArtifactExtractionJob(job: ArtifactExtractionJob): Promise<void> {
    this.assertSessionWritable(job.sessionId);
    const values = await this.listArtifactExtractionJobs(job.sessionId);
    values.push(job);
    await this.writeArray(this.artifactExtractionJobsPath(job.sessionId), values);
  }

  async listArtifactExtractionJobs(sessionId: string): Promise<ArtifactExtractionJob[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.readArray<ArtifactExtractionJob>(this.artifactExtractionJobsPath(sessionId));
  }

  async replaceArtifactExtractionJob(job: ArtifactExtractionJob): Promise<void> {
    this.assertSessionWritable(job.sessionId);
    const values = await this.listArtifactExtractionJobs(job.sessionId);
    const index = values.findIndex((candidate) => candidate.id === job.id);
    if (index < 0) throw new Error("Artifact extraction job not found");
    values[index] = job;
    await this.writeArray(this.artifactExtractionJobsPath(job.sessionId), values);
  }

  async appendArtifactDerivations(sessionId: string, additions: ArtifactDerivation[]): Promise<void> {
    this.assertSessionWritable(sessionId);
    const derivations = await this.listArtifactDerivations(sessionId);
    derivations.push(...additions);
    await this.writeArray(this.artifactDerivationsPath(sessionId), derivations);
  }

  async listPromptManifests(sessionId: string): Promise<PromptManifest[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.readArray<PromptManifest>(this.promptManifestsPath(sessionId));
  }

  async appendPromptManifest(manifest: PromptManifest): Promise<void> {
    this.assertSessionWritable(manifest.sessionId);
    const manifests = await this.listPromptManifests(manifest.sessionId);
    manifests.push(manifest);
    await this.writeArray(this.promptManifestsPath(manifest.sessionId), manifests);
  }

  private normalizeModelInvocationUsage(usage: ModelInvocationUsage): ModelInvocationUsage {
    const session = this.getSession(usage.sessionId);
    return {
      ...usage,
      cacheReadTokens: usage.cacheReadTokens ?? null,
      cacheWriteTokens: usage.cacheWriteTokens ?? null,
      outcome: usage.outcome ?? "completed",
      ...(usage.projectId || session?.projectId ? { projectId: usage.projectId ?? session?.projectId } : {}),
    };
  }

  async listModelInvocationUsage(sessionId: string): Promise<ModelInvocationUsage[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    const records = await this.readArray<ModelInvocationUsage>(this.modelUsagePath(sessionId));
    return records.map((usage) => this.normalizeModelInvocationUsage(usage));
  }

  async appendModelInvocationUsage(usage: ModelInvocationUsage): Promise<void> {
    this.assertSessionWritable(usage.sessionId);
    await this.mutateArray<ModelInvocationUsage, void>(
      this.modelUsagePath(usage.sessionId),
      (records) => {
        this.assertSessionWritable(usage.sessionId);
        if (records.some((record) =>
          record.sessionId === usage.sessionId
          && record.invocationId === usage.invocationId
          && record.invocationKind === usage.invocationKind
          && record.attemptIndex === usage.attemptIndex)) {
          return;
        }
        records.push(this.normalizeModelInvocationUsage(usage));
      },
    );
  }

  async getSessionUsageSummary(sessionId: string): Promise<SessionUsageSummary> {
    return summarizeModelUsage(sessionId, await this.listModelInvocationUsage(sessionId));
  }

  async listAllModelInvocationUsage(): Promise<ModelInvocationUsage[]> {
    const records: ModelInvocationUsage[] = [];
    for (const session of this.catalog.sessions) {
      records.push(...await this.listModelInvocationUsage(session.id));
    }
    return records.toSorted((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
  }

  async getGlobalModelUsageSummary(): Promise<GlobalModelUsageSummary> {
    const projectNameById = new Map(this.catalog.projects.map((project) => [project.id, project.name]));
    const projectIdBySessionId = new Map(this.catalog.sessions.map((session) => [session.id, session.projectId]));
    const sessionTitleById = new Map(this.catalog.sessions.map((session) => [session.id, session.title]));
    return summarizeGlobalModelUsage(await this.listAllModelInvocationUsage(), {
      projectIdBySessionId,
      projectNameById,
      sessionTitleById,
    });
  }

  private modelUsagePricingByProfileId(): Map<string, ResolvedModelPricing> {
    const pricingByModelProfileId = new Map<string, ResolvedModelPricing>();
    for (const model of this.catalog.models) {
      const provider = this.getProvider(model.providerId);
      const catalog = lookupModelCatalog(model.model, provider?.presetId);
      const pricing = resolveModelFacts({ catalog, user: model.facts }).pricing;
      if (pricing) pricingByModelProfileId.set(model.id, pricing);
    }
    return pricingByModelProfileId;
  }

  async getModelUsageAnalyticsSummary(filters: ModelUsageAnalyticsFilters = {}): Promise<ModelUsageAnalyticsSummary> {
    const projectNameById = new Map(this.catalog.projects.map((project) => [project.id, project.name]));
    const projectIdBySessionId = new Map(this.catalog.sessions.map((session) => [session.id, session.projectId]));
    const sessionTitleById = new Map(this.catalog.sessions.map((session) => [session.id, session.title]));
    return summarizeModelUsageAnalytics(await this.listAllModelInvocationUsage(), {
      pricingByModelProfileId: this.modelUsagePricingByProfileId(),
      projectIdBySessionId,
      projectNameById,
      sessionTitleById,
    }, filters);
  }

  async listReviews(sessionId: string): Promise<ReviewRun[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.readArray<ReviewRun>(this.reviewsPath(sessionId));
  }

  async listArtifactReviews(sessionId: string, artifactVersionId?: string): Promise<ArtifactReviewRun[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    const reviews = await this.readArray<ArtifactReviewRun>(this.artifactReviewsPath(sessionId));
    return reviews.filter((review) => !artifactVersionId || review.artifactVersionId === artifactVersionId);
  }

  async appendArtifactReview(review: ArtifactReviewRun): Promise<void> {
    this.assertSessionWritable(review.sessionId);
    await this.mutateArray<ArtifactReviewRun, void>(this.artifactReviewsPath(review.sessionId), (reviews) => {
      if (reviews.some((candidate) => candidate.id === review.id)) {
        throw new Error(`Artifact review already exists: ${review.id}`);
      }
      reviews.push(structuredClone(review));
    });
  }

  async listReviewerAuditTasks(sessionId: string): Promise<ReviewerAuditTask[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.readArray<ReviewerAuditTask>(this.reviewerAuditTasksPath(sessionId));
  }

  async createReviewerAuditTask(task: ReviewerAuditTask): Promise<ReviewerAuditTask> {
    this.assertSessionWritable(task.sessionId);
    return await this.mutateArray<ReviewerAuditTask, ReviewerAuditTask>(
      this.reviewerAuditTasksPath(task.sessionId),
      (tasks) => {
        this.assertSessionWritable(task.sessionId);
        const existing = tasks.find((candidate) => candidate.id === task.id
          || (candidate.inputFingerprint === task.inputFingerprint
            && candidate.origin === task.origin
            && candidate.status !== "cancelled"
            && candidate.status !== "failed"
            && candidate.status !== "superseded"));
        if (existing) return structuredClone(existing);
        tasks.push(structuredClone(task));
        return structuredClone(task);
      },
    );
  }

  async updateReviewerAuditTask(
    sessionId: string,
    taskId: string,
    update: Partial<Pick<ReviewerAuditTask,
      "artifactVersionIds" | "checkpointPublishedAt" | "errorSummary" | "finishedAt" | "inputFingerprint"
      | "notBefore" | "reviewIds" | "startedAt" | "status" | "supersededBy">>,
  ): Promise<ReviewerAuditTask> {
    this.assertSessionWritable(sessionId);
    return await this.mutateArray<ReviewerAuditTask, ReviewerAuditTask>(
      this.reviewerAuditTasksPath(sessionId),
      (tasks) => {
        const task = tasks.find((candidate) => candidate.id === taskId);
        if (!task) throw new Error("Reviewer audit task not found");
        // A terminal task cannot be revived by a late completion callback.
        if (["cancelled", "completed", "failed", "superseded"].includes(task.status)
          && update.status === "running") return structuredClone(task);
        Object.assign(task, structuredClone(update));
        return structuredClone(task);
      },
    );
  }

  async listReviewFeedback(sessionId: string): Promise<ReviewFeedback[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.readArray<ReviewFeedback>(this.reviewFeedbackPath(sessionId));
  }

  async appendReviewFeedback(feedback: ReviewFeedback): Promise<ReviewFeedback> {
    this.assertSessionWritable(feedback.sessionId);
    return await this.mutateArray<ReviewFeedback, ReviewFeedback>(this.reviewFeedbackPath(feedback.sessionId), (items) => {
      const existing = items.find((candidate) => candidate.feedbackFingerprint === feedback.feedbackFingerprint);
      if (existing) return structuredClone(existing);
      items.push(structuredClone(feedback));
      return structuredClone(feedback);
    });
  }

  async consumeReviewFeedback(sessionId: string, feedbackId: string): Promise<ReviewFeedback | undefined> {
    this.assertSessionWritable(sessionId);
    return await this.mutateArray<ReviewFeedback, ReviewFeedback | undefined>(this.reviewFeedbackPath(sessionId), (items) => {
      const feedback = items.find((candidate) => candidate.id === feedbackId && candidate.status === "ready");
      if (!feedback) return undefined;
      feedback.status = "consumed";
      feedback.consumedAt = new Date().toISOString();
      return structuredClone(feedback);
    });
  }

  async appendMcpInvocation(invocation: McpInvocation): Promise<void> {
    this.assertSessionWritable(invocation.sessionId);
    const values = await this.listMcpInvocations(invocation.sessionId);
    values.push(invocation);
    await this.writeArray(this.mcpInvocationsPath(invocation.sessionId), values);
  }

  async listMcpInvocations(sessionId: string): Promise<McpInvocation[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.readArray<McpInvocation>(this.mcpInvocationsPath(sessionId));
  }

  async appendPaperAcquisition(acquisition: PaperAcquisition): Promise<void> {
    this.assertSessionWritable(acquisition.sessionId);
    const values = await this.listPaperAcquisitions(acquisition.sessionId);
    values.push(acquisition);
    await this.writeArray(this.paperAcquisitionsPath(acquisition.sessionId), values);
  }

  async listPaperAcquisitions(sessionId: string): Promise<PaperAcquisition[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.readArray<PaperAcquisition>(this.paperAcquisitionsPath(sessionId));
  }

  async appendPaperVisionRun(run: PaperVisionRun): Promise<void> {
    this.assertSessionWritable(run.sessionId);
    const values = await this.listPaperVisionRuns(run.sessionId);
    values.push(run);
    await this.writeArray(this.paperVisionRunsPath(run.sessionId), values);
  }

  async listPaperVisionRuns(sessionId: string): Promise<PaperVisionRun[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.readArray<PaperVisionRun>(this.paperVisionRunsPath(sessionId));
  }

  async appendEvidence(sessionId: string, claims: Claim[], links: EvidenceLink[]): Promise<void> {
    this.assertSessionWritable(sessionId);
    const existingClaims = await this.listClaims(sessionId);
    const existingLinks = await this.listEvidenceLinks(sessionId);
    await this.writeArray(this.claimsPath(sessionId), [...existingClaims, ...claims]);
    await this.writeArray(this.evidenceLinksPath(sessionId), [...existingLinks, ...links]);
  }

  async listClaims(sessionId: string): Promise<Claim[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.readArray<Claim>(this.claimsPath(sessionId));
  }

  async listEvidenceLinks(sessionId: string): Promise<EvidenceLink[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.readArray<EvidenceLink>(this.evidenceLinksPath(sessionId));
  }

  async appendEvidenceItems(sessionId: string, additions: EvidenceItem[]): Promise<void> {
    this.assertSessionWritable(sessionId);
    const values = await this.listEvidenceItems(sessionId);
    values.push(...additions);
    await this.writeArray(this.evidenceItemsPath(sessionId), values);
  }

  async listEvidenceItems(sessionId: string): Promise<EvidenceItem[]> {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return await this.readArray<EvidenceItem>(this.evidenceItemsPath(sessionId));
  }

  async appendReview(review: ReviewRun): Promise<void> {
    this.assertSessionWritable(review.sessionId);
    const reviews = await this.listReviews(review.sessionId);
    reviews.push(review);
    await this.writeArray(this.reviewsPath(review.sessionId), reviews);
  }

  async appendReviewNotice(sessionId: string, reviews: ReviewRun[]): Promise<ChatMessage | undefined> {
    const findings = reviews.flatMap((review) => review.findings);
    if (!findings.length) return undefined;
    return await this.appendMessage(
      sessionId,
      "assistant",
      [
        "Reviewer notice",
        "",
        ...findings.map((finding) => `- **${finding.code}**: ${finding.message}`),
        "",
        "The main agent must correct the work or explain, with record evidence, why a finding does not apply.",
      ].join("\n"),
      undefined,
      undefined,
      undefined,
      "review_notice",
    );
  }

  async appendMessage(
    sessionId: string,
    role: ChatMessage["role"],
    content: string,
    model?: Pick<ModelProfile, "id" | "name">,
    references?: ComposerReference[],
    annotationIds?: string[],
    kind: ChatMessage["kind"] = "message",
    modelContext?: ChatMessage["modelContext"],
  ): Promise<ChatMessage> {
    const session = this.assertSessionWritable(sessionId);
    const message: ChatMessage = {
      content,
      createdAt: new Date().toISOString(),
      id: randomUUID(),
      kind,
      ...(model ? { modelId: model.id, modelName: model.name } : {}),
      ...(modelContext?.length ? { modelContext: structuredClone(modelContext) } : {}),
      ...(references?.length ? { references: structuredClone(references) } : {}),
      role,
    };
    if (role === "user" && annotationIds?.length) {
      message.annotations = await this.attachArtifactAnnotations(sessionId, annotationIds, message.id);
    }
    const messages = await this.readMessages(sessionId);
    messages.push(message);
    await mkdir(resolve(this.dataDir, "messages"), { recursive: true });
    await writeFile(this.messagesPath(sessionId), `${JSON.stringify(messages, null, 2)}\n`, "utf8");
    session.updatedAt = message.createdAt;
    await this.saveCatalog();
    return message;
  }

  async appendReviewerCheckpointMessage(
    sessionId: string,
    messageId: string,
    toolCallId: string,
  ): Promise<ChatMessage> {
    const session = this.assertSessionWritable(sessionId);
    const messages = await this.readMessages(sessionId);
    const existing = messages.find((message) => message.id === messageId);
    if (existing) {
      if (existing.kind !== "reviewer_checkpoint" || existing.reviewerCheckpoint?.toolCallId !== toolCallId) {
        throw new Error("Reviewer checkpoint message id is already in use");
      }
      return structuredClone(existing);
    }
    const message: ChatMessage = {
      content: "Reviewer Specialist review",
      createdAt: new Date().toISOString(),
      id: messageId,
      kind: "reviewer_checkpoint",
      reviewerCheckpoint: { status: "running", toolCallId },
      role: "assistant",
    };
    messages.push(message);
    await mkdir(resolve(this.dataDir, "messages"), { recursive: true });
    await writeFile(this.messagesPath(sessionId), `${JSON.stringify(messages, null, 2)}\n`, "utf8");
    session.updatedAt = message.createdAt;
    await this.saveCatalog();
    return structuredClone(message);
  }

  async updateReviewerCheckpointMessage(
    sessionId: string,
    messageId: string,
    update: {
      content: string;
      error?: string;
      status: "completed" | "failed" | "running";
    },
  ): Promise<ChatMessage> {
    this.assertSessionWritable(sessionId);
    const messages = await this.readMessages(sessionId);
    const message = messages.find((candidate) => candidate.id === messageId);
    if (!message || message.kind !== "reviewer_checkpoint" || !message.reviewerCheckpoint) {
      throw new Error("Reviewer checkpoint message not found");
    }
    // A cancellation may be persisted by a different API process after this
    // worker has started. Never let a late progress/completion update revive a
    // checkpoint that has already reached a terminal state.
    if (message.reviewerCheckpoint.status !== "running") return structuredClone(message);
    message.reviewerCheckpoint = {
      ...message.reviewerCheckpoint,
      status: update.status,
      ...(update.error ? { error: update.error } : {}),
    };
    message.content = update.content;
    await writeFile(this.messagesPath(sessionId), `${JSON.stringify(messages, null, 2)}\n`, "utf8");
    return structuredClone(message);
  }

  /** Persist a small reviewer queue snapshot while the checkpoint is running. */
  async updateReviewerCheckpointProgress(
    sessionId: string,
    messageId: string,
    progress: NonNullable<ChatMessage["reviewerCheckpoint"]>["progress"],
  ): Promise<ChatMessage> {
    this.assertSessionWritable(sessionId);
    const messages = await this.readMessages(sessionId);
    const message = messages.find((candidate) => candidate.id === messageId);
    if (!message || message.kind !== "reviewer_checkpoint" || !message.reviewerCheckpoint) {
      throw new Error("Reviewer checkpoint message not found");
    }
    if (message.reviewerCheckpoint.status !== "running") return structuredClone(message);
    message.reviewerCheckpoint = { ...message.reviewerCheckpoint, ...(progress ? { progress } : {}) };
    await writeFile(this.messagesPath(sessionId), `${JSON.stringify(messages, null, 2)}\n`, "utf8");
    return structuredClone(message);
  }

  /** Remove a transient automatic-audit shell before it reaches the lead Agent. */
  async deleteReviewerCheckpointMessage(sessionId: string, messageId: string): Promise<void> {
    this.assertSessionWritable(sessionId);
    const messages = await this.readMessages(sessionId);
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    if (messages[index]!.kind !== "reviewer_checkpoint") {
      throw new Error("Reviewer checkpoint message id is already in use");
    }
    messages.splice(index, 1);
    await writeFile(this.messagesPath(sessionId), `${JSON.stringify(messages, null, 2)}\n`, "utf8");
  }

  async appendTimeoutMessage(
    sessionId: string,
    content: string,
    timeout: { kind: TimeoutKind; reason: string; timeoutMs: number },
    model?: Pick<ModelProfile, "id" | "name">,
  ): Promise<ChatMessage> {
    const message = await this.appendMessage(
      sessionId,
      "assistant",
      content,
      model,
      undefined,
      undefined,
      "timeout_notice",
    );
    const messages = await this.readMessages(sessionId);
    const stored = messages.find((candidate) => candidate.id === message.id);
    if (!stored) throw new Error("Timeout message disappeared before metadata persistence");
    stored.timeout = structuredClone(timeout);
    await writeFile(this.messagesPath(sessionId), `${JSON.stringify(messages, null, 2)}\n`, "utf8");
    return structuredClone(stored);
  }

  workspacePath(sessionId: string): string {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return resolve(this.dataDir, "projects", session.projectId, "sessions", session.id, "workspace");
  }

  /** Stable Agent-instance × Runner identity. Paths are never used as an authorization grant. */
  workspaceIdentity(sessionId: string, agentId = "main", runnerId = "local") {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    if (!/^[A-Za-z0-9_:.-]{1,160}$/.test(agentId) || !/^[A-Za-z0-9_:.-]{1,160}$/.test(runnerId)) throw new Error("Invalid Workspace owner");
    return { id: `ws_${createHash("sha256").update(JSON.stringify([sessionId, agentId, runnerId])).digest("hex")}`,
      sessionId, agentId, runnerId };
  }

  agentWorkspacePath(sessionId: string, subagentId: string): string {
    const main = this.workspacePath(sessionId);
    const identity = this.workspaceIdentity(sessionId, `subagent:${subagentId}`);
    return resolve(main, "..", "agent-workspaces", identity.id);
  }

  async createAgentWorkspace(sessionId: string, subagentId: string): Promise<void> {
    const root = this.agentWorkspacePath(sessionId, subagentId);
    await withWorkspaceAdmission(new VersionStore(this.dataDir), root, async () => {
      this.assertSessionWritable(sessionId);
      await mkdir(root, { recursive: true });
    });
  }

  /** Resolve persisted logical audit paths without mounting child Workspaces inside the parent. */
  workspaceLocation(sessionId: string, logicalPath: string): { root: string; path: string } {
    const main = this.workspacePath(sessionId);
    for (const child of this.listSubagents(sessionId)) {
      const handoff = child.handoff;
      if (!handoff?.workspaceId) continue;
      const expected = this.workspaceIdentity(sessionId, `subagent:${child.id}`);
      if (handoff.workspaceId !== expected.id) throw new Error("Stored Workspace identity does not match its Agent");
      const prefix = `${handoff.privateWorkspacePath}/`;
      if (logicalPath.startsWith(prefix)) return { root: this.agentWorkspacePath(sessionId, child.id), path: logicalPath.slice(prefix.length) };
    }
    return { root: main, path: logicalPath };
  }

  /** Content-addressed root for one selected Skill set, shared by every run that selects it. */
  skillPackagesPath(sessionId: string, packageSetHash: string): string {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (!/^[0-9a-f]{64}$/.test(packageSetHash)) {
      throw new Error("Skill package set hash is unsafe for a Skill snapshot path");
    }
    return resolve(
      this.dataDir,
      "projects",
      session.projectId,
      "sessions",
      session.id,
      "skill-snapshots",
      packageSetHash,
    );
  }
}
