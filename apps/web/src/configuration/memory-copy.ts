// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ConfigurationRequestView } from "@sciencediscovery/schema";

const memoryImpact = "Local backend only; manual confirmation required. Enabling permits subsequent research-memory operations to use the existing local graph. Disabling stops subsequent gated operations; in-flight requests may finish and stored graph data is retained. This does not disable every Agent's independent memory, change backend or credentials, install a service or verify readiness. If the MemoryGraph service is unavailable, start it separately and restart the API if required by the deployment; saving does not start or restart services.";
const memoryImpactZh = "仅支持本地后端，必须手动确认。启用后，后续研究记忆操作可使用现有本地图谱。停用后将阻止后续受此开关控制的操作；正在进行的请求可能完成，已存储的图谱数据会保留。这不会关闭各个 Agent 的独立记忆，也不会更改后端或凭据、安装服务或验证服务就绪状态。如果 MemoryGraph 服务不可用，需要另行启动，并按部署要求重启 API；保存配置不会启动或重启服务。";

/** Display-only copy for the known memory adapter. Never normalize the server
 * text: new warnings, custom reasons and future contracts must remain verbatim. */
export function memoryConfigurationCopy(request: ConfigurationRequestView, locale: string) {
  const original = { reason: request.reason.message, ...request.impact };
  if ((locale !== "zh-CN" && locale !== "zh") || request.capabilityId !== "memory.enable"
    || request.adapterVersion !== 1 || request.schemaVersion !== 1 || request.scope.kind !== "global"
    || (request.protocolVersion !== undefined && request.protocolVersion !== 3)) return original;
  return {
    reason: request.reason.code === "CONFIGURATION_REQUIRED" && original.reason === "A configuration change is required"
      ? "需要更改配置" : original.reason,
    resourceLocation: original.resourceLocation === "Deployment MemoryGraph settings"
      ? "部署级 MemoryGraph 设置" : original.resourceLocation,
    effectiveScope: original.effectiveScope === "Every session using the workbench memory graph"
      ? "所有使用工作台记忆图谱的会话" : original.effectiveScope,
    message: original.message === memoryImpact ? memoryImpactZh : original.message,
  };
}
