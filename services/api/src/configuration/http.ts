// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigurationCredentialInput, ConfigurationDecisionInput, ConfigurationPreviewInput, ConfigurationRequestView } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import { readJson } from "../http/body.js";
import { sendJson } from "../http/response.js";
import type { ConversationalConfigurationFramework } from "./framework.js";
import type { ConfigurationProposalInput } from "./types.js";
import { ConfigurationError, object } from "./validation.js";

/** Called after the API's existing bearer/CORS checks. No alternate credential authority. */
export async function handleConfigurationHttp(input: {
  request: IncomingMessage; response: ServerResponse; url: URL; store: SessionStore;
  framework: ConversationalConfigurationFramework;
  hasActiveRun(sessionId: string, ownRequestId?: string): Promise<boolean>;
}): Promise<boolean> {
  const { request, response, url, store, framework } = input;
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(configuration-requests(?:\/([^/]+)(?:\/(credentials|preview|decision|continue|reversal|endpoint-consent))?)?|configuration\/capabilities)$/);
  if (!match) return false;
  const sessionId = match[1]!;
  const requestId = match[3];
  const operation = match[4];
  const project = (view: ConfigurationRequestView): ConfigurationRequestView => {
    const projected = { ...view }; delete projected.liveWait;
    return { ...projected, ...(framework.options.jiuwenLiveWait && view.runId
      ? { liveWait: framework.liveWaitRunId(sessionId, view.id) === view.runId } : {}) };
  };
  try {
    if (!store.getSession(sessionId)) throw new ConfigurationError("CONFIGURATION_REQUEST_NOT_FOUND", "Session not found", 404);
    // Only an existing, same-session legacy request may use the old decision payload.
    if (operation === "decision" && requestId && !framework.repository.get(requestId, sessionId)) {
      if (store.getConnectorConfigurationRequest(sessionId, requestId)) return false;
      throw new ConfigurationError("CONFIGURATION_REQUEST_NOT_FOUND", "Configuration request not found", 404);
    }
    if (request.method === "GET" && match[2] === "configuration/capabilities") {
      sendJson(response, 200, { items: framework.service.registry.list(), executor: framework.options.nativeExecutor ? "native" : "jiuwenswarm",
        sameRunCapabilities: framework.options.nativeExecutor || framework.options.jiuwenLiveWait ? ["connector.enable"] : [],
        interaction: framework.options.jiuwenLiveWait ? "live_tool_wait" : "checkpoint",
        unavailableReasons: framework.options.nativeExecutor || framework.options.jiuwenLiveWait ? [] : ["No live configuration wait adapter is installed."] });
      return true;
    }
    if (request.method === "GET" && !requestId) {
      const generic = framework.service.list(sessionId).map(project);
      const genericIds = new Set(generic.map(item => item.id));
      const ready = async (proposal: { runId?: string; id: string; state: string }) => {
        if (!proposal.runId || proposal.runId.startsWith("user-request:") || !["collecting_input", "awaiting_confirmation", "needs_fix"].includes(proposal.state)) return true;
        if (framework.liveWaitRunId(sessionId, proposal.id) === proposal.runId) return true;
        const source = await store.getSessionRun(sessionId, proposal.runId);
        if (!genericIds.has(proposal.id) && source && ["completed", "interrupted"].includes(source.status)) return true;
        return source?.status === "blocked" && source.configurationWait && source.configurationCheckpoint?.requestId === proposal.id;
      };
      const legacy = store.listConnectorConfigurationRequests(sessionId).filter(item => !genericIds.has(item.id));
      const visible = await Promise.all([...generic, ...legacy].map(async item => await ready(item) ? item : undefined));
      sendJson(response, 200, { items: visible.filter(Boolean) });
      return true;
    }
    if (request.method === "GET" && requestId && !operation) {
      const view = project(framework.service.get(sessionId, requestId));
      if (view.runId && ["collecting_input", "awaiting_confirmation", "needs_fix"].includes(view.state)) {
        const run = await store.getSessionRun(sessionId, view.runId);
        if (framework.liveWaitRunId(sessionId, view.id) !== view.runId && (!run?.configurationWait || run.configurationCheckpoint?.requestId !== view.id))
          throw new ConfigurationError("CONFIGURATION_WAIT_NOT_READY", "The task has not committed its configuration checkpoint", 409);
      }
      sendJson(response, 200, view);
      return true;
    }
    if (request.method !== "POST") throw new ConfigurationError("INVALID_CONFIGURATION_INPUT", "Unsupported configuration operation", 405);
    store.assertSessionWritable(sessionId);
    const key = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined;
    if (!requestId) {
      if (await input.hasActiveRun(sessionId)) throw new ConfigurationError("CONFIGURATION_RUN_ACTIVE", "Wait for the current task before changing its model or settings", 409);
      const body = object(await readJson(request), ["capabilityId", "values", "scope", "reason", "protocolVersion"], "proposal");
      object(body.values, Object.keys((body.values as object) ?? {}), "values");
      sendJson(response, 201, project(await framework.propose(sessionId, body as unknown as ConfigurationProposalInput, key)));
      return true;
    }
    const record = framework.service.getRecord(sessionId, requestId);
    const body: unknown = await readJson(request);
    if (operation === "endpoint-consent") {
      sendJson(response, 200, project(await framework.confirmEndpoint(sessionId, requestId, body)));
    } else if (operation === "credentials") {
      response.setHeader("cache-control", "no-store");
      sendJson(response, 200, await framework.provideCredential(sessionId, requestId, body as ConfigurationCredentialInput, key));
    } else if (operation === "preview") {
      sendJson(response, 200, project(await framework.preview(sessionId, requestId, body as ConfigurationPreviewInput, key)));
    } else if (operation === "decision") {
      if (await input.hasActiveRun(sessionId, requestId)) throw new ConfigurationError("CONFIGURATION_WAIT_NOT_READY", "The current task must reach its configuration checkpoint before this decision", 409);
      if (record.view.runId) {
        const run = await store.getSessionRun(sessionId, record.view.runId);
        const alreadyResuming = ["applied", "dismissed"].includes(record.view.state);
        if (!alreadyResuming && framework.liveWaitRunId(sessionId, requestId) !== record.view.runId && (!run?.configurationWait || run.configurationCheckpoint?.requestId !== requestId))
          throw new ConfigurationError("CONFIGURATION_WAIT_NOT_READY", "The original task is not ready for configuration", 409);
      }
      sendJson(response, 200, project(await framework.decide(sessionId, requestId, body as ConfigurationDecisionInput, key)));
    } else if (operation === "continue") {
      object(body, [], "continuation");
      sendJson(response, 200, project(await framework.settle(sessionId, requestId)));
    } else if (operation === "reversal") {
      object(body, [], "reversal");
      if (await input.hasActiveRun(sessionId)) throw new ConfigurationError("CONFIGURATION_RUN_ACTIVE", "Wait for the current task before reversing configuration", 409);
      sendJson(response, 201, await framework.service.reversal(sessionId, requestId, key));
    } else throw new ConfigurationError("INVALID_CONFIGURATION_INPUT", "Unsupported configuration operation", 400);
    return true;
  } catch (error) {
    const known = error instanceof ConfigurationError;
    const domainCode = error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message) ? error.message : undefined;
    const archived = error instanceof Error && error.message === "Session is archived and read-only";
    const code = known ? error.code : archived ? "SESSION_NOT_WRITABLE" : domainCode ?? "INVALID_CONFIGURATION_INPUT";
    const status = known ? error.status : archived ? 409 : code.includes("EXPIRED") ? 410 : code === "IDEMPOTENCY_MISMATCH" ? 409 : 400;
    // Never reflect raw provider responses, credential bodies or arbitrary input into the timeline.
    sendJson(response, status, { error: known ? error.message : "Configuration input could not be processed. Refresh the card and check the highlighted fields.", code,
      ...(known && error.field ? { field: error.field } : {}) });
    return true;
  }
}
