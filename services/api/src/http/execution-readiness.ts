// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunnerClient, RemoteComputeClient } from "@sciencediscovery/executor";
import type { ExecutionBlockDecision } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import { decodePathParam } from "./path-params.js";

/** Called only behind the normal control-plane bearer-token check. */
export async function handleExecutionReadiness(
  request: IncomingMessage, response: ServerResponse, url: URL,
  store: SessionStore, local: RunnerClient, remote: RemoteComputeClient, read: () => Promise<unknown>,
): Promise<boolean> {
  const probe = url.pathname.match(/^\/api\/runners\/([^/]+)\/execution-capability$/);
  const decision = url.pathname.match(/^\/api\/sessions\/([^/]+)\/execution-blocks(?:\/([^/]+))?$/);
  if (!probe && !decision) return false;
  const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  if (probe && ["GET", "POST"].includes(request.method ?? "")) {
    const runnerId = decodePathParam(probe[1]!, "runnerId");
    try {
      const client = runnerId === "local" ? local : remote.runnerClient(runnerId);
      // Never substitute a local probe for an unavailable remote Runner.
      const capability = await client.executionCapability(request.method === "POST");
      send(200, { runnerId, connected: true, capability });
    } catch (error) {
      send(200, { runnerId, connected: false, reason: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (decision) {
    const sessionId = decodePathParam(decision[1]!, "sessionId");
    // Decoded here, beside the session id: a malformed decision segment is the
    // caller's input, and the branch below has its own 409 catch for a decision it
    // refuses — which must not be the answer to a bad path.
    const decisionId = decision[2] === undefined ? undefined : decodePathParam(decision[2], "decisionId");
    if (!store.getSession(sessionId)) { send(404, { error: "Session not found" }); return true; }
    if (request.method === "GET" && !decision[2]) {
      send(200, store.executionBlocks.list(sessionId)); return true;
    }
    if (request.method === "POST" && decision[2]) {
      const choice = await read() as ExecutionBlockDecision;
      if (!choice || typeof choice !== "object" || !["retry", "cancel", "switch"].includes(choice.action)) {
        send(400, { error: "Invalid execution decision" }); return true;
      }
      try {
        store.assertSessionWritable(sessionId);
        if (choice.action === "switch") store.assertSessionAllowsRunner(sessionId, choice.runnerId);
        store.executionBlocks.decide(sessionId, decisionId!, choice);
        send(200, { resolved: true });
      } catch (error) { send(409, { error: String(error) }); }
      return true;
    }
  }
  send(405, { error: "Method not allowed" });
  return true;
}
