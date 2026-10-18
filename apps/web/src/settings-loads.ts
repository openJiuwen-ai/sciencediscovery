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
  ConnectorManifest,
  IdeaTreeSettingsDetails,
  McpProxyPolicies,
  McpSourceDetails,
  MemoryGraphSettingsDetails,
  ModelCatalogDetails,
  ModelProfile,
  ModelProvider,
  ModelProviderPreset,
  Project,
  ProxySettingsDetails,
  RuntimeSettingsDetails,
  SandboxNetworkSettings,
  SkillDescriptor,
  SkillLibrary,
  SystemQuotaSettings,
  SystemTimeoutSettings,
  WebSettingsDetails,
  WorkspaceCapabilities,
} from "@sciencediscovery/schema";

/** One settings read and the state it owns. A rejection never reaches `apply`. */
type SettledLoad = {
  load: () => Promise<unknown>;
  apply: (value: any) => void;
  /** Runs after a successful apply, and also when this read rejects. */
  onSettled?: () => void;
};

export function load<T>(loadFn: () => Promise<T>, apply: (value: T) => void, onSettled?: () => void): SettledLoad {
  return { load: loadFn, apply, ...(onSettled ? { onSettled } : {}) };
}

/**
 * Run a settings batch so one read cannot block or discard the others.
 * Each success is applied as soon as that read returns. Each rejection is
 * reported then. The returned promise resolves only after every read has
 * settled, so callers can wait for the batch without delaying the updates.
 * An empty success is still applied.
 */
export function settleLoads(tasks: readonly SettledLoad[], onError: (reason: Error) => void): Promise<void> {
  return Promise.all(tasks.map((task) => task.load().then(
    (value) => {
      task.apply(value);
      task.onSettled?.();
    },
    (reason: unknown) => {
      task.onSettled?.();
      onError(reason instanceof Error ? reason : new Error(String(reason)));
    },
  ))).then(() => undefined);
}

export function workspaceCapabilitiesFromQuota(quotas: SystemQuotaSettings): WorkspaceCapabilities {
  return {
    maxFileBytes: quotas.uploadMaxFileBytes,
    maxRequestBytes: quotas.uploadMaxRequestBytes,
    maxWorkspaceBytes: quotas.runnerMaxWorkspaceBytes,
  };
}

type McpSourceListing = McpSourceDetails[];
type ProviderRegistry = { presets: ModelProviderPreset[]; providers: ModelProvider[] };

/** Reads the System settings dialog refreshes, including the provider registry. */
export type SystemSettingsLoadClient = {
  listProviders: () => Promise<ProviderRegistry>;
  listModels: () => Promise<ModelProfile[]>;
  listConnectors: () => Promise<ConnectorManifest[]>;
  listSkills: () => Promise<SkillDescriptor[]>;
  listSkillLibraries: () => Promise<SkillLibrary[]>;
  getGlobalSettings: () => Promise<RuntimeSettingsDetails>;
  getTimeoutSettings: () => Promise<SystemTimeoutSettings>;
  getQuotaSettings: () => Promise<SystemQuotaSettings>;
  getSandboxNetworkSettings: () => Promise<SandboxNetworkSettings>;
  getWebSettings: () => Promise<WebSettingsDetails>;
  getMemoryGraphSettings: () => Promise<MemoryGraphSettingsDetails>;
  getIdeaTreeSettings: () => Promise<IdeaTreeSettingsDetails>;
};

export type SystemSettingsLoadTargets = {
  providers: (value: ProviderRegistry) => void;
  models: (value: ModelProfile[]) => void;
  connectors: (value: ConnectorManifest[]) => void;
  skills: (value: SkillDescriptor[]) => void;
  skillLibraries: (value: SkillLibrary[]) => void;
  globalSettings: (value: RuntimeSettingsDetails) => void;
  timeouts: (value: SystemTimeoutSettings) => void;
  quotas: (value: SystemQuotaSettings) => void;
  sandboxNetwork: (value: SandboxNetworkSettings) => void;
  web: (value: WebSettingsDetails) => void;
  memoryGraph: (value: MemoryGraphSettingsDetails) => void;
  ideaTree: (value: IdeaTreeSettingsDetails) => void;
};

export function systemSettingsLoads(client: SystemSettingsLoadClient, targets: SystemSettingsLoadTargets): SettledLoad[] {
  return [
    load(() => client.listProviders(), targets.providers),
    load(() => client.listModels(), targets.models),
    load(() => client.listConnectors(), targets.connectors),
    load(() => client.listSkills(), targets.skills),
    load(() => client.listSkillLibraries(), targets.skillLibraries),
    load(() => client.getGlobalSettings(), targets.globalSettings),
    load(() => client.getTimeoutSettings(), targets.timeouts),
    load(() => client.getQuotaSettings(), targets.quotas),
    load(() => client.getSandboxNetworkSettings(), targets.sandboxNetwork),
    load(() => client.getWebSettings(), targets.web),
    load(() => client.getMemoryGraphSettings(), targets.memoryGraph),
    load(() => client.getIdeaTreeSettings(), targets.ideaTree),
  ];
}

/** Reads the cold start performs. The provider registry is included with the system settings reads. */
export type StartupLoadClient = SystemSettingsLoadClient & {
  listProjects: () => Promise<Project[]>;
  getModelCatalog: () => Promise<ModelCatalogDetails>;
  getProxySettings: () => Promise<ProxySettingsDetails>;
  getMcpProxyPolicies: () => Promise<{ policies: McpProxyPolicies }>;
  listMcpSources: () => Promise<McpSourceListing>;
};

export type StartupLoadTargets = SystemSettingsLoadTargets & {
  projects: (value: Project[]) => void;
  /** Fired when the project list settles, whether or not the read succeeded. */
  onProjectsSettled?: () => void;
  catalog: (value: ModelCatalogDetails) => void;
  proxies: (value: ProxySettingsDetails) => void;
  mcpPolicies: (value: { policies: McpProxyPolicies }) => void;
  mcpSources: (value: McpSourceListing) => void;
};

export function startupLoads(client: StartupLoadClient, targets: StartupLoadTargets): SettledLoad[] {
  return [
    load(() => client.listProjects(), targets.projects, targets.onProjectsSettled),
    ...systemSettingsLoads(client, targets),
    load(() => client.getModelCatalog(), targets.catalog),
    load(() => client.getProxySettings(), targets.proxies),
    load(() => client.getMcpProxyPolicies(), targets.mcpPolicies),
    load(() => client.listMcpSources(), targets.mcpSources),
  ];
}
