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
  if (plugins?.mcp?.enabled === false) return [];
  return sourceIds.filter(sourceId => plugins?.[`connector.${sourceId}`]?.enabled !== false);
}
