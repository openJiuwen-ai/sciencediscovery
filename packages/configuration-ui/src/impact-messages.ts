// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

export type ConfigurationImpactField = "resourceLocation" | "effectiveScope" | "message";

/** Translate exact registered proxy copy only. Unknown warnings remain unchanged. */
const proxyResourceImpact: Readonly<Record<ConfigurationImpactField, readonly [string, string]>> = {
  resourceLocation: ["Shared proxy registry", "共享代理注册表"],
  effectiveScope: ["Every session using this proxy", "所有使用此代理的会话"],
  message: [
    "Manual confirmation required. Creating a proxy does not select a route. Editing a used proxy affects later connections, possibly within an active run. Existing connections are not rebound. URL syntax is checked without connecting; reachability and proxy authentication remain unverified.",
    "需要手动确认。新建代理不会选用该路由。编辑正在使用的代理会影响后续连接，可能包括当前运行中的任务。已有连接不会重新绑定。仅检查 URL 格式，不会发起连接；尚未验证可达性和代理认证。",
  ],
};

export function configurationImpactText(locale: string, capabilityId: string, field: ConfigurationImpactField, value: string): string {
  if (!locale.startsWith("zh") || capabilityId !== "proxy.resources") return value;
  const [source, translated] = proxyResourceImpact[field];
  return value === source ? translated : value;
}
