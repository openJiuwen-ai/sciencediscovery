// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

interface ConnectorName { id: string; name: string }

/** Only an unambiguous, standalone request is handled without a model run. */
export function explicitConnectorEnableTarget(
  content: string,
  connectors: readonly ConnectorName[],
): ConnectorName | undefined {
  if (content.length > 200) return undefined;
  const text = content.normalize("NFKC").trim();
  const chinese = text.match(/^(?:(?:请帮我|能否帮我|可以帮我|麻烦你|帮我|请)\s*)?(?:在(?:当前|这个)会话(?:里|中)?\s*)?(?:启用|开启|打开)\s*(.+?)\s*[。！!]?$/u);
  const english = text.match(/^(?:please\s+)?(?:enable|activate|turn\s+on)\s+(.+?)\s*[.!]?$/iu);
  const rawTarget = chinese?.[1]?.replace(/\s*(?:工具|连接器|数据源)$/u, "")
    ?? english?.[1]?.replace(/\s+(?:connector|tool|data source)$/iu, "");
  if (!rawTarget) return undefined;
  const key = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
  const target = key(rawTarget);
  const matches = connectors.filter((item) => key(item.id) === target || key(item.name) === target);
  return matches.length === 1 ? matches[0] : undefined;
}
