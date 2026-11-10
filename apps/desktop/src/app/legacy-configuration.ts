// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ChatMessage, ConnectorConfigurationRequest } from "@sciencediscovery/schema";
import type { RunReplay } from "../run-stream/replay.js";

/** Older persisted connector notices predate configurationRequestId. Their
 * checkpoint uses a stable notice ID; continued runs retain their message ID. */
export function legacyConfigurationPresentation(requests: readonly ConnectorConfigurationRequest[],
  messages: readonly ChatMessage[], replays: readonly RunReplay[], sessionId: string | undefined) {
  const current = requests.filter(request => request.sessionId === sessionId);
  const byNoticeId = new Map<string, ConnectorConfigurationRequest>();
  const suppressedNoticeIds = new Set<string>();
  const placed = new Set<string>();
  for (const message of messages) {
    if (message.kind !== "configuration_notice") continue;
    const request = current.find(item => item.id === message.configurationRequestId
      || message.id === `configuration:${item.id}`
      || (item.continuationRunId && replays.some(replay => replay.runId === item.continuationRunId && replay.userMessageId === message.id)));
    if (!request || request.state === "awaiting_confirmation") continue;
    if (placed.has(request.id)) { suppressedNoticeIds.add(message.id); continue; }
    byNoticeId.set(message.id, request);
    placed.add(request.id);
  }
  return { byNoticeId, suppressedNoticeIds, visibleRequests: current.filter(request => !placed.has(request.id)) };
}
