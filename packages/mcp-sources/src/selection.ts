// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/** The MCP host and a source's connector.<id> plugin must both allow selection.
 * Custom sources without a plugin override retain their existing selection.
 * Call with frozen settings for Runs; direct broker requests use current settings.
 */
export function filterEnabledMcpSources(
  sourceIds: readonly string[],
  plugins?: Readonly<Record<string, { enabled?: boolean }>>,
): string[] {
  // "web" (web_search / web_fetch) is a built-in tool, not an MCP source, so
  // the MCP master switch must not clear it. A connector.web plugin override
  // still disables it through the per-source filter below.
  if (plugins?.mcp?.enabled === false) return sourceIds.filter((id) => id === "web");
  return sourceIds.filter(sourceId => plugins?.[`connector.${sourceId}`]?.enabled !== false);
}
