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
  CreateProxyServerRequest,
  CreateEnvironmentRequest,
  CreateSpecialistRequest,
  ModelProfile,
  McpProxyPolicies,
  ProxyServer,
  ProxySettingsDetails,
  Environment,
  EnvironmentInstallStatus,
  EnvironmentRevision,
  EnvironmentSourceSettings,
  ScientificEnvironmentSetup,
  InstallEnvironmentRequest,
  MemoryGraphSettingsDetails,
  UninstallEnvironmentRequest,
  RegisterRemoteHostRequest,
  RemoteHostTarget,
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
  UpdateMcpProxyPoliciesRequest,
  UpdateProxyServerRequest,
  UpdateProxySettingsRequest,
  UpdateSpecialistRequest,
} from "@science-agent/schema";

import { ArtifactsApiClient } from "./artifacts.js";

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

  registerRemoteHost(body: RegisterRemoteHostRequest): Promise<RemoteHostTarget> {
    return this.request("/api/remote-hosts", { body: JSON.stringify(body), method: "POST" });
  }

  probeRemoteHost(hostId: string): Promise<RemoteHostTarget> {
    return this.request(`/api/remote-hosts/${encodeURIComponent(hostId)}/probe`, { method: "POST" });
  }

  deleteRemoteHost(hostId: string): Promise<{ deleted: string }> {
    return this.request(`/api/remote-hosts/${encodeURIComponent(hostId)}`, { method: "DELETE" });
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
}
