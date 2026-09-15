// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { IncomingMessage, ServerResponse } from "node:http";
import { BridgeError, type BridgeEnvelope } from "@sciencediscovery/plugin-sdk";
import type { PluginControl } from "./control.js";

/** Called only after the API's bearer authentication. Path owns the scope. */
export async function handlePluginRequest(request: IncomingMessage, response: ServerResponse, url: URL,
  control: PluginControl, readJson: () => Promise<unknown>): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/plugins(?:\/(bridge|events|candidates)(?:\/([^/]+)\/([^/]+))?)?$/);
  if (!match) return false;
  const send = (status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
  const scope = { projectId: decodeURIComponent(match[1]!), ...(url.searchParams.get("sessionId") ? { sessionId: url.searchParams.get("sessionId")! } : {}) };
  const abort = new AbortController();
  response.once("close", () => abort.abort());
  try {
    control.assertScope(scope);
    if (!match[2] && request.method === "GET") { send(200, control.describe(scope)); return true; }
    if (match[2] === "bridge" && request.method === "POST") {
      send(200, { apiVersion: 1, result: await control.bridge(scope).invoke(await readJson() as BridgeEnvelope, abort.signal) });
      return true;
    }
    if (match[2] === "events" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      let ended = false;
      const notify = () => {
        if (ended) return;
        try { response.write(`event: changed\ndata: ${JSON.stringify({ scope, revision: control.snapshot(scope).revision })}\n\n`); }
        catch { response.end(); }
      };
      const unsubscribe = control.subscribe(scope, notify);
      const heartbeat = setInterval(() => {
        try { control.assertScope(scope); response.write(": heartbeat\n\n"); } catch { response.end(); }
      }, 15_000);
      const close = () => { if (ended) return; ended = true; clearInterval(heartbeat); unsubscribe(); };
      response.once("close", close); response.once("finish", close);
      notify(); return true;
    }
    if (match[2] === "candidates" && !scope.sessionId) {
      if (request.method === "GET" && !match[3]) { send(200, control.list(scope.projectId)); return true; }
      if (request.method === "POST") {
        const body = await readJson() as Record<string, unknown>;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new BridgeError("invalid", "Expected object");
        send(200, match[3] ? await control.command(scope.projectId, match[3], match[4]!, body)
          : await control.create(scope.projectId, body.expectedRevision, body.patch));
        return true;
      }
    }
    send(405, { code: "method", error: "Unsupported plugin operation" });
  } catch (error) {
    if (response.headersSent) response.end();
    else send(error instanceof BridgeError ? ({ invalid: 400, forbidden: 403, unavailable: 404, conflict: 409 } as const)[error.code] : 400,
      { code: error instanceof BridgeError ? error.code : "invalid", error: error instanceof Error ? error.message : "Plugin operation failed" });
  }
  return true;
}
