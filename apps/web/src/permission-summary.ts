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

import {
  formatPermissionDescription,
  normalizePermissionDescription,
  type PermissionDescriptionRenderers,
  type PermissionRequest,
} from "@sciencediscovery/schema";

import type { Locale, MessageKey } from "./i18n/index.js";

/**
 * This surface's name for each permission action. Both approval surfaces read
 * it from here: the permission panel (Permissions.tsx) and the timeline card
 * that a running Session actually shows, so the two cannot label an action
 * differently.
 */
export const ACTION_LABELS: Record<PermissionRequest["action"], MessageKey> = {
  sandbox_network: "permissions.sandboxNetwork",
  artifact_download: "permissions.download",
  code: "permissions.code",
  direct_code: "permissions.directExecution",
  connector: "permissions.connector",
  directory: "permissions.directory",
  host: "permissions.host",
  remote_job: "permissions.remoteJob",
};

/** The localized action name for a request whose action this build knows. */
export function permissionActionLabel(
  action: PermissionRequest["action"],
  translate: (key: MessageKey) => string,
): string | undefined {
  return Object.hasOwn(ACTION_LABELS, action) ? translate(ACTION_LABELS[action]) : undefined;
}

/** The workspace an approval covers: the Session workspace, or a subagent's. */
function scope(subagentId: string | undefined, zh: boolean): string {
  if (zh) return subagentId ? `子代理 ${subagentId}` : "会话工作区";
  return subagentId ? `in subagent ${subagentId}` : "in the Session workspace";
}

function where(remoteHostAlias: string | undefined, subagentId: string | undefined, zh: boolean): string {
  if (zh) {
    const workspace = scope(subagentId, true);
    return remoteHostAlias ? `在 ${remoteHostAlias} 上的${workspace}中` : `在${workspace}中`;
  }
  return `${remoteHostAlias ? `on ${remoteHostAlias} ` : ""}${scope(subagentId, false)}`;
}

/**
 * The approval sentence in one language, composed from the request's structured
 * description (#1305). Wording lives on the client because the API has no
 * Session locale: a persisted request must follow the language the reader is
 * using now, not the one it was created in.
 */
function renderers(zh: boolean): PermissionDescriptionRenderers {
  return {
    shell: ({ remoteHostAlias, subagentId }) => zh
      ? `${where(remoteHostAlias, subagentId, true)}运行 Shell 脚本`
      : `Run a shell script ${where(remoteHostAlias, subagentId, false)}`,
    python: ({ remoteHostAlias, subagentId }) => zh
      ? `${where(remoteHostAlias, subagentId, true)}运行 Python 代码`
      : `Run Python code ${where(remoteHostAlias, subagentId, false)}`,
    language: ({ language, remoteHostAlias, subagentId }) => zh
      ? `${where(remoteHostAlias, subagentId, true)}运行 ${language} 代码`
      : `Run ${language} code ${where(remoteHostAlias, subagentId, false)}`,
    "file-copy": ({ fileCount }) => zh
      ? `在已授权的工作区之间复制 ${fileCount} 个选中的文件`
      : `Copy ${fileCount} selected files between authorized Workspaces`,
    npu: ({ operation, subject, subagentId }) => {
      if (zh) return `在${scope(subagentId, true)}中${operation === "run" ? "运行" : "取消"}主机 NPU 任务 ${subject}`;
      return operation === "run"
        ? `Run host NPU workload ${subject} ${scope(subagentId, false)}`
        : `Cancel host NPU job ${subject} ${scope(subagentId, false)}`;
    },
    "direct-host": ({ account, command, cwd, runnerId, subagentId, target, workspaceRoot }) => zh
      ? `直接在主机上执行：Runner ${runnerId}，目标 ${target}，账号 ${account}，工作区 ${workspaceRoot}，目录 ${cwd || "."}`
        + `${subagentId ? `，子代理 ${subagentId}` : ""}。不会隔离文件系统、进程或网络，主机凭据可能可被访问；`
        + `沙箱网络模式与域名白名单对它不生效，沙箱里刚被拒绝的主机仍可能经此通道访问；`
        + `主机上的影响无法全部追踪或回滚。同类授权只覆盖本次 Agent 运行中的这条命令和这个范围，没有固定有效期。`
        + `批准不会执行命令。命令：\n${command}`
      : `DIRECT HOST EXECUTION: Runner ${runnerId}, ${target}, account ${account}, workspace ${workspaceRoot}, cwd ${cwd || "."}`
        + `${subagentId ? `, subagent ${subagentId}` : ""}. No sandbox filesystem, process or network isolation; host credentials may be accessible.`
        + ` The sandbox network mode and domain allowlist do not apply here, so a host just denied in the sandbox may still be reached through this channel.`
        + ` Host effects cannot all be tracked or rolled back. Matching consent covers only this exact command and scope during this Agent run, with no fixed TTL.`
        + ` Approval does not execute. Command:\n${command}`,
    "specialist-runtime": ({ runtime, workspaceRoot }) => zh
      ? `在 API 主机上直接运行 ${runtime}（${workspaceRoot}）。这会移除本任务的外层沙箱；平台工具仍各自需要授权。`
      : `Run ${runtime} directly on the API host in ${workspaceRoot}. This removes the outer sandbox for this task; platform tools retain their own permissions.`,
    network: ({ hosts, purpose, runnerId }) => zh
      ? `本次 Agent 运行请求 ${runnerId} 上的沙箱网络访问：${hosts.join("、")}。用途：${purpose}。`
        + `批准只会把这些主机临时加入使用该授权的那一次执行的允许域名，不改动设置里的白名单；在本次 Agent 运行内继续允许相同主机时，相同请求不再询问。`
        + `拒绝只拒绝沙箱内的这条通道：设置里的白名单不变，主机直执行也不受沙箱网络策略约束。`
      : `Sandbox network on ${runnerId} for this Agent run: ${hosts.join(", ")}. Purpose: ${purpose}.`
        + ` Approval adds these hosts to the allowed domains of the single execution that uses that authorization, without editing the configured allowlist; allowing the same hosts again later in this Agent run stops the card from reappearing.`
        + ` Deny blocks only this sandbox channel: the configured allowlist is unchanged, and direct host execution is not subject to the sandbox network policy.`,
    environment: ({ environmentId, language, manager, name, operation, runnerId }) => {
      const runner = runnerId ? (zh ? `（Runner ${runnerId}）` : ` on Runner ${runnerId}`) : "";
      switch (operation) {
        case "create": return zh
          ? `创建命名 ${language ?? ""} 环境 ${name ?? environmentId ?? ""}${runner}`
          : `Create named ${language ?? ""} environment ${name ?? environmentId ?? ""}${runner}`;
        case "delete": return zh
          ? `删除命名环境 ${environmentId ?? ""}${runner}`
          : `Delete named environment ${environmentId ?? ""}${runner}`;
        case "install": return zh
          ? `在命名环境 ${environmentId ?? ""} 中安装 ${manager ?? ""} 软件包${runner}`
          : `Install ${manager ?? ""} packages in named environment ${environmentId ?? ""}${runner}`;
        case "setup": return zh
          ? `在所选 Runner 上初始化科研环境${runner}`
          : `Set up scientific environments on the selected Runner${runner}`;
        case "uninstall": return zh
          ? `从命名环境 ${environmentId ?? ""} 中卸载软件包${runner}`
          : `Uninstall packages from named environment ${environmentId ?? ""}${runner}`;
      }
    },
    "workspace-sync": ({ direction, paths, runnerId }) => zh
      ? `${direction === "pull" ? `从 Runner ${runnerId} 拉取` : `推送至 Runner ${runnerId}`}：${paths.join("、")}`
      : `${direction} Runner ${runnerId}: ${paths.join(", ")}`,
    "skill-publish": ({ proposalCount, subagentId }) => {
      if (zh) return subagentId
        ? `从子代理 ${subagentId} 发布 ${proposalCount} 个技能库提案`
        : `在本会话中发布 ${proposalCount} 个技能库提案`;
      return subagentId
        ? `Publish ${proposalCount} Skill Library proposal(s) from subagent ${subagentId}`
        : `Publish ${proposalCount} Skill Library proposal(s) in this Session`;
    },
    "mcp-tool": ({ recovered, sourceId, toolId }) => zh
      ? `调用${recovered ? "修复后的 " : " "}MCP 工具 ${sourceId}/${toolId}`
      : `Call ${recovered ? "repaired " : ""}MCP tool ${sourceId}/${toolId}`,
    "artifact-download": ({ name, path }) => zh
      ? `下载 ${name} 到工作区路径 ${path}`
      : `Download ${name} to workspace path ${path}`,
    "remote-job": ({ command, hostAlias, mode }) => zh
      ? `在 ${hostAlias} 上运行 ${mode.toUpperCase()} 任务：${command}`
      : `Run ${mode.toUpperCase()} job on ${hostAlias}: ${command}`,
    web: ({ hostname, operation, query }) => {
      if (zh) return operation === "fetch" ? `获取 ${hostname ?? ""} 的公开网页内容` : `检索公开网络：“${query ?? ""}”`;
      return operation === "fetch"
        ? `Fetch public web content from ${hostname ?? ""}`
        : `Search the public web for “${query ?? ""}”`;
    },
    "tool-call": ({ detail, toolName }) => {
      const call = zh
        ? `在本会话中运行${toolName ? `工具 ${toolName}` : "工具调用"}`
        : `Run ${toolName ? `tool ${toolName}` : "a tool call"} in this Session`;
      // The arguments being approved (a shell command, a JSON object) are shown
      // verbatim after the sentence: the resource alone cannot name them.
      return detail ? `${call}\n${detail}` : call;
    },
  };
}

/**
 * The sentence a permission card shows.
 *
 * `actionLabel` is this surface's localized name for the action; it covers a
 * request recorded before descriptions existed, so an English `summary` never
 * appears in an otherwise Chinese card. The canonical `summary` is still the
 * last resort for an action this build does not know.
 */
export function formatPermissionRequest(
  request: Pick<PermissionRequest, "action" | "description" | "summary">,
  locale: Locale,
  actionLabel: string | undefined,
): string {
  const description = normalizePermissionDescription(request.description);
  if (description) return formatPermissionDescription(description, renderers(locale === "zh-CN"));
  if (actionLabel) return locale === "zh-CN" ? `请求：${actionLabel}` : `Request: ${actionLabel}`;
  return request.summary;
}
