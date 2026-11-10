// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ChatMessage, ConnectorConfigurationRequest, SessionRun } from "@sciencediscovery/schema";

/** Completed traces carry result details, not necessarily the original args. */
export function isConfigurationProposalTrace(trace: { name: string; details?: unknown }): boolean {
  if (["propose_connector_enable", "propose_configuration"].includes(trace.name)) return true;
  return trace.name === "configuration" && trace.details !== null && typeof trace.details === "object"
    && "configurationAction" in trace.details && trace.details.configurationAction === "propose";
}

export { genericConfigurationPresentation, mergeConfigurationRequests, shouldPollConfigurationRequest } from "@sciencediscovery/configuration-ui";

/** Keep a resolved request visible only until its in-conversation receipt exists. */
export function connectorConfigurationPresentation(
  requests: readonly ConnectorConfigurationRequest[],
  runs: readonly SessionRun[],
  messages: readonly ChatMessage[],
  sessionId: string | undefined,
) {
  const continuationByNoticeId = new Map([
    ...runs.filter((run) => run.userMessageId && run.configurationContinuation)
      .map((run) => [run.userMessageId!, run.configurationContinuation!] as const),
    ...runs.filter((run) => run.configurationNoticeMessageId && run.configurationResume)
      .map((run) => [run.configurationNoticeMessageId!, {
        requestId: run.configurationResume!.requestId,
        sourceRunId: run.id,
        connectorName: run.configurationResume!.connectorName,
      }] as const),
  ]);
  const acknowledgedRequestIds = new Set(messages
    .filter((message) => message.kind === "configuration_notice")
    .map((message) => continuationByNoticeId.get(message.id)?.requestId)
    .filter((requestId): requestId is string => Boolean(requestId)));
  const visibleRequests = requests.filter((request) => request.sessionId === sessionId
    && (request.state === "awaiting_confirmation"
      || ((request.state === "stale" || request.state === "applied")
        && !runs.some((run) => run.createdAt > request.updatedAt)
        && !acknowledgedRequestIds.has(request.id))));
  return { continuationByNoticeId, visibleRequests };
}
