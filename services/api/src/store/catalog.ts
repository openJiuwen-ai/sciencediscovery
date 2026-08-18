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

import type {
  ArtifactAnnotation,
  Environment,
  EnvironmentRevision,
  EnvironmentSourceSettings,
  McpProxyPolicies,
  MemoryGraphSettings,
  ModelProfile,
  ProxyDefaultPolicy,
  ProxyServer,
  PermissionEpoch,
  PermissionGrant,
  PermissionRequest,
  Project,
  RemoteHostTarget,
  RemoteJob,
  ReviewerSpecialistLevel,
  RuntimeSettingsOverrides,
  SandboxNetworkSettings,
  ScientificArtifact,
  ScientificArtifactVersion,
  Session,
  SessionPlan,
  Specialist,
  Subagent,
  SystemQuotaSettings,
  SystemTimeoutSettings,
  WebSettings,
} from "@science-agent/schema";
import {
  DEFAULT_SANDBOX_NETWORK_SETTINGS,
  DEFAULT_SYSTEM_QUOTA_SETTINGS,
  DEFAULT_ENVIRONMENT_SOURCE_SETTINGS,
  DEFAULT_REVIEWER_SPECIALIST_LEVEL,
  DEFAULT_SYSTEM_TIMEOUT_SETTINGS,
  DEFAULT_MEMORY_GRAPH_SETTINGS,
  DEFAULT_WEB_SETTINGS,
} from "@science-agent/schema";

import { defaultEnvironmentRevision, defaultShellEnvironmentRevision } from "../environment.js";
import { BUILTIN_SPECIALISTS } from "../builtin-specialists.js";

export interface Catalog {
  artifactAnnotations: ArtifactAnnotation[];
  artifactVersions: ScientificArtifactVersion[];
  artifacts: ScientificArtifact[];
  subagents: Subagent[];
  environments: Environment[];
  environmentRevisions: EnvironmentRevision[];
  environmentSourceSettings: EnvironmentSourceSettings;
  globalSettings: RuntimeSettingsOverrides;
  mcpProxyPolicies: McpProxyPolicies;
  memoryGraphSettings: MemoryGraphSettings;
  models: ModelProfile[];
  permissionEpochs: PermissionEpoch[];
  proxyDefaultPolicy: ProxyDefaultPolicy;
  proxyServers: ProxyServer[];
  permissionGrants: PermissionGrant[];
  permissionRequests: PermissionRequest[];
  projects: Project[];
  quotaSettings: SystemQuotaSettings;
  sandboxNetworkSettings: SandboxNetworkSettings;
  reviewerSpecialistEnabled: boolean;
  reviewerSpecialistLevel: ReviewerSpecialistLevel;
  remoteHosts: RemoteHostTarget[];
  remoteJobs: RemoteJob[];
  sessionPlans: SessionPlan[];
  sessions: Session[];
  specialists: Specialist[];
  timeoutSettings: SystemTimeoutSettings;
  webSettings: WebSettings;
}

export function emptyCatalog(
  initialTimeoutSettings: SystemTimeoutSettings = DEFAULT_SYSTEM_TIMEOUT_SETTINGS,
  initialQuotaSettings: SystemQuotaSettings = DEFAULT_SYSTEM_QUOTA_SETTINGS,
): Catalog {
  return {
    artifactAnnotations: [],
    artifactVersions: [],
    artifacts: [],
    subagents: [],
    environments: [],
    environmentRevisions: [defaultEnvironmentRevision(), defaultShellEnvironmentRevision()],
    environmentSourceSettings: structuredClone(DEFAULT_ENVIRONMENT_SOURCE_SETTINGS),
    // Skill selection starts at the Project layer, so Global carries no skill fields.
    globalSettings: {
      enabledConnectorIds: [],
      semanticReviewEnabled: true,
    },
    mcpProxyPolicies: {},
    memoryGraphSettings: structuredClone(DEFAULT_MEMORY_GRAPH_SETTINGS),
    models: [],
    permissionEpochs: [],
    proxyDefaultPolicy: `proxy:${ENVIRONMENT_PROXY_SERVER_ID}`,
    proxyServers: [environmentProxyServer()],
    permissionGrants: [],
    permissionRequests: [],
    projects: [],
    quotaSettings: structuredClone(initialQuotaSettings),
    sandboxNetworkSettings: structuredClone(DEFAULT_SANDBOX_NETWORK_SETTINGS),
    reviewerSpecialistEnabled: false,
    reviewerSpecialistLevel: DEFAULT_REVIEWER_SPECIALIST_LEVEL,
    remoteHosts: [],
    remoteJobs: [],
    sessionPlans: [],
    sessions: [],
    // Built-in specialists are seeded (read-only) and all enabled by default
    // (no `enabled` key means enabled).
    specialists: BUILTIN_SPECIALISTS.map((specialist) => ({ ...structuredClone(specialist) })),
    timeoutSettings: structuredClone(initialTimeoutSettings),
    webSettings: structuredClone(DEFAULT_WEB_SETTINGS),
  };
}

/** Seeded registry entry preserving the historical default of trusting the
 *  process proxy environment variables. Editable and deletable like any
 *  other entry once operators take over the registry. */
export const ENVIRONMENT_PROXY_SERVER_ID = "environment";

export function environmentProxyServer(): ProxyServer {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    hasUrl: false,
    id: ENVIRONMENT_PROXY_SERVER_ID,
    kind: "environment",
    name: "Environment variables",
    updatedAt: now,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
