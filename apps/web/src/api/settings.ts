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
  CreateModelProfileRequest,
  CreateModelProviderRequest,
  CreateProviderModelRequest,
  CreateProxyServerRequest,
  CreateEnvironmentRequest,
  CreateSpecialistRequest,
  ModelProfile,
  ModelProvider,
  ModelProviderPreset,
  ModelThinkingEffort,
  ModelThinkingMode,
  ProviderModelList,
  McpProxyPolicies,
  ProxyServer,
  ProxySettingsDetails,
  Environment,
  EnvironmentInstallStatus,
  EnvironmentRevision,
  EnvironmentSourceSettings,
  ScientificEnvironmentSetup,
  InstallEnvironmentRequest,
  ModelConnectivityTestResult,
  MemoryGraphSettingsDetails,
  ModelCatalogDetails,
  UninstallEnvironmentRequest,
  RegisterRemoteHostRequest,
  RemoteHostTarget,
  RemoteRunnerStatus,
  ReviewerSpecialistSettings,
  RuntimeSettingsDetails,
  RuntimeSettingsOverrides,
  Specialist,
  SandboxNetworkSettings,
  SystemQuotaSettings,
  SystemTimeoutSettings,
  UpdateMemoryGraphSettingsRequest,
  UpdateEnvironmentSourceSettingsRequest,
  UpdateModelProfileRequest,
  UpdateModelProviderRequest,
  UpdateMcpProxyPoliciesRequest,
  UpdateProxyServerRequest,
  UpdateProxySettingsRequest,
  UpdateSpecialistRequest,
} from "@sciencediscovery/schema";

import { ApiRequestError } from "./auth.js";
import { ArtifactsApiClient } from "./artifacts.js";

/**
 * SSH credentials and host-key trust contract, pending the API change (dev2).
 * Password and private key are write-only: stored encrypted like the direct
 * runner token, never returned by the API, and cleared from the form on save.
 */
export interface SshCredentialsRequest {
  username?: string;
  password?: string;
  privateKey?: string;
}

/** A host key fingerprint the SSH server presented. */
export interface RemoteHostKeyInfo {
  algorithm: string;
  fingerprint: string;
}

/** What "Import from ssh_config" prefills into the SSH form. */
export interface ResolvedSshConfig {
  hostName?: string;
  port?: number;
  username?: string;
  privateKey?: string;
}

export type RegisterRemoteHostBody = RegisterRemoteHostRequest & SshCredentialsRequest & {
  /** Present when the user just trusted this fingerprint in the settings UI. */
  trustHostKey?: RemoteHostKeyInfo;
};

/** Host-key failures arrive as these error codes with `details.hostKey`. */
export const SSH_HOST_KEY_UNTRUSTED_CODE = "SSH_HOST_KEY_UNTRUSTED";
export const SSH_HOST_KEY_CHANGED_CODE = "SSH_HOST_KEY_CHANGED";

/** Extract a structured host-key failure from an API error, if it is one. */
export function hostKeyFromError(reason: unknown): { changed: boolean; hostKey: RemoteHostKeyInfo } | undefined {
  if (!(reason instanceof ApiRequestError)) return undefined;
  if (reason.code !== SSH_HOST_KEY_UNTRUSTED_CODE && reason.code !== SSH_HOST_KEY_CHANGED_CODE) return undefined;
  const hostKey = reason.details?.hostKey as RemoteHostKeyInfo | undefined;
  return hostKey?.fingerprint ? { changed: reason.code === SSH_HOST_KEY_CHANGED_CODE, hostKey } : undefined;
}

export class SettingsApiClient extends ArtifactsApiClient {
  getProxySettings(): Promise<ProxySettingsDetails> {
    return this.request("/api/proxy/settings");
  }

  updateProxySettings(body: UpdateProxySettingsRequest): Promise<ProxySettingsDetails> {
    return this.request("/api/proxy/settings", { body: JSON.stringify(body), method: "PUT" });
  }

  createProxyServer(body: CreateProxyServerRequest): Promise<ProxyServer> {
    return this.request("/api/proxy/servers", { body: JSON.stringify(body), method: "POST" });
  }

  updateProxyServer(serverId: string, body: UpdateProxyServerRequest): Promise<ProxyServer> {
    return this.request(`/api/proxy/servers/${encodeURIComponent(serverId)}`, {
      body: JSON.stringify(body),
      method: "PUT",
    });
  }

  deleteProxyServer(serverId: string): Promise<{ deleted: string }> {
    return this.request(`/api/proxy/servers/${encodeURIComponent(serverId)}`, { method: "DELETE" });
  }

  getMcpProxyPolicies(): Promise<{ policies: McpProxyPolicies }> {
    return this.request("/api/mcp/proxy-policies");
  }

  updateMcpProxyPolicies(body: UpdateMcpProxyPoliciesRequest): Promise<{ policies: McpProxyPolicies }> {
    return this.request("/api/mcp/proxy-policies", { body: JSON.stringify(body), method: "PUT" });
  }

  listSpecialists(): Promise<Specialist[]> {
    return this.request("/api/specialists");
  }

  createSpecialist(body: CreateSpecialistRequest): Promise<Specialist> {
    return this.request("/api/specialists", { body: JSON.stringify(body), method: "POST" });
  }

  updateSpecialist(specialistId: string, body: UpdateSpecialistRequest): Promise<Specialist> {
    return this.request(`/api/specialists/${encodeURIComponent(specialistId)}`, { body: JSON.stringify(body), method: "PUT" });
  }

  deleteSpecialist(specialistId: string): Promise<{ deleted: string }> {
    return this.request(`/api/specialists/${encodeURIComponent(specialistId)}`, { method: "DELETE" });
  }

  listRemoteHosts(): Promise<RemoteHostTarget[]> {
    return this.request("/api/remote-hosts");
  }

  registerRemoteHost(body: RegisterRemoteHostBody): Promise<RemoteHostTarget> {
    return this.request("/api/remote-hosts", { body: JSON.stringify(body), method: "POST" });
  }

  /** Replace the stored SSH credentials of an already-registered host. */
  updateRemoteHostCredentials(hostId: string, body: SshCredentialsRequest): Promise<RemoteHostTarget> {
    return this.request(`/api/remote-hosts/${encodeURIComponent(hostId)}/credentials`, {
      body: JSON.stringify(body),
      method: "PUT",
    });
  }

  /** Record a host key the user just trusted in the settings UI. */
  trustRemoteHostKey(hostId: string, hostKey: RemoteHostKeyInfo): Promise<RemoteHostTarget> {
    return this.request(`/api/remote-hosts/${encodeURIComponent(hostId)}/trust-host-key`, {
      body: JSON.stringify(hostKey),
      method: "POST",
    });
  }

  /** Resolve an ssh_config Host entry to prefill the SSH form ("import alias"). */
  resolveSshConfig(alias: string): Promise<ResolvedSshConfig> {
    return this.request(`/api/remote-hosts/ssh-config?alias=${encodeURIComponent(alias)}`);
  }

  probeRemoteHost(hostId: string): Promise<RemoteHostTarget> {
    return this.request(`/api/remote-hosts/${encodeURIComponent(hostId)}/probe`, { method: "POST" });
  }

  deleteRemoteHost(hostId: string): Promise<{ deleted: string }> {
    return this.request(`/api/remote-hosts/${encodeURIComponent(hostId)}`, { method: "DELETE" });
  }

  connectRemoteRunner(hostId: string): Promise<RemoteRunnerStatus> {
    return this.request(`/api/remote-hosts/${encodeURIComponent(hostId)}/runner/connect`, { method: "POST" });
  }

  disconnectRemoteRunner(hostId: string): Promise<RemoteRunnerStatus> {
    return this.request(`/api/remote-hosts/${encodeURIComponent(hostId)}/runner/disconnect`, { method: "POST" });
  }

  getGlobalSettings(): Promise<RuntimeSettingsDetails> {
    return this.request("/api/settings");
  }

  replaceGlobalSettings(body: RuntimeSettingsOverrides): Promise<RuntimeSettingsDetails> {
    return this.request("/api/settings", { body: JSON.stringify(body), method: "PUT" });
  }

  getReviewerSpecialistSettings(): Promise<ReviewerSpecialistSettings> {
    return this.request("/api/reviewer-specialist/settings");
  }

  updateReviewerSpecialistSettings(settings: ReviewerSpecialistSettings): Promise<ReviewerSpecialistSettings> {
    return this.request("/api/reviewer-specialist/settings", {
      body: JSON.stringify(settings),
      method: "PUT",
    });
  }

  getTimeoutSettings(): Promise<SystemTimeoutSettings> {
    return this.request("/api/timeout-settings");
  }

  replaceTimeoutSettings(body: SystemTimeoutSettings): Promise<SystemTimeoutSettings> {
    return this.request("/api/timeout-settings", { body: JSON.stringify(body), method: "PUT" });
  }

  getQuotaSettings(): Promise<SystemQuotaSettings> {
    return this.request("/api/quota-settings");
  }

  replaceQuotaSettings(body: SystemQuotaSettings): Promise<SystemQuotaSettings> {
    return this.request("/api/quota-settings", { body: JSON.stringify(body), method: "PUT" });
  }

  getSandboxNetworkSettings(): Promise<SandboxNetworkSettings> {
    return this.request("/api/sandbox-network-settings");
  }

  replaceSandboxNetworkSettings(body: SandboxNetworkSettings): Promise<SandboxNetworkSettings> {
    return this.request("/api/sandbox-network-settings", { body: JSON.stringify(body), method: "PUT" });
  }

  getMemoryGraphSettings(): Promise<MemoryGraphSettingsDetails> {
    return this.request("/api/memory/settings");
  }

  updateMemoryGraphSettings(body: UpdateMemoryGraphSettingsRequest): Promise<MemoryGraphSettingsDetails> {
    return this.request("/api/memory/settings", { body: JSON.stringify(body), method: "PUT" });
  }

  listModels(): Promise<ModelProfile[]> {
    return this.request("/api/models");
  }

  listProviders(): Promise<{ presets: ModelProviderPreset[]; providers: ModelProvider[] }> {
    return this.request("/api/providers");
  }

  getModelCatalog(): Promise<ModelCatalogDetails> {
    return this.request("/api/model-catalog");
  }

  /** Download a fresh catalog. A failure rejects and the server keeps serving
   *  the snapshot it already had. */
  refreshModelCatalog(): Promise<ModelCatalogDetails> {
    return this.request("/api/model-catalog/refresh", { method: "POST" });
  }

  createProvider(body: CreateModelProviderRequest): Promise<ModelProvider> {
    return this.request("/api/providers", { body: JSON.stringify(body), method: "POST" });
  }

  updateProvider(providerId: string, body: UpdateModelProviderRequest): Promise<ModelProvider> {
    return this.request(`/api/providers/${encodeURIComponent(providerId)}`, {
      body: JSON.stringify(body),
      method: "PUT",
    });
  }

  deleteProvider(providerId: string): Promise<{ deleted: string }> {
    return this.request(`/api/providers/${encodeURIComponent(providerId)}`, { method: "DELETE" });
  }

  listProviderModels(providerId: string, refresh = false): Promise<ProviderModelList> {
    const query = refresh ? "?refresh=1" : "";
    return this.request(`/api/providers/${encodeURIComponent(providerId)}/models${query}`);
  }

  addProviderModel(
    providerId: string,
    body: CreateProviderModelRequest,
  ): Promise<ModelProfile> {
    return this.request(`/api/providers/${encodeURIComponent(providerId)}/models`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  listEnvironmentRevisions(): Promise<EnvironmentRevision[]> {
    return this.request("/api/environment-revisions");
  }

  getEnvironmentSourceSettings(): Promise<EnvironmentSourceSettings> {
    return this.request("/api/environment-source-settings");
  }

  updateEnvironmentSourceSettings(
    body: UpdateEnvironmentSourceSettingsRequest,
  ): Promise<EnvironmentSourceSettings> {
    return this.request("/api/environment-source-settings", {
      body: JSON.stringify(body),
      method: "PUT",
    });
  }

  listEnvironments(): Promise<Environment[]> {
    return this.request("/api/environments");
  }

  getEnvironmentSetup(): Promise<ScientificEnvironmentSetup> {
    return this.request("/api/environment-setup");
  }

  setupScientificEnvironments(): Promise<ScientificEnvironmentSetup> {
    return this.request("/api/environment-setup", { body: JSON.stringify({ confirmed: true }), method: "POST" });
  }

  createEnvironment(body: CreateEnvironmentRequest): Promise<Environment> {
    return this.request("/api/environments", { body: JSON.stringify(body), method: "POST" });
  }

  deleteEnvironment(environmentId: string): Promise<{ deleted: string }> {
    return this.request(`/api/environments/${encodeURIComponent(environmentId)}`, {
      method: "DELETE",
    });
  }

  installEnvironment(environmentId: string, body: InstallEnvironmentRequest): Promise<EnvironmentInstallStatus> {
    return this.request(`/api/environments/${encodeURIComponent(environmentId)}/install`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  uninstallEnvironment(environmentId: string, body: UninstallEnvironmentRequest): Promise<EnvironmentInstallStatus> {
    return this.request(`/api/environments/${encodeURIComponent(environmentId)}/uninstall`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  createModel(body: CreateModelProfileRequest): Promise<ModelProfile> {
    return this.request("/api/models", { body: JSON.stringify(body), method: "POST" });
  }

  updateModel(modelId: string, body: UpdateModelProfileRequest): Promise<ModelProfile> {
    return this.request(`/api/models/${encodeURIComponent(modelId)}`, {
      body: JSON.stringify(body),
      method: "PUT",
    });
  }

  deleteModel(modelId: string): Promise<{ deleted: string }> {
    return this.request(`/api/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
  }

  testModel(modelId: string): Promise<ModelConnectivityTestResult> {
    return this.request(`/api/models/${encodeURIComponent(modelId)}/test`, { method: "POST" });
  }
}
