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
  McpAuthorizationStart,
  McpInspectorRequest,
  McpInspectorResult,
} from "@sciencediscovery/schema";
import type {
  CreateEnvironmentRequest,
  CreateProxyServerRequest,
  Environment,
  EnvironmentInstallStatus,
  EnvironmentRevision,
  InstallEnvironmentRequest,
  ScientificEnvironmentSetup,
  UpdateProxyServerRequest,
  UpdateProxySettingsRequest,
  ResolvedProxy,
  ConnectorManifest,
  CreateSkillPackageRequest,
  JiuwenSwarmSkillsResponse,
  JiuwenSwarmSkillSwitchTarget,
  JiuwenSwarmSkillsStateResponse,
  CreateSpecialistRequest,
  CustomMcpServerDetails,
  CustomMcpServerInput,
  EnvironmentPackageSourceId,
  EnvironmentSourceSettings,
  GitSkillRepositoryInspection,
  IdeaTreeSettingsDetails,
  ImportSkillFromGitRequest,
  GitSkillImportJob,
  InspectGitSkillRepositoryRequest,
  StartGitSkillImportJobRequest,
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
  SkillDeletionImpact,
  SkillDescriptor,
  SkillDetail,
  SkillMarkdownContent,
  SkillResourceContent,
  DeleteSkillFileRequest,
  RenameSkillFileRequest,
  UpdateSkillMarkdownRequest,
  Specialist,
  SystemQuotaSettings,
  SystemTimeoutSettings,
  UpdateIdeaTreeSettingsRequest,
  UpdateMemoryGraphSettingsRequest,
  UpdateSkillFileRequest,
  UpdateSkillRequest,
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

/** JiuwenSwarm's global skill on/off state and which backend is active. */
export function getJiuwenSwarmSkills(client: ApiClient): Promise<JiuwenSwarmSkillsResponse> {
  return client.request<JiuwenSwarmSkillsResponse>("/api/jiuwenswarm/skills");
}

/** Toggle a skill JiuwenSwarm already owns, including its built-in skills. */
export function setJiuwenSwarmSkillEnabled(client: ApiClient, name: string, enabled: boolean): Promise<void> {
  return client.request<void>(`/api/jiuwenswarm/skills/${encodeURIComponent(name)}`, {
    body: JSON.stringify({ enabled }),
    method: "PUT",
  });
}

/** Toggle one ScienceDiscovery skill in JiuwenSwarm by its id, importing it first if needed. */
export function setJiuwenSwarmSkillEnabledById(client: ApiClient, skillId: string, enabled: boolean): Promise<void> {
  return client.request<void>(`/api/jiuwenswarm/skills-by-id/${encodeURIComponent(skillId)}`, {
    body: JSON.stringify({ enabled }),
    method: "PUT",
  });
}

/**
 * Switch a whole page of skills to one state in a single request.
 *
 * Each target names JiuwenSwarm's own name for a skill the page already lists,
 * so the server needs no per-skill lookup; an id it does not have yet is
 * resolved (and, to enable it, imported) on the server. The answer carries one
 * result per target, which is how the page rolls back only the rows that
 * failed instead of all of them.
 */
export function setJiuwenSwarmSkillsEnabled(
  client: ApiClient,
  targets: readonly JiuwenSwarmSkillSwitchTarget[],
  enabled: boolean,
): Promise<JiuwenSwarmSkillsStateResponse> {
  return client.request<JiuwenSwarmSkillsStateResponse>("/api/jiuwenswarm/skills-batch", {
    body: JSON.stringify({ enabled, targets }),
    method: "PUT",
  });
}

/** One installed skill with the parts the list does not carry: its SKILL.md
 *  body and its files. Read when a card is expanded, not with the list. */
export function getSkill(client: ApiClient, skillId: string): Promise<SkillDetail> {
  return client.request<SkillDetail>(`/api/skills/${encodeURIComponent(skillId)}`);
}

/** Author a new skill package from the form. The server turns the fields into
 *  SKILL.md and installs the first revision. */
export function createSkill(
  client: ApiClient,
  body: CreateSkillPackageRequest,
): Promise<SkillDetail> {
  return client.request<SkillDetail>("/api/skills", {
    body: JSON.stringify(body),
    method: "POST",
  });
}

/** Install a `SKILL.md` or a ZIP package. The multipart field name is the
 *  server's, not a choice: `file`, with no content type of our own. */
export function importSkillFile(client: ApiClient, file: File): Promise<SkillDetail> {
  const form = new FormData();
  form.set("file", file);
  // The desktop imports under the next free name when one is taken; web and
  // CLI keep the historical 409 by omitting this flag.
  return client.request<SkillDetail>("/api/skills/import?onDuplicate=rename", {
    body: form,
    method: "POST",
  });
}

/** List the Skill packages a repository contains at the commit it resolves to.
 *  `signal` lets the caller stop waiting: a clone of a large repository is the
 *  one request here long enough that a user may change their mind. */
export function inspectGitSkillRepository(
  client: ApiClient,
  body: InspectGitSkillRepositoryRequest,
  signal?: AbortSignal,
): Promise<GitSkillRepositoryInspection> {
  return client.request<GitSkillRepositoryInspection>("/api/skills/import-git/inspect", {
    body: JSON.stringify(body),
    method: "POST",
    ...(signal ? { signal } : {}),
  });
}

/** Install one inspected package. `overwrite` and `expectedRevision` are the
 *  only way to replace an installed Skill, and both are checked server-side. */
export function importSkillFromGit(
  client: ApiClient,
  body: ImportSkillFromGitRequest,
): Promise<SkillDetail> {
  return client.request<SkillDetail>("/api/skills/import-git", {
    body: JSON.stringify(body),
    method: "POST",
  });
}

/** Start a background import for an inspected selection. The request returns
 *  as soon as the job is queued; the job resource carries its progress. */
export function startGitSkillImportJob(
  client: ApiClient,
  body: StartGitSkillImportJobRequest,
): Promise<GitSkillImportJob> {
  return client.request<GitSkillImportJob>("/api/skills/import-git/jobs", {
    body: JSON.stringify(body),
    method: "POST",
  });
}

export function getGitSkillImportJob(client: ApiClient, jobId: string): Promise<GitSkillImportJob> {
  return client.request<GitSkillImportJob>(`/api/skills/import-git/jobs/${encodeURIComponent(jobId)}`);
}

export function cancelGitSkillImportJob(client: ApiClient, jobId: string): Promise<GitSkillImportJob> {
  return client.request<GitSkillImportJob>(`/api/skills/import-git/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}

export function updateSkill(
  client: ApiClient,
  skillId: string,
  body: UpdateSkillRequest,
): Promise<SkillDetail> {
  return client.request<SkillDetail>(`/api/skills/${encodeURIComponent(skillId)}`, {
    body: JSON.stringify(body),
    method: "PUT",
  });
}

export function updateSkillFile(
  client: ApiClient,
  skillId: string,
  path: string,
  body: UpdateSkillFileRequest,
): Promise<SkillDetail> {
  return client.request<SkillDetail>(`/api/skills/${encodeURIComponent(skillId)}/files/${encodeURIComponent(path)}`, {
    body: JSON.stringify(body),
    method: "PUT",
  });
}

/** The raw text of SKILL.md, for the editor that shows the whole document. */
export function getSkillMarkdown(
  client: ApiClient,
  skillId: string,
): Promise<SkillMarkdownContent> {
  return client.request<SkillMarkdownContent>(`/api/skills/${encodeURIComponent(skillId)}/skill-md`);
}

/** Replace SKILL.md with the edited text; the server validates the package. */
export function updateSkillMarkdown(
  client: ApiClient,
  skillId: string,
  body: UpdateSkillMarkdownRequest,
): Promise<SkillDetail> {
  return client.request<SkillDetail>(`/api/skills/${encodeURIComponent(skillId)}/skill-md`, {
    body: JSON.stringify(body),
    method: "PUT",
  });
}

/** Remove one resource, or every resource under a folder path. */
export function deleteSkillFile(
  client: ApiClient,
  skillId: string,
  path: string,
  body: DeleteSkillFileRequest,
): Promise<SkillDetail> {
  return client.request<SkillDetail>(`/api/skills/${encodeURIComponent(skillId)}/files/${encodeURIComponent(path)}`, {
    body: JSON.stringify(body),
    method: "DELETE",
  });
}

/** Move a file, or a folder and everything under it, to a new path. */
export function renameSkillFile(
  client: ApiClient,
  skillId: string,
  path: string,
  body: RenameSkillFileRequest,
): Promise<SkillDetail> {
  return client.request<SkillDetail>(`/api/skills/${encodeURIComponent(skillId)}/files/${encodeURIComponent(path)}/rename`, {
    body: JSON.stringify(body),
    method: "POST",
  });
}

export function readSkillResource(
  client: ApiClient,
  skillId: string,
  path: string,
): Promise<SkillResourceContent> {
  return client.request<SkillResourceContent>(`/api/skills/${encodeURIComponent(skillId)}/resources/${encodeURIComponent(path)}`);
}

/**
 * The installed package as a ZIP: one root directory named after the Skill,
 * holding its `SKILL.md` and every resource. The same shape the importer
 * accepts, so an exported package can be imported again unchanged.
 */
export async function exportSkillPackage(client: ApiClient, skillId: string): Promise<ArrayBuffer> {
  const response = await client.fetchStream(`/api/skills/${encodeURIComponent(skillId)}/package`);
  return await response.arrayBuffer();
}

/** What would break if this Skill were removed: the Project and Session
 *  selection documents that still name it. */
export function getSkillDeletionImpact(client: ApiClient, skillId: string): Promise<SkillDeletionImpact> {
  return client.request<SkillDeletionImpact>(`/api/skills/${encodeURIComponent(skillId)}/deletion-impact`);
}

/** Remove an installed package. The route refuses (`SKILL_CONFLICT`) while a
 *  runtime settings document still references it. */
export function deleteSkill(client: ApiClient, skillId: string): Promise<{ deleted: string }> {
  return client.request<{ deleted: string }>(`/api/skills/${encodeURIComponent(skillId)}`, {
    method: "DELETE",
  });
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
  body: CreateProxyServerRequest,
): Promise<ProxyServer> {
  return client.request<ProxyServer>("/api/proxy/servers", {
    body: JSON.stringify(body),
    method: "POST",
  });
}

export function updateProxyServer(
  client: ApiClient,
  serverId: string,
  body: UpdateProxyServerRequest,
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

/**
 * Import a `{ "mcpServers": { … } }` spec.
 *
 * The route writes the whole spec or nothing, and a name clash with any existing
 * server fails the write as a whole; the page therefore sends one entry per call
 * so each server's outcome is its own.
 */
export function importMcpServers(
  client: ApiClient,
  body: unknown,
): Promise<CustomMcpServerDetails[]> {
  return client.request<CustomMcpServerDetails[]>("/api/mcp/servers/import", {
    body: JSON.stringify(body),
    method: "POST",
  });
}

/** Call one tool on the server, for the read-only inspector. */
export function inspectMcpTool(
  client: ApiClient,
  id: string,
  body: McpInspectorRequest,
  signal?: AbortSignal,
): Promise<McpInspectorResult> {
  return client.request<McpInspectorResult>(
    `/api/mcp/servers/${encodeURIComponent(id)}/inspect`,
    { body: JSON.stringify(body), method: "POST", ...(signal ? { signal } : {}) },
  );
}

/** Begin OAuth: the route answers the URL the browser has to open. */
export function startMcpAuthorization(
  client: ApiClient,
  id: string,
  redirectUrl: string,
): Promise<McpAuthorizationStart> {
  return client.request<McpAuthorizationStart>(
    `/api/mcp/servers/${encodeURIComponent(id)}/oauth/start`,
    { body: JSON.stringify({ redirectUrl }), method: "POST" },
  );
}

export function cancelMcpAuthorization(client: ApiClient, id: string): Promise<{ ok: boolean }> {
  return client.request<{ ok: boolean }>(
    `/api/mcp/servers/${encodeURIComponent(id)}/oauth/cancel`,
    { method: "POST" },
  );
}

export function clearMcpAuthorization(client: ApiClient, id: string): Promise<{ ok: boolean }> {
  return client.request<{ ok: boolean }>(
    `/api/mcp/servers/${encodeURIComponent(id)}/oauth/clear`,
    { method: "POST" },
  );
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

/** Environment operations are scoped to a Runner; package source preferences remain global. */
export function runnerEnvironmentApi(client: ApiClient, runnerId: string) {
  const root = `/api/runners/${encodeURIComponent(runnerId)}`;
  return {
    setup: () => client.request<ScientificEnvironmentSetup>(`${root}/environment-setup`),
    initialize: () => client.request<ScientificEnvironmentSetup>(`${root}/environment-setup`, {
      method: "POST", body: JSON.stringify({ confirmed: true }),
    }),
    list: () => client.request<Environment[]>(`${root}/environments`),
    revisions: () => client.request<EnvironmentRevision[]>(`${root}/environment-revisions`),
    create: (body: CreateEnvironmentRequest) => client.request<Environment>(`${root}/environments`, {
      method: "POST", body: JSON.stringify(body),
    }),
    install: (id: string, body: InstallEnvironmentRequest) => client.request<EnvironmentInstallStatus>(`${root}/environments/${encodeURIComponent(id)}/install`, {
      method: "POST", body: JSON.stringify(body),
    }),
    remove: (id: string) => client.request(`${root}/environments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  };
}

export function updateProxySettings(client: ApiClient, body: UpdateProxySettingsRequest): Promise<ProxySettingsDetails> {
  return client.request("/api/proxy/settings", { method: "PUT", body: JSON.stringify(body) });
}

/** Diagnostic runs on the service host and tests only the returned target. */
export function testProxyConnectivity(client: ApiClient, proxy: ResolvedProxy): Promise<{
  ok: boolean; message: string; elapsedMs: number; target: string;
}> {
  return client.request("/api/proxy/test", { method: "POST", body: JSON.stringify(proxy) });
}
