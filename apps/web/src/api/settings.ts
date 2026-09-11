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
  NpuRunnerSelectionsResponse,
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
  RunnerTarget,
  SshConfigHostImport,
  SshKeyFileListing,
  TrustedRemoteHostKey,
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
 * SSH credentials are write-only: stored encrypted like the direct runner
 * token, never returned by the API, and cleared from the form on save.
 * Sending `null` forgets a stored value.
 */
export type SshCredentialsRequest = Pick<RegisterRemoteHostRequest, "passphrase" | "password" | "privateKeyPath" | "username">;

/** A host key fingerprint the SSH server presented. */
export type RemoteHostKeyInfo = Pick<TrustedRemoteHostKey, "algorithm" | "fingerprint">;

/**
 * A key pair the product generated for one machine: the private key stays in
 * the API's data directory and is only referenced by path; the browser only
 * ever receives the public key and that opaque path.
 */
export interface GeneratedRemoteHostKey {
  privateKeyPath: string;
  publicKey: string;
}

/** Host-key failures arrive as these error codes with `details.hostKey`. */
export const SSH_HOST_KEY_UNTRUSTED_CODE = "SSH_HOST_KEY_UNTRUSTED";
export const SSH_HOST_KEY_CHANGED_CODE = "SSH_HOST_KEY_CHANGED";

/** Extract a structured host-key failure from an API error, if it is one. */
export function hostKeyFromError(reason: unknown): { changed: boolean; hostKey: RemoteHostKeyInfo; hostId?: string } | undefined {
  if (!(reason instanceof ApiRequestError)) return undefined;
  if (reason.code !== SSH_HOST_KEY_UNTRUSTED_CODE && reason.code !== SSH_HOST_KEY_CHANGED_CODE) return undefined;
  const hostKey = reason.details?.hostKey as RemoteHostKeyInfo | undefined;
  return hostKey?.fingerprint ? {
    changed: reason.code === SSH_HOST_KEY_CHANGED_CODE,
    hostKey,
    ...(typeof reason.details?.hostId === "string" ? { hostId: reason.details.hostId } : {}),
  } : undefined;
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

  listSshKeyFiles(path?: string, offset = 0): Promise<SshKeyFileListing> {
    const query = new URLSearchParams({ offset: String(offset) });
    if (path) query.set("path", path);
    return this.request(`/api/remote-hosts/key-files?${query}`);
  }

  registerRemoteHost(body: RegisterRemoteHostRequest): Promise<RemoteHostTarget> {
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

  /** List the ssh_config Host entries the settings page offers for import. */
  listSshConfigHosts(): Promise<SshConfigHostImport[]> {
    return this.request("/api/remote-hosts/ssh-config");
  }

  /** Resolve one selected ssh_config Host entry, including its identity-file path. */
  resolveSshConfigHost(alias: string): Promise<SshConfigHostImport> {
    return this.request(`/api/remote-hosts/ssh-config?alias=${encodeURIComponent(alias)}`);
  }

  /**
   * Generate an Ed25519 key pair for one machine. The private key never
   * leaves the API; the response carries the public key to display and the
   * key path to reference on registration.
   */
  generateRemoteHostKey(): Promise<GeneratedRemoteHostKey> {
    return this.request("/api/remote-hosts/generate-key", { method: "POST" });
  }

  probeRemoteHost(hostId: string): Promise<RemoteHostTarget> {
    return this.request(`/api/remote-hosts/${encodeURIComponent(hostId)}/probe`, { method: "POST" });
  }

  /** Every Runner's NPU selection, plus the local machine's own cards. */
  listRunnerNpuDevices(): Promise<NpuRunnerSelectionsResponse> {
    return this.request("/api/runners/npu");
  }

  /**
   * Choose which NPU cards one Runner may hand to its sandboxes; `local` is the
   * machine ScienceDiscovery runs on. The API refuses cards the Runner's
   * sandbox probe could not open, so a rejected selection comes back as an
   * error naming the card rather than being stored and failing at execution.
   */
  setRunnerNpuDevices(runnerId: string, devices: number[]): Promise<{ devices: number[]; runnerId: string }> {
    return this.request(`/api/runners/${encodeURIComponent(runnerId)}/npu-devices`, {
      body: JSON.stringify({ devices }),
      method: "PUT",
    });
  }

  deleteRemoteHost(hostId: string): Promise<{ deleted: string }> {
    return this.request(`/api/remote-hosts/${encodeURIComponent(hostId)}`, { method: "DELETE" });
  }

  listRunners(): Promise<RunnerTarget[]> { return this.request("/api/runners"); }

  connectRunner(id: string): Promise<RemoteRunnerStatus> {
    return this.request(`/api/runners/${encodeURIComponent(id)}/connect`, { method: "POST" });
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

  updateReviewerSpecialistSettings(
    settings: Pick<ReviewerSpecialistSettings, "enabled">,
  ): Promise<ReviewerSpecialistSettings> {
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
