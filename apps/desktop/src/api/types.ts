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

/**
 * The schema surface this app actually uses, re-exported as types.
 *
 * Views import from here rather than from `@sciencediscovery/schema` so that
 * the one place the two are wired together stays visible. Everything is
 * `import type`, which is what keeps the schema barrel (and the JSON property
 * import it reaches through `@sciencediscovery/external-urls`) out of the
 * browser bundle: a type-only re-export is erased at build time.
 */

import type {
  EffectiveRuntimeSettings,
  ModelProvider,
  ModelProviderPreset,
  RuntimeSettingsOverrides,
} from "@sciencediscovery/schema";

export type {
  ApprovalMode,
  ChatMessage,
  ConnectorManifest,
  CreateModelProfileRequest,
  CreateModelProviderRequest,
  CreateSessionRequest,
  CreateSkillPackageRequest,
  CreateSpecialistRequest,
  CustomMcpServerDetails,
  CustomMcpServerInput,
  EffectiveRuntimeSettings,
  EnvironmentCondaSourceId,
  EnvironmentPackageSourceId,
  EnvironmentPipSourceId,
  EnvironmentSourceSettings,
  FreeSearchEngine,
  IdeaTreeSettingsDetails,
  KernelSession,
  McpProxyPolicies,
  MemoryGraphSettingsDetails,
  ModelConnectivityTestResult,
  ModelProfile,
  ModelProvider,
  ModelProviderPreset,
  ModelProviderPresetId,
  NpuDeviceStatus,
  NpuInventory,
  NpuRunnerSelectionsResponse,
  PermissionAction,
  PermissionDecision,
  PermissionDecisionResult,
  PermissionGrant,
  PermissionGrantScope,
  PermissionRequest,
  ProviderModelEntry,
  PaidSearchProvider,
  ProviderModelList,
  ProviderModelPreview,
  Project,
  ProxyDefaultPolicy,
  ProxyEnvironmentDetails,
  ProxyEnvironmentStatus,
  ProxyPolicy,
  ProxyServer,
  ProxyServerKind,
  ProxySettingsDetails,
  RegisterRemoteHostRequest,
  RemoteConnectLog,
  RemoteConnectLogEntry,
  RemoteHostConnectionKind,
  RemoteHostKeyState,
  RemoteHostReachability,
  RemoteHostTarget,
  RemoteRunnerStatus,
  RunFailureCode,
  RunStreamEvent,
  RunnerResources,
  RunnerRuntimeStatus,
  RunnerTarget,
  RuntimeSessionRun,
  RuntimeSettingsDetails,
  RuntimeSettingsOverrides,
  RuntimeStatus,
  SandboxNetworkMode,
  SandboxNetworkSettings,
  ScientificArtifact,
  ScientificArtifactKind,
  ScientificArtifactVersion,
  SendMessageRequest,
  Session,
  SessionArtifactOutput,
  SessionDetail,
  SessionListState,
  SessionRun,
  SessionRunEvent,
  SessionRunStatus,
  SkillDescriptor,
  SkillDetail,
  SkillSource,
  Specialist,
  SpecialistRuntime,
  SshConfigHostImport,
  SshKeyFileListing,
  Subagent,
  SubagentStep,
  SubagentUsage,
  SystemQuotaSettings,
  SystemTimeoutSettings,
  ToolTrace,
  TrustedRemoteHostKey,
  UpdateIdeaTreeSettingsRequest,
  UpdateMemoryGraphSettingsRequest,
  UpdateProjectRequest,
  UpdateSessionRequest,
  UpdateSpecialistRequest,
  UpdateWebSettingsRequest,
  WebFetchProvider,
  WebKeyProvider,
  WebSettingsDetails,
  WorkspaceCapabilities,
  WorkspaceConflictPolicy,
  WorkspaceFile,
  WorkspaceUploadItemResult,
  WorkspaceUploadResult,
} from "@sciencediscovery/schema";

/** One entry of `GET /api/mcp/sources`: the server's own manifest plus what it
 *  last observed about reachability. The status carries the reason a server is
 *  unusable, which is the only place that reason is exposed.
 *
 *  `tools` is a map keyed by tool id, not a list — a `Record` is what the wire
 *  sends. Declaring it as an array here once hid a page that counted `.length`
 *  on an object and therefore reported zero tools for every server. */
export interface McpSource {
  manifest: {
    cache?: { enabled?: boolean; scope?: string; ttlSeconds?: number };
    description?: string;
    displayName?: string;
    enabledByDefault?: boolean;
    governance?: {
      dataClassification?: string;
      license?: string;
      networkHosts?: string[];
    };
    id: string;
    kinds?: string[];
    publisher?: string;
    tools?: Record<string, { description?: string; displayName?: string; id: string; kind?: string }>;
    transport?: { mcpServerId?: string; type?: string };
    version?: string;
  };
  status: {
    availableTools?: string[];
    catalogRevision?: string;
    error?: string;
    lastCheckedAt?: string;
    missingTools?: string[];
    sourceId?: string;
    status: string;
  };
}

/**
 * `POST /api/remote-hosts/generate-key` — a key pair the product made for one
 * machine. Only the public half is ever shown; the private half stays in the
 * API's data directory and reaches the product as this path, never as material.
 */
export interface GeneratedRemoteHostKey {
  privateKeyPath: string;
  publicKey: string;
}

/** `GET /api/providers` answers both halves in one round trip. */
export interface ProviderCatalog {
  presets: ModelProviderPreset[];
  providers: ModelProvider[];
}

/**
 * `GET /api/settings` — the global layer. `overrides` is what a write must
 * send back verbatim; `effective` and `sources` are read-only output.
 */
export interface GlobalSettings {
  effective: EffectiveRuntimeSettings;
  overrides: RuntimeSettingsOverrides;
  sources: Record<string, string>;
}

/** Shape of every non-2xx body the API sends. */
export interface ApiErrorBody {
  code?: string;
  details?: Record<string, unknown>;
  error?: string;
}
