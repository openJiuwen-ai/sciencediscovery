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
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ChatMessage,
  ArtifactReviewRun,
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
  ExecutionRun,
  EvidenceLink,
  EvidenceItem,
  CreateProxyServerRequest,
  McpProxyPolicies,
  MemoryGraphSettings,
  MemoryGraphSettingsDetails,
  McpInvocation,
  ModelInvocationUsage,
  ModelRunInfo,
  ModelProfile,
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
  ProposePlanRequest,
  ProxyDefaultPolicy,
  ProxyPolicy,
  ProxyServer,
  ProxySettingsDetails,
  ResolvedProxy,
  RemoteHostCapabilities,
  RemoteHostTarget,
  RemoteJob,
  ReviewRun,
  ReviewerSpecialistLevel,
  ReviewerSpecialistSettings,
  RevisePlanRequest,
  ResolvedRuntimeSettings,
  RuntimeSettingsDetails,
  RuntimeSettingsField,
  RuntimeSettingsOverrides,
  RuntimeSettingsSource,
  Session,
  SessionDetail,
  SessionPlan,
  SessionRun,
  SessionRunEvent,
  SessionRunStatus,
  SessionUsageSummary,
  GlobalModelUsageSummary,
  ScientificArtifact,
  ScientificArtifactKind,
  ScientificArtifactVersion,
  SessionListState,
  SkillDeletionImpact,
  SkillSelectionMode,
  SandboxNetworkAccess,
  SandboxNetworkSettings,
  Specialist,
  SystemQuotaSettings,
  SystemTimeoutSettings,
  TimeoutKind,
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
} from "@science-agent/schema";
import {
  DEFAULT_SANDBOX_NETWORK_SETTINGS,
  DEFAULT_SKILL_SELECTION_MODE,
  DEFAULT_SYSTEM_QUOTA_SETTINGS,
  DEFAULT_REVIEWER_SPECIALIST_LEVEL,
  DEFAULT_SYSTEM_TIMEOUT_SETTINGS,
  DEFAULT_MEMORY_GRAPH_SETTINGS,
  DEFAULT_WEB_SETTINGS,
  REVIEWER_SPECIALIST_LEVELS,
  SKILL_SELECTION_FIELDS,
  epochSandboxNetworkAccess,
  UNTITLED_SESSION_TITLE,
} from "@science-agent/schema";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
} from "@science-agent/agent-runtime";

import { SCIENTIFIC_ARTIFACT_KIND_SET, resolveScientificArtifactKind } from "@science-agent/schema";
import {
  DEFAULT_ENVIRONMENT_REVISION_ID,
  defaultEnvironmentRevision,
  defaultShellEnvironmentRevision,
} from "./environment.js";
import { summarizeGlobalModelUsage, summarizeModelUsage } from "./model-usage.js";
import { normalizeEnvironmentSourceSettings } from "./environment-sources.js";
import { BUNDLED_SKILL_IDS } from "./skills.js";
import { BUILTIN_SPECIALISTS } from "./builtin-specialists.js";
import { normalizeSubagentBrief } from "./subagent-brief.js";
import {
  emptyCatalog,
  ENVIRONMENT_PROXY_SERVER_ID,
  environmentProxyServer,
  hasOwn,
  isRecord,
  type Catalog,
} from "./store/catalog.js";
import { proxyEnvironmentDetails, resolveProxyEnvironment, resolveProxyPolicy, type ProxyRegistryView } from "./proxy/index.js";
import {
  cleanLabel,
  createPermissionEpoch,
  parsePermissionAuthorization,
  permissionMatcherResource,
} from "./store/permissions.js";
import {
  normalizeSandboxNetworkSettings,
  resolveSandboxNetworkSettings,
  sandboxNetworkAccess,
} from "./store/sandbox-network.js";
import {
  decryptModelApiToken,
  encryptModelApiToken,
  loadOrCreateModelSecretKey,
  normalizeApiToken,
  validateLiveModel,
} from "./store/secrets.js";
import {
  knownConnectorIdSet,
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

export class SessionStoreHttpError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409) {
    super(message);
    this.name = "SessionStoreHttpError";
  }
}

export class SessionStore {
  readonly dataDir: string;
  private readonly arrayMutationQueues = new Map<string, Promise<void>>();
  private readonly streamAppendQueues = new Map<string, Promise<void>>();
  private readonly streamTailSequences = new Map<string, number>();
  private readonly subagentMutationQueues = new Map<string, Promise<void>>();
  private catalog: Catalog = emptyCatalog();
  private database?: DatabaseSync;
  private loaded = false;
  private saveQueue = Promise.resolve();
  private secretKey?: Buffer;
  private skillIds = new Set<string>(BUNDLED_SKILL_IDS);
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
    this.secretKey = await this.loadOrCreateSecretKey();
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

    const savedModels = Array.isArray(saved.models) ? saved.models : [];
    const models = savedModels
      .filter((model) => {
        const legacy = model as ModelProfile & { builtin?: boolean; demoMode?: boolean };
        return legacy.id !== "builtin-demo" && legacy.demoMode !== true && legacy.model !== "deterministic-demo";
      })
      .map((model) => ({
        baseUrl: model.baseUrl,
        createdAt: model.createdAt,
        hasApiToken: modelIdsWithSecrets.has(model.id),
        id: model.id,
        model: model.model,
        name: model.name,
        proxyPolicy: normalizeSavedProxyPolicy(model.proxyPolicy),
        updatedAt: model.updatedAt,
        vision: model.vision === true,
      }));
    const migratedModels = JSON.stringify(models) !== JSON.stringify(savedModels);
    const modelIds = new Set(models.map((model) => model.id));
    const fallbackModelId = models[0]?.id;
    const defaultGlobalSettings = emptyCatalog(this.initialTimeoutSettings, this.initialQuotaSettings).globalSettings;
    const normalizedGlobalSettings = saved.globalSettings === undefined
      ? undefined
      : withoutSkillSelection(normalizeRuntimeSettings(saved.globalSettings, modelIds, this.skillIds, false));
    const globalSettings = normalizedGlobalSettings === undefined
      ? defaultGlobalSettings
      : normalizedGlobalSettings;
    const memoryGraphSettings = normalizeMemoryGraphSettings(saved.memoryGraphSettings);
    const migratedMemoryGraphSettings = JSON.stringify(memoryGraphSettings) !== JSON.stringify(saved.memoryGraphSettings ?? null);
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
      settingsOverrides: normalizeRuntimeSettings(project.settingsOverrides, modelIds, this.skillIds, false),
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
    const savedSessionPlans = Array.isArray(saved.sessionPlans) ? saved.sessionPlans : [];
    const sessionPlans = savedSessionPlans.map((plan) => ({
      ...plan,
      mode: "recorded" as const,
      state: plan.state === "completed" ? "completed" as const : "recorded" as const,
    }));
    const migratedSessionPlans = JSON.stringify(sessionPlans) !== JSON.stringify(savedSessionPlans);
    const savedSubagents = Array.isArray(saved.subagents)
      ? saved.subagents
      : Array.isArray(saved.delegationTracks) ? saved.delegationTracks : [];
    const subagents = savedSubagents.flatMap((subagent) => {
      const normalized = normalizePersistedSubagent(subagent);
      return normalized ? [normalized] : [];
    });
    const migratedSubagents = !Array.isArray(saved.subagents)
      || JSON.stringify(subagents) !== JSON.stringify(savedSubagents);
    const remoteHosts = Array.isArray(saved.remoteHosts) ? saved.remoteHosts : [];
    const remoteJobs = Array.isArray(saved.remoteJobs) ? saved.remoteJobs : [];
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
        ? session.enabledConnectorIds.filter((id): id is ConnectorId => knownConnectorIdSet().has(id))
        : [];
      // Compatibility mirror only; syncSessionCompatibility recomputes it after load.
      const enabledSkillIds = Array.isArray(session.enabledSkillIds)
        ? session.enabledSkillIds.filter((id): id is string => this.skillIds.has(id))
        : [];
      const semanticReviewEnabled = session.semanticReviewEnabled ?? true;
      const reviewCriteria = Array.isArray(session.reviewCriteria)
        ? session.reviewCriteria.filter((criterion): criterion is string => typeof criterion === "string").slice(0, 20)
        : [];
      const reviewMode = session.reviewMode === "manual" ? "manual" as const : "auto" as const;
      const settingsOverrides = isRecord(session.settingsOverrides)
        ? normalizeRuntimeSettings(session.settingsOverrides, modelIds, this.skillIds, false)
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
        semanticReviewEnabled,
        settingsOverrides,
        ...(session.specialistId && specialistIds.has(session.specialistId) ? { specialistId: session.specialistId } : { specialistId: undefined }),
        title: session.title,
        updatedAt: session.updatedAt,
      } as Session;
    });
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
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
      const baseName = (legacy.name ?? legacy.logicalName).trim();
      let name = baseName;
      let key = `${projectId}\0${name}`;
      if (usedArtifactNames.has(key)) {
        name = `${baseName} (s-${createdInSessionId.slice(0, 8)})`;
        key = `${projectId}\0${name}`;
        if (usedArtifactNames.has(key)) name = `${name}-${legacy.id.slice(0, 8)}`;
      }
      usedArtifactNames.add(`${projectId}\0${name}`);
      const firstVersion = savedVersionsByArtifactId.get(legacy.id)?.toSorted((left, right) => left.version - right.version)[0];
      const origin: ArtifactOrigin = legacy.origin
        ?? (firstVersion?.executionRunIds?.length ? "legacy_auto" : "user_upload");
      return [{
        createdAt: legacy.createdAt,
        createdInSessionId,
        createdInSessionTitle: legacy.createdInSessionTitle ?? session?.title ?? "Deleted Session",
        currentVersion: legacy.currentVersion,
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
    this.catalog = {
      artifactAnnotations,
      artifactVersions,
      artifacts,
      subagents,
      environments,
      environmentRevisions,
      environmentSourceSettings,
      globalSettings,
      mcpProxyPolicies,
      memoryGraphSettings,
      models,
      permissionEpochs,
      permissionGrants,
      permissionRequests,
      projects,
      proxyDefaultPolicy,
      proxyServers,
      quotaSettings,
      sandboxNetworkSettings,
      reviewerSpecialistEnabled: saved.reviewerSpecialistEnabled === true,
      reviewerSpecialistLevel,
      remoteHosts,
      remoteJobs,
      sessionPlans,
      sessions,
      specialists,
      timeoutSettings,
      webSettings,
    };
    for (const session of sessions) this.syncSessionCompatibility(session);
    const migratedSessionOverrides = JSON.stringify(sessions) !== JSON.stringify(savedSessions);
    if (!Array.isArray(saved.models)
      || !Array.isArray(saved.artifacts)
      || !Array.isArray(saved.artifactVersions)
      || !Array.isArray(saved.artifactAnnotations)
      || !Array.isArray(saved.environments)
      || !Array.isArray(saved.environmentRevisions)
      || !Array.isArray(saved.permissionEpochs)
      || !Array.isArray(saved.permissionGrants)
      || !Array.isArray(saved.permissionRequests)
      || !Array.isArray(saved.sessionPlans)
      || !Array.isArray(saved.subagents)
      || !Array.isArray(saved.remoteHosts)
      || !Array.isArray(saved.remoteJobs)
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
      || migratedEnvironmentRevisions
      || migratedEpoch
      || migratedSessionSettings
      || migratedSessionAssignments
      || migratedSessionOverrides
      || migratedSubagents
      || migratedSessionPlans
      || migratedPermissionGrants
      || migratedReviewerSpecialistLevel
      || migratedSpecialists
      || migratedArtifactCatalog
      || importedLegacyCatalog
    ) {
      await this.saveCatalog();
    }
    await this.recoverTrashOperations();
    this.loaded = true;
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
      this.paperAcquisitionsPath(session.id),
      this.paperVisionRunsPath(session.id),
      this.claimsPath(session.id),
      this.evidenceLinksPath(session.id),
      this.evidenceItemsPath(session.id),
      this.mcpInvocationsPath(session.id),
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
    await rm(operation.root, { force: true, recursive: true });
  }

  private async stageDeletion(paths: string[], sessionIds: string[]): Promise<StagedDeletion> {
    const root = resolve(this.dataDir, ".trash", randomUUID());
    const entries: StagedDeletion["entries"] = [];
    for (const source of [...new Set(paths)]) {
      if (!await this.pathExists(source)) continue;
      const relativePath = relative(this.dataDir, source);
      if (!relativePath || relativePath.startsWith("..")) throw new Error("Deletion path escaped the data directory");
      entries.push({ source, staged: resolve(root, "data", relativePath) });
    }
    const operation: StagedDeletion = { entries, root, sessionIds: [...sessionIds] };
    try {
      await mkdir(root, { recursive: true });
      await writeFile(resolve(root, "operation.json"), `${JSON.stringify(operation, null, 2)}\n`, "utf8");
      for (const entry of entries) {
        await mkdir(dirname(entry.staged), { recursive: true });
        await rename(entry.source, entry.staged);
      }
      return operation;
    } catch (error) {
      try {
        await this.rollbackStagedDeletion(operation);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Deletion staging and rollback both failed");
      }
      throw error;
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
        const catalogStillReferencesData = operation.sessionIds.some((id) => Boolean(this.getSession(id)));
        if (catalogStillReferencesData) await this.rollbackStagedDeletion(operation);
        else await this.finishStagedDeletion(operation);
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
    return normalizeRuntimeSettings(value, new Set(this.catalog.models.map((model) => model.id)), this.skillIds, true);
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
        else if (field === "enabledSkillIds") effective.enabledSkillIds = [...value as string[]];
        else if (field === "semanticReviewEnabled") effective.semanticReviewEnabled = value as boolean;
        else if (field === "skillSelectionMode") effective.skillSelectionMode = value as SkillSelectionMode;
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
    this.catalog.sandboxNetworkSettings = normalizeSandboxNetworkSettings(value);
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
      level: this.catalog.reviewerSpecialistLevel,
    };
  }

  async updateReviewerSpecialistSettings(value: unknown): Promise<ReviewerSpecialistSettings> {
    if (!isRecord(value) || typeof value.enabled !== "boolean") {
      throw new Error("Reviewer Specialist enabled must be a boolean");
    }
    if (value.level !== undefined && !isReviewerSpecialistLevel(value.level)) {
      throw new Error("Reviewer Specialist level must be quick or deep");
    }
    this.catalog.reviewerSpecialistEnabled = value.enabled;
    if (value.level !== undefined) this.catalog.reviewerSpecialistLevel = value.level;
    await this.saveCatalog();
    return this.getReviewerSpecialistSettings();
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
    return row ? this.decryptModelApiToken(modelId, row.encrypted_token) : undefined;
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
    Object.assign(profile, validateLiveModel(input), { updatedAt: new Date().toISOString() });
    if (input.proxyPolicy !== undefined) {
      profile.proxyPolicy = this.normalizeModelProxyPolicy(input.proxyPolicy);
    }
    if (input.apiToken === null) {
      this.setModelApiToken(modelId, undefined);
      profile.hasApiToken = false;
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

  async createProject(name: string, input: RuntimeSettingsOverrides = {}): Promise<Project> {
    const settingsOverrides = this.normalizeSettings(input);
    const project: Project = {
      createdAt: new Date().toISOString(),
      id: randomUUID(),
      name: cleanLabel(name, "Untitled project"),
      settingsOverrides,
    };
    this.catalog.projects.push(project);
    await this.saveCatalog();
    return project;
  }

  async updateProject(projectId: string, changes: UpdateProjectRequest): Promise<Project> {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found");
    project.name = requiredLabel(changes.name, "Project name");
    await this.saveCatalog();
    return project;
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
    if (selectedModel && !this.getModelApiToken(selectedModel.id) && !options.allowUnconfiguredModel) {
      throw new Error("The task model must have a saved API token");
    }
    const now = new Date().toISOString();
    if (governance.specialistId && !this.getSpecialist(governance.specialistId)) {
      throw new Error("Specialist not found");
    }
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
      semanticReviewEnabled: resolved.effective.semanticReviewEnabled,
      settingsOverrides,
      ...(governance.specialistId ? { specialistId: governance.specialistId } : {}),
      title: cleanLabel(title, UNTITLED_SESSION_TITLE),
      updatedAt: now,
    };
    await mkdir(resolve(this.dataDir, "messages"), { recursive: true });
    await writeFile(this.messagesPath(session.id), "[]\n", "utf8");
    await mkdir(resolve(this.dataDir, "session-runs"), { recursive: true });
    await writeFile(this.sessionRunsPath(session.id), "[]\n", "utf8");
    await mkdir(resolve(this.dataDir, "projects", projectId, "sessions", session.id, "workspace"), { recursive: true });
    this.catalog.permissionEpochs.push(permissionEpoch);
    this.catalog.sessions.push(session);
    await this.saveCatalog();
    return session;
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
    const unavailableConnectors = connectorIds.filter((id) => !knownConnectorIdSet().has(id));
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

  listSessionPlans(sessionId: string): SessionPlan[] {
    if (!this.getSession(sessionId)) throw new Error("Session not found");
    return structuredClone(this.catalog.sessionPlans.filter((plan) => plan.sessionId === sessionId))
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  latestSessionPlan(sessionId: string): SessionPlan | undefined {
    return this.listSessionPlans(sessionId).at(-1);
  }

  private normalizePlanInput(input: ProposePlanRequest): Pick<SessionPlan, "caveats" | "feasibilityConfidence" | "scope" | "steps"> {
    const scope = input.scope?.trim();
    if (!scope || scope.length > 2_000) throw new Error("Plan scope must be 1-2000 characters");
    if (!(["high", "medium", "low"] as const).includes(input.feasibilityConfidence)) throw new Error("Invalid feasibility confidence");
    const descriptions = input.steps?.map((step) => step.trim()).filter(Boolean) ?? [];
    if (!descriptions.length || descriptions.length > 20 || descriptions.some((step) => step.length > 1_000)) {
      throw new Error("Plan must contain 1-20 steps of at most 1000 characters each");
    }
    const caveats = (input.caveats ?? []).map((caveat) => caveat.trim()).filter(Boolean);
    if (caveats.length > 10 || caveats.some((caveat) => caveat.length > 1_000)) {
      throw new Error("Plan supports at most 10 caveats of 1000 characters each");
    }
    return {
      caveats,
      feasibilityConfidence: input.feasibilityConfidence,
      scope,
      steps: descriptions.map((description) => ({ id: randomUUID(), description, status: "pending" })),
    };
  }

  async proposeSessionPlan(sessionId: string, input: ProposePlanRequest): Promise<SessionPlan> {
    this.assertSessionWritable(sessionId);
    const normalized = this.normalizePlanInput(input);
    const now = new Date().toISOString();
    const plan: SessionPlan = {
      ...normalized,
      createdAt: now,
      id: randomUUID(),
      mode: "recorded",
      sessionId,
      state: "recorded",
      updatedAt: now,
      version: 1,
    };
    this.catalog.sessionPlans.push(plan);
    await this.saveCatalog();
    return structuredClone(plan);
  }

  async reviseSessionPlan(sessionId: string, planId: string, input: RevisePlanRequest): Promise<SessionPlan> {
    this.assertSessionWritable(sessionId);
    const plan = this.catalog.sessionPlans.find((candidate) => candidate.id === planId && candidate.sessionId === sessionId);
    if (!plan) throw new Error("Plan not found");
    if (plan.state !== "recorded") throw new Error("Only a recorded plan can be revised");
    if (plan.version !== input.expectedVersion) throw new Error("Plan version changed; refresh before revising");
    Object.assign(plan, this.normalizePlanInput(input), { updatedAt: new Date().toISOString(), version: plan.version + 1 });
    await this.saveCatalog();
    return structuredClone(plan);
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
    execution: { maxTurns?: number; model?: ModelRunInfo; timeoutSeconds?: number } = {},
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

  listArtifacts(sessionId: string): ScientificArtifact[] {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return this.listProjectArtifacts(session.projectId);
  }

  listProjectArtifacts(projectId: string): ScientificArtifact[] {
    if (!this.getProject(projectId)) throw new Error("Project not found");
    return structuredClone(this.catalog.artifacts.filter((artifact) => artifact.projectId === projectId))
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

  getArtifactByName(sessionId: string, name: string): ScientificArtifact | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    const artifact = this.catalog.artifacts.find((candidate) => candidate.projectId === session.projectId && candidate.name === name);
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
      .filter((artifact) => artifact.projectId === session.projectId && reportKinds.has(artifact.kind))
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
    let artifact = this.catalog.artifacts.find((candidate) => candidate.projectId === projectId && candidate.name === logicalName);
    if (artifact && artifact.kind !== input.kind) throw new Error("Artifact kind cannot change across versions");
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

  listRemoteHosts(): RemoteHostTarget[] {
    return structuredClone(this.catalog.remoteHosts).toSorted((left, right) => left.alias.localeCompare(right.alias));
  }

  getRemoteHost(hostId: string): RemoteHostTarget | undefined {
    const host = this.catalog.remoteHosts.find((candidate) => candidate.id === hostId);
    return host ? structuredClone(host) : undefined;
  }

  async registerRemoteHost(aliasValue: string, capabilities?: RemoteHostCapabilities, error?: string): Promise<RemoteHostTarget> {
    const alias = aliasValue.trim();
    if (!/^[A-Za-z0-9._-]{1,255}$/.test(alias)) throw new Error("Invalid SSH host alias");
    const now = new Date().toISOString();
    const existing = this.catalog.remoteHosts.find((host) => host.alias === alias);
    const host: RemoteHostTarget = existing ?? {
      alias,
      createdAt: now,
      id: randomUUID(),
      status: "error",
      updatedAt: now,
    };
    host.updatedAt = now;
    if (capabilities) {
      host.capabilities = structuredClone(capabilities);
      host.status = "ready";
      delete host.error;
    } else {
      host.status = "error";
      host.error = error?.slice(0, 2_000) || "SSH probe failed";
    }
    if (!existing) this.catalog.remoteHosts.push(host);
    await this.saveCatalog();
    return structuredClone(host);
  }

  async deleteRemoteHost(hostId: string): Promise<void> {
    if (!this.catalog.remoteHosts.some((host) => host.id === hostId)) throw new Error("Remote host not found");
    if (this.catalog.remoteJobs.some((job) => job.card.targetId === hostId)) {
      throw new Error("Remote host is referenced by a job and cannot be deleted");
    }
    this.catalog.remoteHosts = this.catalog.remoteHosts.filter((host) => host.id !== hostId);
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
    const operation = await this.stageDeletion(this.knownSessionDataPaths(session), [session.id]);
    const previousSessions = this.catalog.sessions;
    const previousPermissionEpochs = this.catalog.permissionEpochs;
    const previousPermissionGrants = this.catalog.permissionGrants;
    const previousPermissionRequests = this.catalog.permissionRequests;
    const previousPlans = this.catalog.sessionPlans;
    const previousSubagents = this.catalog.subagents;
    const previousRemoteJobs = this.catalog.remoteJobs;
    const remoteJobIds = new Set(this.catalog.remoteJobs.filter((job) => job.sessionId === session.id).map((job) => job.id));
    try {
      this.catalog.sessions = this.catalog.sessions.filter((item) => item.id !== session.id);
      this.catalog.permissionEpochs = this.catalog.permissionEpochs.filter((epoch) => epoch.sessionId !== session.id);
      this.catalog.permissionRequests = this.catalog.permissionRequests.filter((request) => request.sessionId !== session.id);
      this.catalog.permissionGrants = this.catalog.permissionGrants.filter((grant) => grant.sessionId !== session.id
        && !(grant.action === "remote_job" && remoteJobIds.has(grant.resource)));
      this.catalog.sessionPlans = this.catalog.sessionPlans.filter((plan) => plan.sessionId !== session.id);
      this.catalog.subagents = this.catalog.subagents.filter((subagent) => subagent.sessionId !== session.id);
      this.catalog.remoteJobs = this.catalog.remoteJobs.filter((job) => job.sessionId !== session.id);
      await this.saveCatalog();
    } catch (error) {
      this.catalog.sessions = previousSessions;
      this.catalog.permissionEpochs = previousPermissionEpochs;
      this.catalog.permissionGrants = previousPermissionGrants;
      this.catalog.permissionRequests = previousPermissionRequests;
      this.catalog.sessionPlans = previousPlans;
      this.catalog.subagents = previousSubagents;
      this.catalog.remoteJobs = previousRemoteJobs;
      await this.rollbackStagedDeletion(operation);
      throw error;
    }
    this.database?.prepare("DELETE FROM permission_authorizations WHERE session_id = ?").run(session.id);
    await this.finishStagedDeletion(operation);
  }

  async deleteProject(projectId: string, confirmationId: string): Promise<void> {
    const project = this.getProject(projectId);
    if (!project) throw new Error("Project not found");
    if (confirmationId !== project.id) throw new Error("Project deletion confirmation does not match the target");
    const sessions = this.listSessions(projectId, "all");
    const paths = sessions.flatMap((session) => this.knownSessionDataPaths(session));
    if (!sessions.length) paths.push(resolve(this.dataDir, "projects", projectId));
    const operation = await this.stageDeletion(paths, sessions.map((session) => session.id));
    const sessionIds = new Set(sessions.map((session) => session.id));
    const previousProjects = this.catalog.projects;
    const previousSessions = this.catalog.sessions;
    const previousPermissionEpochs = this.catalog.permissionEpochs;
    const previousPermissionGrants = this.catalog.permissionGrants;
    const previousPermissionRequests = this.catalog.permissionRequests;
    const previousPlans = this.catalog.sessionPlans;
    const previousSubagents = this.catalog.subagents;
    const previousRemoteJobs = this.catalog.remoteJobs;
    const previousArtifacts = this.catalog.artifacts;
    const previousArtifactVersions = this.catalog.artifactVersions;
    const previousArtifactAnnotations = this.catalog.artifactAnnotations;
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
      this.catalog.sessionPlans = this.catalog.sessionPlans.filter((plan) => !sessionIds.has(plan.sessionId));
      this.catalog.subagents = this.catalog.subagents.filter((subagent) => !sessionIds.has(subagent.sessionId));
      this.catalog.remoteJobs = this.catalog.remoteJobs.filter((job) => !sessionIds.has(job.sessionId));
      this.catalog.artifacts = this.catalog.artifacts.filter((artifact) => artifact.projectId !== projectId);
      this.catalog.artifactVersions = this.catalog.artifactVersions.filter((version) => !projectArtifactIds.has(version.artifactId));
      this.catalog.artifactAnnotations = this.catalog.artifactAnnotations.filter((annotation) => !projectArtifactVersionIds.has(annotation.artifactVersionId));
      await this.saveCatalog();
    } catch (error) {
      this.catalog.projects = previousProjects;
      this.catalog.sessions = previousSessions;
      this.catalog.permissionEpochs = previousPermissionEpochs;
      this.catalog.permissionGrants = previousPermissionGrants;
      this.catalog.permissionRequests = previousPermissionRequests;
      this.catalog.sessionPlans = previousPlans;
      this.catalog.subagents = previousSubagents;
      this.catalog.remoteJobs = previousRemoteJobs;
      this.catalog.artifacts = previousArtifacts;
      this.catalog.artifactVersions = previousArtifactVersions;
      this.catalog.artifactAnnotations = previousArtifactAnnotations;
      await this.rollbackStagedDeletion(operation);
      throw error;
    }
    this.database?.prepare("DELETE FROM permission_authorizations WHERE project_id = ?").run(projectId);
    await this.finishStagedDeletion(operation);
    await rm(resolve(this.dataDir, "projects", projectId), { force: true, recursive: true });
  }

  async updateSession(
    sessionId: string,
    changes: UpdateSessionRequest,
  ): Promise<Session> {
    const session = this.assertSessionWritable(sessionId);
    const { approvalMode, reviewCriteria, reviewMode, specialistId, title, ...settingsChanges } = changes;
    const nextTitle = hasOwn(changes, "title") ? requiredLabel(title, "Session title") : session.title;
    const nextSettings = this.normalizeSettings({ ...session.settingsOverrides, ...settingsChanges });
    if (approvalMode !== undefined) throw new Error("Use setApprovalMode to change approval policy");
    if (reviewMode !== undefined && reviewMode !== "auto" && reviewMode !== "manual") throw new Error("Invalid review mode");
    if (specialistId && !this.getSpecialist(specialistId)) throw new Error("Specialist not found");
    session.settingsOverrides = nextSettings;
    session.title = nextTitle;
    if (reviewMode) session.reviewMode = reviewMode;
    if (reviewCriteria !== undefined) session.reviewCriteria = this.normalizeReviewCriteria(reviewCriteria);
    if (specialistId === null) delete session.specialistId;
    else if (specialistId !== undefined) session.specialistId = specialistId;
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
  ): Promise<void> {
    this.catalog.environments = structuredClone(environments);
    const legacy = this.catalog.environmentRevisions.find((revision) => revision.id === DEFAULT_ENVIRONMENT_REVISION_ID)
      ?? defaultEnvironmentRevision();
    const shell = this.catalog.environmentRevisions.find((revision) => revision.id === defaultShellEnvironmentRevision().id)
      ?? defaultShellEnvironmentRevision();
    this.catalog.environmentRevisions = [legacy, shell, ...structuredClone(revisions)
      .filter((revision) => revision.id !== DEFAULT_ENVIRONMENT_REVISION_ID
        && revision.id !== defaultShellEnvironmentRevision().id)];
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
    annotationIds?: string[];
    prompt: string;
    references?: ComposerReference[];
    retryOfRunId?: string;
    sessionId: string;
    settingsSnapshot: SessionRun["settingsSnapshot"];
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
        annotationIds: [...new Set(input.annotationIds ?? [])],
        createdAt: new Date().toISOString(),
        id: randomUUID(),
        prompt,
        queueOrder: runs.reduce((max, candidate) => Math.max(max, candidate.queueOrder), 0) + 1,
        references: structuredClone(input.references ?? []),
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
        sessionId: input.sessionId,
        settingsSnapshot: structuredClone(input.settingsSnapshot),
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
    const runs = await this.listExecutionRuns(run.sessionId);
    runs.push(run);
    await this.writeArray(this.executionRunsPath(run.sessionId), runs);
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
  ): Promise<ChatMessage> {
    const session = this.assertSessionWritable(sessionId);
    const message: ChatMessage = {
      content,
      createdAt: new Date().toISOString(),
      id: randomUUID(),
      kind,
      ...(model ? { modelId: model.id, modelName: model.name } : {}),
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
}
