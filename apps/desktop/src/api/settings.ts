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
 * The settings surfaces behind 设置, one function per route.
 *
 * These are thin on purpose: the routes already carry the contract, and every
 * value here is read back from the server rather than cached in the browser, so
 * a second window on the same data directory cannot drift.
 */

import type { ApiClient } from "./client.js";
import type {
  ConnectorManifest,
  CreateSpecialistRequest,
  CustomMcpServerDetails,
  CustomMcpServerInput,
  EnvironmentPackageSourceId,
  EnvironmentSourceSettings,
  IdeaTreeSettingsDetails,
  McpProxyPolicies,
  McpSource,
  MemoryGraphSettingsDetails,
  NpuRunnerSelectionsResponse,
  ProxyDefaultPolicy,
  ProxyPolicy,
  ProxyServer,
  ProxySettingsDetails,
  RunnerTarget,
  RuntimeSettingsOverrides,
  RuntimeStatus,
  SandboxNetworkSettings,
  SkillDescriptor,
  Specialist,
  SystemQuotaSettings,
  SystemTimeoutSettings,
  UpdateIdeaTreeSettingsRequest,
  UpdateMemoryGraphSettingsRequest,
  UpdateSpecialistRequest,
  UpdateWebSettingsRequest,
  WebSettingsDetails,
} from "./types.js";

/* -- 通用 ---------------------------------------------------------------- */

/** The global layer, including the connectors a run may call. */
export function listConnectors(client: ApiClient): Promise<ConnectorManifest[]> {
  return client.request<ConnectorManifest[]>("/api/connectors");
}

export function getGlobalSettings(
  client: ApiClient,
): Promise<{ effective: unknown; overrides: RuntimeSettingsOverrides; sources: Record<string, string> }> {
  return client.request("/api/settings");
}

/** Whole-object replace, like `putProjectSettings`. Read first, then send the
 *  overrides back with only the field that changed. */
export function putGlobalSettings(
  client: ApiClient,
  overrides: RuntimeSettingsOverrides,
): Promise<unknown> {
  return client.request("/api/settings", {
    body: JSON.stringify(overrides),
    method: "PUT",
  });
}

/**
 * The project layer of the runtime settings.
 *
 * Skill selection lives here rather than in the global layer: the store skips
 * `enabledSkillIds` and `skillSelectionMode` when the source is `global`, so a
 * write through `PUT /api/settings` would be accepted and then ignored. That
 * is the whole reason this pair exists separately.
 */
export function getProjectSettings(
  client: ApiClient,
  projectId: string,
): Promise<{ effective: unknown; overrides: RuntimeSettingsOverrides; sources: Record<string, string> }> {
  return client.request(`/api/projects/${encodeURIComponent(projectId)}/settings`);
}

/** Whole-object replace, same rule as the global layer. */
export function putProjectSettings(
  client: ApiClient,
  projectId: string,
  overrides: RuntimeSettingsOverrides,
): Promise<unknown> {
  return client.request(`/api/projects/${encodeURIComponent(projectId)}/settings`, {
    body: JSON.stringify(overrides),
    method: "PUT",
  });
}

export function getEnvironmentSource(client: ApiClient): Promise<EnvironmentSourceSettings> {
  return client.request<EnvironmentSourceSettings>("/api/environment-source-settings");
}

/** Partial, unlike the other writes here: absent keys keep their stored value. */
export function updateEnvironmentSource(
  client: ApiClient,
  body: Partial<Record<"condaSource" | "pipSource", EnvironmentPackageSourceId>>,
): Promise<EnvironmentSourceSettings> {
  return client.request<EnvironmentSourceSettings>("/api/environment-source-settings", {
    body: JSON.stringify(body),
    method: "PUT",
  });
}

/* -- 技能 ---------------------------------------------------------------- */

export function listSkills(client: ApiClient): Promise<SkillDescriptor[]> {
  return client.request<SkillDescriptor[]>("/api/skills");
}

/**
 * Turn skills on and off for a project.
 *
 * Two fields move together on purpose: `all` is the default selection mode and
 * it overwrites `enabledSkillIds` with the whole installed catalog during
 * resolution, so switching one skill off has to pin the mode to `selected` in
 * the same write or the change evaporates on the next read.
 */
export async function setEnabledSkills(
  client: ApiClient,
  projectId: string,
  enabledSkillIds: string[],
): Promise<void> {
  const current = await getProjectSettings(client, projectId);
  await putProjectSettings(client, projectId, {
    ...current.overrides,
    enabledSkillIds,
    skillSelectionMode: "selected",
  });
}

/* -- 网络 ---------------------------------------------------------------- */

/** MCP servers, with the reason any of them is currently unusable. 网络 uses
 *  them as the targets a module-level proxy policy can point at. */
export function listMcpSources(client: ApiClient): Promise<McpSource[]> {
  return client.request<McpSource[]>("/api/mcp/sources");
}

/** The registry default, which is what a module policy of `inherit` resolves
 *  to. `inherit` is not itself a valid default. */
export function updateProxyDefault(
  client: ApiClient,
  defaultPolicy: Exclude<ProxyPolicy, "inherit">,
): Promise<ProxySettingsDetails> {
  return client.request<ProxySettingsDetails>("/api/proxy/settings", {
    body: JSON.stringify({ defaultPolicy }),
    method: "PUT",
  });
}

export function createProxyServer(
  client: ApiClient,
  body: { kind: string; name: string; url?: string },
): Promise<ProxyServer> {
  return client.request<ProxyServer>("/api/proxy/servers", {
    body: JSON.stringify(body),
    method: "POST",
  });
}

export function updateProxyServer(
  client: ApiClient,
  serverId: string,
  body: { kind?: string; name?: string; url?: string },
): Promise<ProxyServer> {
  return client.request<ProxyServer>(`/api/proxy/servers/${encodeURIComponent(serverId)}`, {
    body: JSON.stringify(body),
    method: "PUT",
  });
}

export function deleteProxyServer(client: ApiClient, serverId: string): Promise<unknown> {
  return client.request(`/api/proxy/servers/${encodeURIComponent(serverId)}`, { method: "DELETE" });
}

export function getMcpProxyPolicies(client: ApiClient): Promise<{ policies: McpProxyPolicies }> {
  return client.request<{ policies: McpProxyPolicies }>("/api/mcp/proxy-policies");
}

export function updateMcpProxyPolicies(
  client: ApiClient,
  policies: McpProxyPolicies,
): Promise<{ policies: McpProxyPolicies }> {
  return client.request<{ policies: McpProxyPolicies }>("/api/mcp/proxy-policies", {
    body: JSON.stringify({ policies }),
    method: "PUT",
  });
}

export function getSandboxNetwork(client: ApiClient): Promise<SandboxNetworkSettings> {
  return client.request<SandboxNetworkSettings>("/api/sandbox-network-settings");
}

/**
 * Save the sandbox network policy.
 *
 * Changing this rotates the permission epoch, and the server drops the
 * persistent kernels of every session that rotated — a saved policy is not a
 * cosmetic change, which is why the UI warns before calling it.
 */
export function updateSandboxNetwork(
  client: ApiClient,
  body: SandboxNetworkSettings,
): Promise<SandboxNetworkSettings> {
  return client.request<SandboxNetworkSettings>("/api/sandbox-network-settings", {
    body: JSON.stringify(body),
    method: "PUT",
  });
}

/* -- 运行时 -------------------------------------------------------------- */

export function getRuntimeStatus(client: ApiClient): Promise<RuntimeStatus> {
  return client.request<RuntimeStatus>("/api/runtime-status");
}

/**
 * End one persistent kernel.
 *
 * A persistent kernel holds its interpreter state between turns and nothing
 * reclaims it on its own until the idle timeout fires — which is `0` (never)
 * by default. This is the only manual way to give that memory back.
 */
export function teardownKernel(client: ApiClient, kernelId: string): Promise<unknown> {
  return client.request(`/api/runtime-status/kernels/${encodeURIComponent(kernelId)}/teardown`, {
    method: "POST",
  });
}

export function probeRunner(client: ApiClient, runnerId: string): Promise<RunnerTarget> {
  return client.request<RunnerTarget>(`/api/runners/${encodeURIComponent(runnerId)}/probe`, {
    method: "POST",
  });
}

/** Only meaningful for a registered remote Runner; the local one is always on. */
export function setRunnerConnected(
  client: ApiClient,
  runnerId: string,
  connected: boolean,
): Promise<unknown> {
  return client.request(`/api/runners/${encodeURIComponent(runnerId)}/${connected ? "connect" : "disconnect"}`, {
    method: "POST",
  });
}

export function getTimeoutSettings(client: ApiClient): Promise<SystemTimeoutSettings> {
  return client.request<SystemTimeoutSettings>("/api/timeout-settings");
}

/** Whole-object replace. A zero disables that timeout. */
export function updateTimeoutSettings(
  client: ApiClient,
  body: SystemTimeoutSettings,
): Promise<SystemTimeoutSettings> {
  return client.request<SystemTimeoutSettings>("/api/timeout-settings", {
    body: JSON.stringify(body),
    method: "PUT",
  });
}

export function getQuotaSettings(client: ApiClient): Promise<SystemQuotaSettings> {
  return client.request<SystemQuotaSettings>("/api/quota-settings");
}

/** Whole-object replace. A zero byte quota disables that limit. */
export function updateQuotaSettings(
  client: ApiClient,
  body: SystemQuotaSettings,
): Promise<SystemQuotaSettings> {
  return client.request<SystemQuotaSettings>("/api/quota-settings", {
    body: JSON.stringify(body),
    method: "PUT",
  });
}

export function listRunners(client: ApiClient): Promise<RunnerTarget[]> {
  return client.request<RunnerTarget[]>("/api/runners");
}

/**
 * Every Runner's Ascend cards, plus which of them the operator selected.
 *
 * Read in one call rather than per machine record, and separately from the
 * catalog, so a machine list still renders if this read fails. The local
 * machine's inventory is fetched live here because it has no connection status
 * to ride along on.
 */
export function listRunnerNpuDevices(client: ApiClient): Promise<NpuRunnerSelectionsResponse> {
  return client.request<NpuRunnerSelectionsResponse>("/api/runners/npu");
}

/**
 * Replace one Runner's card selection.
 *
 * Only cards being *added* are validated against the machine — removing one
 * grants nothing, and judging the whole set would refuse the very request that
 * takes a claimed card back out.
 */
export function setRunnerNpuDevices(
  client: ApiClient,
  runnerId: string,
  devices: number[],
): Promise<{ devices: number[]; runnerId: string }> {
  return client.request(`/api/runners/${encodeURIComponent(runnerId)}/npu-devices`, {
    body: JSON.stringify({ devices }),
    method: "PUT",
  });
}

/* -- 网络与访问 ---------------------------------------------------------- */

export function getProxySettings(client: ApiClient): Promise<ProxySettingsDetails> {
  return client.request<ProxySettingsDetails>("/api/proxy/settings");
}

/** Only the default moves; the registry entries have their own routes. */
export function updateProxyDefaultPolicy(
  client: ApiClient,
  defaultPolicy: ProxyDefaultPolicy,
): Promise<ProxySettingsDetails> {
  return client.request<ProxySettingsDetails>("/api/proxy/settings", {
    body: JSON.stringify({ defaultPolicy }),
    method: "PUT",
  });
}

/* -- MCP ----------------------------------------------------------------- */

export function listMcpServers(client: ApiClient): Promise<CustomMcpServerDetails[]> {
  return client.request<CustomMcpServerDetails[]>("/api/mcp/servers");
}

export function saveMcpServer(
  client: ApiClient,
  body: CustomMcpServerInput,
  id?: string,
): Promise<CustomMcpServerDetails> {
  return client.request<CustomMcpServerDetails>(
    `/api/mcp/servers${id === undefined ? "" : `/${encodeURIComponent(id)}`}`,
    { body: JSON.stringify(body), method: id === undefined ? "POST" : "PUT" },
  );
}

export function testMcpServer(client: ApiClient, id: string): Promise<CustomMcpServerDetails> {
  return client.request<CustomMcpServerDetails>(`/api/mcp/servers/${encodeURIComponent(id)}/test`, {
    method: "POST",
  });
}

export function deleteMcpServer(client: ApiClient, id: string): Promise<{ deleted: boolean }> {
  return client.request<{ deleted: boolean }>(`/api/mcp/servers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/* -- Web ----------------------------------------------------------------- */

export function getWebSettings(client: ApiClient): Promise<WebSettingsDetails> {
  return client.request<WebSettingsDetails>("/api/web/settings");
}

export function updateWebSettings(
  client: ApiClient,
  body: UpdateWebSettingsRequest,
): Promise<WebSettingsDetails> {
  return client.request<WebSettingsDetails>("/api/web/settings", {
    body: JSON.stringify(body),
    method: "PUT",
  });
}

/* -- 记忆与 Idea Tree ---------------------------------------------------- */

export function getMemoryGraphSettings(client: ApiClient): Promise<MemoryGraphSettingsDetails> {
  return client.request<MemoryGraphSettingsDetails>("/api/memory/settings");
}

export function updateMemoryGraphSettings(
  client: ApiClient,
  body: UpdateMemoryGraphSettingsRequest,
): Promise<MemoryGraphSettingsDetails> {
  return client.request<MemoryGraphSettingsDetails>("/api/memory/settings", {
    body: JSON.stringify(body),
    method: "PUT",
  });
}

export function getIdeaTreeSettings(client: ApiClient): Promise<IdeaTreeSettingsDetails> {
  return client.request<IdeaTreeSettingsDetails>("/api/settings/idea-tree");
}

export function updateIdeaTreeSettings(
  client: ApiClient,
  body: UpdateIdeaTreeSettingsRequest,
): Promise<IdeaTreeSettingsDetails> {
  return client.request<IdeaTreeSettingsDetails>("/api/settings/idea-tree", {
    body: JSON.stringify(body),
    method: "PUT",
  });
}

/* -- 专家 ---------------------------------------------------------------- */

export function listSpecialists(client: ApiClient): Promise<Specialist[]> {
  return client.request<Specialist[]>("/api/specialists");
}

export function createSpecialist(
  client: ApiClient,
  body: CreateSpecialistRequest,
): Promise<Specialist> {
  return client.request<Specialist>("/api/specialists", {
    body: JSON.stringify(body),
    method: "POST",
  });
}

export function updateSpecialist(
  client: ApiClient,
  specialistId: string,
  body: UpdateSpecialistRequest,
): Promise<Specialist> {
  return client.request<Specialist>(`/api/specialists/${encodeURIComponent(specialistId)}`, {
    body: JSON.stringify(body),
    method: "PUT",
  });
}

export function deleteSpecialist(
  client: ApiClient,
  specialistId: string,
): Promise<{ deleted: string }> {
  return client.request<{ deleted: string }>(`/api/specialists/${encodeURIComponent(specialistId)}`, {
    method: "DELETE",
  });
}
