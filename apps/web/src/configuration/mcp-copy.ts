// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationRequestView } from "@sciencediscovery/schema";

type CopySlot = "reason" | "resourceLocation" | "effectiveScope" | "message" | "credentialDescription";
type McpCapability = "mcp.delete" | "mcp.header_credential";
const staticCopy: Readonly<Record<McpCapability, Partial<Record<CopySlot, readonly [string, string]>>>> = {
  "mcp.delete": {
    "resourceLocation": [
      "Encrypted custom MCP configuration and local OAuth/reference stores",
      "加密的自定义 MCP 配置及本地 OAuth/引用存储"
    ],
    "effectiveScope": [
      "Every Global, Project, Session and Specialist reference to this custom server",
      "全局、项目、会话及专家中对此自定义服务的全部引用"
    ],
    "message": [
      "Independent manual confirmation required. Delete this custom server, its local OAuth state and saved selection references. Other servers remain. The deletion journal recovers interrupted local cleanup without replaying tools. This action has no automatic undo and does not revoke remote credentials. Saving performs no discovery, MCP/network request or process start/stop. Existing connections or already running work may continue until later ordinary catalog/reconnect cleanup; future calls cannot use this removed server. A bound original configuration wait may continue normally; no old tool/task is replayed.",
      "需要独立手动确认。将删除此自定义服务、其本地 OAuth 状态和已保存的选用引用，其他服务保持不变。删除日志可恢复中断的本地清理，但不会重放工具。本操作无法自动撤销，也不会撤销远端凭据。保存不会进行发现、MCP/网络请求，或启动/停止进程。现有连接或已经运行的任务，可能在之后正常的目录刷新/重连清理前继续；后续调用不能再使用已删除的服务。绑定的原配置等待可正常继续；不会重放任何旧工具或任务。"
    ]
  },
  "mcp.header_credential": {
    "resourceLocation": [
      "Encrypted custom MCP configuration",
      "加密的自定义 MCP 配置"
    ],
    "effectiveScope": [
      "This shared server's saved credential header",
      "此共享服务已保存的凭据请求头"
    ]
  }
};
const headerPrefix = "Independent manual confirmation and separate recipient approval are required. Recipient: ";
const headerSuffix = ". The saved path/query may contain secrets and is hidden but bound to this approval; review it in the formal editor first. Replace all case aliases with one header. Other headers, OAuth, URL, transport, enabled state, timeout, proxy and Session/tool/network permissions remain. Saving performs no probe, RPC, network request or process operation. Old discovery is invalidated; later ordinary connection/testing uses the replacement and may interrupt old work. Existing connections may retain the old value until reconnect. This is not remote credential revocation or verified authentication. A bound original configuration wait may continue normally; no old tool/task is replayed.";
const credentialDescription = "Printable ASCII only, no outer spaces, controls or leading $ environment reference. Use removal to delete a header.";
function known(locale: string, request: ConfigurationRequestView): request is ConfigurationRequestView & { capabilityId: McpCapability } {
  return locale.startsWith("zh") && request.schemaVersion === 1 && request.adapterVersion === 1
    && request.scope.kind === "global" && Object.hasOwn(staticCopy, request.capabilityId);
}

/** Exact display copies only. Never rewrite a request, recipient, consent or preview input. */
export function mcpConfigurationText(locale: string, request: ConfigurationRequestView, slot: CopySlot, value: string): string {
  if (!known(locale, request)) return value;
  if (slot === "reason") return request.reason.code === "CONFIGURATION_REQUIRED" && value === "A configuration change is required" ? "需要变更配置" : value;
  const pair = staticCopy[request.capabilityId][slot];
  if (pair && value === pair[0]) return pair[1];
  if (request.capabilityId !== "mcp.header_credential") return value;
  if (slot === "credentialDescription" && value === credentialDescription)
    return "仅允许可打印 ASCII，不允许首尾空格、控制字符或以 $ 开头的环境变量引用。删除请求头请使用移除操作。";
  if (slot !== "message" || !value.startsWith(headerPrefix) || !value.endsWith(headerSuffix)) return value;
  const recipient = value.slice(headerPrefix.length, value.length - headerSuffix.length);
  // Preserve the server-supplied origin verbatim. Do not parse/normalize an authorization target.
  const origin = /^https?:\/\/(?:\[[A-Za-z0-9:.%_-]+\]|[A-Za-z0-9.-]+)(?::[0-9]+)?$/u;
  if (recipient !== "select a saved server/header" && !origin.test(recipient)) return value;
  return "需要独立手动确认，并另行批准凭据接收方。接收方：" + (recipient === "select a saved server/header" ? "请选择已保存的服务/请求头" : recipient) + "。已保存路径/查询参数可能含有秘密，已隐藏但绑定于本次批准；请先在正式编辑器中核对。将同一请求头名称的所有大小写别名合并替换为一个请求头。其他请求头、OAuth、URL、传输方式、启用状态、超时、代理以及会话/工具/网络权限均保持不变。保存不会发起探测、RPC、网络请求或进程操作。旧发现结果将失效；之后的正常连接/测试会使用替换值，并可能中断旧任务。现有连接可能在重连前继续保留旧值。这不是远端凭据撤销，也不代表认证已验证。绑定的原配置等待可正常继续；不会重放任何旧工具或任务。";
}

export function mcpConfigurationChoiceLabel(locale: string, request: ConfigurationRequestView, fieldId: string, choiceId: string, label: string): string {
  if (!known(locale, request) || request.capabilityId !== "mcp.header_credential" || fieldId !== "headerName") return label;
  const field = request.fields.find(item => item.id === fieldId);
  if (field?.kind !== "enum" || !field.choices?.some(choice => choice.id === choiceId && choice.label === label)) return label;
  const prefix = `${choiceId} · `, suffix = " stored name(s)";
  if (!label.startsWith(prefix) || !label.endsWith(suffix)) return label;
  const count = label.slice(prefix.length, label.length - suffix.length);
  return /^[1-9][0-9]*$/u.test(count) ? `${choiceId} · ${count} 个已保存名称` : label;
}

export function mcpConfigurationChangeText(locale: string, request: ConfigurationRequestView, field: string, side: "before" | "after", value: string | undefined): string | undefined {
  if (value === undefined || !known(locale, request)) return value;
  if (request.capabilityId === "mcp.delete") return field === "serverId" && side === "after"
    && value === "Deleted, including local OAuth state and saved references; no automatic undo"
    ? "删除该服务、本地 OAuth 状态及已保存引用；无法自动撤销" : value;
  if (field !== "headerName") return value;
  if (side === "after") return value === "Replace via secure input; authentication unverified" ? "通过安全输入替换；认证尚未验证" : value;
  const header = request.fields.find(item => item.id === "headerName");
  if (header?.kind !== "enum" || typeof header.value !== "string") return value;
  const selected = header.choices?.find(choice => choice.id === header.value);
  if (!selected || value !== `${selected.label}; values hidden`) return value;
  const label = mcpConfigurationChoiceLabel(locale, request, "headerName", selected.id, selected.label);
  return label === selected.label ? value : `${label}；值已隐藏`;
}
