// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ChatMessage, ConfigurationRequestView } from "@sciencediscovery/schema";

/** Once a resolved v2 request has a persisted timeline notice, render its
 * disclosure there exactly once instead of adding a second legacy receipt. */
export function genericConfigurationPresentation(
  requests: readonly ConfigurationRequestView[],
  messages: readonly ChatMessage[],
  notices: ReadonlyMap<string, { requestId: string }>,
  sessionId: string | undefined,
) {
  const current = requests.filter((request) => request.sessionId === sessionId);
  const byId = new Map(current.map((request) => [request.id, request]));
  const byNoticeId = new Map<string, ConfigurationRequestView>();
  const suppressedNoticeIds = new Set<string>();
  const placed = new Set<string>();
  for (const message of messages) {
    if (message.kind !== "configuration_notice") continue;
    const request = byId.get(message.configurationRequestId ?? notices.get(message.id)?.requestId ?? "");
    if (!request || !["applied", "dismissed", "cancelled", "expired"].includes(request.state)) continue;
    if (placed.has(request.id)) { suppressedNoticeIds.add(message.id); continue; }
    byNoticeId.set(message.id, request);
    placed.add(request.id);
  }
  return { byNoticeId, suppressedNoticeIds, visibleRequests: current.filter((request) => !placed.has(request.id)) };
}

/** List responses may have been captured before a locally created proposal. */
export function mergeConfigurationRequests(current: readonly ConfigurationRequestView[], incoming: readonly ConfigurationRequestView[]) {
  const merged = new Map(current.map(item => [item.id, item]));
  for (const snapshot of incoming) {
    const previous = merged.get(snapshot.id);
    if (!previous || previous.revision < snapshot.revision || (previous.revision === snapshot.revision && previous.stateVersion <= snapshot.stateVersion)) merged.set(snapshot.id, snapshot);
  }
  return [...merged.values()];
}


/** A run's terminal event can arrive before its durable configuration receipt.
 * Keep reading a started continuation until the receipt itself settles. */
export function shouldPollConfigurationRequest(request: ConfigurationRequestView): boolean {
  return Boolean((request.runId && !["applied", "dismissed", "cancelled", "expired"].includes(request.state))
    || (request.state === "awaiting_confirmation" && request.autoApplyAt)
    || ["validating", "applying"].includes(request.state)
    || request.activation.state === "pending"
    || ["pending", "queued", "started"].includes(request.resumption.state));
}
