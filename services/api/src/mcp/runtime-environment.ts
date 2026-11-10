// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/sdk/client/stdio.js";

export const MCP_PROXY_ENV_VARS = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
] as const;
export function canonicalMcpEnvironmentName(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? name.toLowerCase() : name;
}
/** Name-only launcher facts; this never reads an inherited environment value. */
export function mcpEnvironmentRemovalEffect(name: string): "proxy_policy" | "launcher_default" | "not_inherited" {
  const canonical = canonicalMcpEnvironmentName(name);
  if (MCP_PROXY_ENV_VARS.some(key => canonicalMcpEnvironmentName(key) === canonical)) { return "proxy_policy"; }
  return DEFAULT_INHERITED_ENV_VARS.some(key => canonicalMcpEnvironmentName(key) === canonical) ? "launcher_default" : "not_inherited";
}
