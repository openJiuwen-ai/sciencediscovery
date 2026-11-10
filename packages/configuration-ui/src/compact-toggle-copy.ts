// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationRequestView } from "@sciencediscovery/schema";

// Registered v1 copy only. A new/unknown warning must pass the normal length
// gate; never silently summarize a future risk. Server payloads stay unchanged.
const memoryImpact = "Local backend only; manual confirmation required. Enabling permits subsequent research-memory operations to use the existing local graph. Disabling stops subsequent gated operations; in-flight requests may finish and stored graph data is retained. This does not disable every Agent's independent memory, change backend or credentials, install a service or verify readiness. If the MemoryGraph service is unavailable, start it separately and restart the API if required by the deployment; saving does not start or restart services.";
const mcpImpact = "This shared service switch requires its own manual confirmation. It does not select the connector for a Session or grant tool, network or command permissions. Review the server's saved connection/execution settings before enabling it. Saving starts no discovery, connection, STDIO process or OAuth flow. Later ordinary discovery/use may contact its stored endpoint or launch its stored STDIO program. An untested service is not verified ready. Disabling rejects subsequent calls; it does not immediately cancel already sent work, but a later catalog refresh may close its old connection and interrupt that work. Re-enabling never replays an old task/tool. Run records stay unchanged; a bound original configuration wait may continue normally.";
export function configurationCompactToggleCopy(request: ConfigurationRequestView, locale: string, editedEnabled?: unknown): { scope: string; description: string } | undefined {
  const field = request.fields.find(item => item.id === "enabled");
  if (request.schemaVersion !== 1 || request.adapterVersion !== 1 || request.scope.kind !== "global"
    || field?.kind !== "boolean" || typeof field.value !== "boolean") return undefined;
  const enabled = typeof editedEnabled === "boolean" ? editedEnabled : field.value;
  const zh = locale.startsWith("zh"), capability: string = request.capabilityId;
  if (capability === "memory.enable" && request.impact.message === memoryImpact
    && request.impact.resourceLocation === "Deployment MemoryGraph settings"
    && request.impact.effectiveScope === "Every session using the workbench memory graph") return {
    scope: zh ? "工作台本地图谱 · 所有会话" : "Local workbench graph · All sessions",
    description: enabled
      ? zh ? "仅使用本地图谱，不启动或测试服务，不改变 Agent 独立记忆。" : "Uses the existing local graph. Does not start or test services, or change Agent memory."
      : zh ? "停用后续图谱操作；进行中的请求可完成，数据和 Agent 独立记忆保留。" : "Stops later graph operations; in-flight requests may finish. Data and Agent memory remain.",
  };
  if (capability === "mcp.availability" && request.impact.message === mcpImpact
    && request.impact.resourceLocation === "Encrypted custom MCP configuration"
    && /^Shared MCP availability across all Sessions · (http|sse|stdio)$/.test(request.impact.effectiveScope)) return {
    scope: zh ? "MCP 全局开关 · 会话选择不变" : "Global MCP switch · Session choice unchanged",
    description: enabled
      ? zh ? "先核对已存连接/命令。保存不连接、启动或验证；后续使用可联网或执行命令，权限独立。" : "Check saved settings. No connection, launch or test on save; later use may connect or run commands. Permissions apply."
      : zh ? "停用阻止后续调用；已发任务可继续，但后续刷新可能关闭连接并中断任务。" : "Stops future calls. Sent work may continue; a later refresh may close its connection and interrupt it.",
  };
  return undefined;
}
