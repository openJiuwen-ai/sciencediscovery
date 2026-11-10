// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { request as newRequestContext, type APIRequestContext } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "../e2e-auth.js";

/**
 * Stub models the Stop/queue/buffering specs need from the stack.
 *
 * Both are plain OpenAI-compatible endpoints registered through `/api/models`,
 * so a Session that selects one never reaches a real provider:
 *
 * - `hang-model` accepts the streaming request and then answers nothing. The
 *   run stays at the model boundary, which is exactly the "stuck" state the
 *   Stop button exists for.
 * - `slow-model` streams one reasoning fragment and a fixed series of content
 *   fragments, then holds the connection silently. The silence is the point:
 *   a fragment the client dropped cannot be replayed later, so a buffered
 *   background timeline is distinguishable from one that was never cleared.
 */

export const HANG_MODEL_NAME = "Issue44 Hanging Model";
export const HANG_MODEL_ID = "hang-model";
export const SLOW_MODEL_NAME = "Issue44 Slow Model";
export const SLOW_MODEL_ID = "slow-model";

/** The last content fragment the slow stub emits before going silent. */
export const SLOW_LAST_CONTENT_STEP = 6;
/** `Partial finding <step>.` — the visible progress the slow stub streams. */
export const slowFragment = (step: number): string => `Partial finding ${step}.`;

/** Time after the first fragment before the rest arrive, so they land while
 *  the user is working in another Session. */
const SLOW_REMAINING_DELAY_MS = 4_000;
const SLOW_FRAGMENT_INTERVAL_MS = 180;
const STUB_API_TOKEN = "e2e-stub-model-token";

export interface StubModels {
  hangModelId: string;
  slowModelId: string;
  dispose: () => Promise<void>;
}

interface StubEndpoint {
  close: () => Promise<void>;
  origin: string;
}

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ endpoint: StubEndpoint; server: Server }> {
  const server: Server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const close = async () => {
        server.closeAllConnections?.();
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      };
      resolve({ endpoint: { close, origin }, server });
    });
  });
}

function isChatCompletion(request: IncomingMessage): boolean {
  return request.method === "POST" && (request.url ?? "").endsWith("/chat/completions");
}

function readRequest(request: IncomingMessage, onBody: () => void): void {
  request.on("data", () => undefined);
  request.on("end", onBody);
}

/** Accepts the request, then never writes a completion or ends the response. */
async function startHangingEndpoint(): Promise<StubEndpoint> {
  const pending = new Set<ServerResponse>();
  const { endpoint, server } = await listen((request, response) => {
    readRequest(request, () => {
      if (!isChatCompletion(request)) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "stub route not found" }));
        return;
      }
      pending.add(response);
      response.on("close", () => pending.delete(response));
      response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
      response.write(": hanging\n\n");
    });
  });
  return {
    close: async () => {
      for (const response of pending) response.end();
      pending.clear();
      await endpoint.close();
      server.unref();
    },
    origin: endpoint.origin,
  };
}

/** Streams fixed reasoning/content fragments, then stays silent but open. */
async function startSlowEndpoint(): Promise<StubEndpoint> {
  const timers = new Set<NodeJS.Timeout>();
  const open = new Set<ServerResponse>();
  const { endpoint, server } = await listen((request, response) => {
    readRequest(request, () => {
      if (!isChatCompletion(request)) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "stub route not found" }));
        return;
      }
      open.add(response);
      response.on("close", () => open.delete(response));
      response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
      const send = (delta: Record<string, unknown>) => {
        if (response.writableEnded || response.destroyed) return;
        response.write(`data: ${JSON.stringify({
          choices: [{ delta, finish_reason: null, index: 0 }],
          created: 1,
          id: "chatcmpl-issue44-slow",
          model: SLOW_MODEL_ID,
          object: "chat.completion.chunk",
        })}\n\n`);
      };
      send({ reasoning_content: "Considering the data step by step.", role: "assistant" });
      for (let step = 1; step <= SLOW_LAST_CONTENT_STEP; step += 1) {
        const delay = step === 1 ? 0 : SLOW_REMAINING_DELAY_MS + (step - 2) * SLOW_FRAGMENT_INTERVAL_MS;
        const timer = setTimeout(() => {
          timers.delete(timer);
          send({ content: slowFragment(step) });
        }, delay);
        timers.add(timer);
      }
    });
  });
  return {
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const response of open) response.end();
      open.clear();
      await endpoint.close();
      server.unref();
    },
    origin: endpoint.origin,
  };
}

/** A stack can outlive a failed run, and a profile that Sessions still
 *  reference cannot be deleted. Reuse such a profile by pointing it at this
 *  run's endpoint instead of leaving a duplicate behind. */
async function ensureStubModel(
  request: APIRequestContext,
  name: string,
  model: string,
  origin: string,
): Promise<string> {
  const listing = await request.get(`${apiBaseUrl()}/api/models`, { headers: authorizationHeader() });
  if (!listing.ok()) throw new Error(`Listing models failed: ${listing.status()}`);
  const existing = (await listing.json() as Array<{ id: string; model: string }>)
    .filter((candidate) => candidate.model === model);
  const data = { apiToken: STUB_API_TOKEN, baseUrl: `${origin}/v1`, model, name };
  const headers = { ...authorizationHeader(), "content-type": "application/json" };
  const [stale, ...extra] = existing;

  let id: string;
  if (stale) {
    const update = await request.put(`${apiBaseUrl()}/api/models/${encodeURIComponent(stale.id)}`, { data, headers });
    if (!update.ok()) throw new Error(`Pointing stale ${model} at the stub failed: ${update.status()} ${await update.text()}`);
    id = stale.id;
  } else {
    const created = await request.post(`${apiBaseUrl()}/api/models`, { data, headers });
    if (!created.ok()) throw new Error(`Registering ${model} failed: ${created.status()} ${await created.text()}`);
    id = (await created.json() as { id: string }).id;
  }
  for (const profile of extra) {
    // A duplicate is best-effort: if Sessions still reference it, it stays.
    await request.delete(`${apiBaseUrl()}/api/models/${encodeURIComponent(profile.id)}`, { headers: authorizationHeader() })
      .catch(() => undefined);
  }
  return id;
}

/** A profile added while no global task model was set becomes that default,
 *  and a default pointing at a closed loopback port would outlive the run. */
async function clearDefaultModel(api: APIRequestContext, modelId: string): Promise<void> {
  const response = await api.post(`${apiBaseUrl()}/api/settings/clear-model-if-current`, {
    data: { modelId },
    headers: { ...authorizationHeader(), "content-type": "application/json" },
  });
  if (!response.ok()) throw new Error(`Clearing the default model failed: ${response.status()} ${await response.text()}`);
}

/** Sessions hold the model id, so the profile cannot be deleted while they
 *  exist. The specs stop their runs before this runs; cancel again in case a
 *  failed test left one behind. */
async function releaseModelReferences(api: APIRequestContext, modelIds: ReadonlySet<string>): Promise<void> {
  const headers = authorizationHeader();
  const listing = await api.get(`${apiBaseUrl()}/api/projects`, { headers });
  if (!listing.ok()) throw new Error(`Listing projects failed: ${listing.status()}`);
  const projects = await listing.json() as Array<{ id: string }>;
  for (const project of projects) {
    const response = await api.get(`${apiBaseUrl()}/api/projects/${encodeURIComponent(project.id)}/sessions?state=all`, { headers });
    if (!response.ok()) throw new Error(`Listing sessions of ${project.id} failed: ${response.status()}`);
    const sessions = await response.json() as Array<{
      id: string;
      modelId?: string | null;
      reviewModelId?: string | null;
      settingsOverrides?: { modelId?: string | null; reviewModelId?: string | null } | null;
    }>;
    for (const session of sessions) {
      const references = [session.modelId, session.reviewModelId,
        session.settingsOverrides?.modelId, session.settingsOverrides?.reviewModelId]
        .some((candidate) => candidate && modelIds.has(candidate));
      if (!references) continue;
      // Cancellation is asynchronous and a queued run may start while the
      // current one winds down, so the delete is retried with a fresh cancel
      // until the Session reports no active run instead of failing the hook.
      let lastFailure = "";
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await api.post(`${apiBaseUrl()}/api/sessions/${encodeURIComponent(session.id)}/run/cancel`, {
          data: {},
          headers: { ...headers, "content-type": "application/json" },
        }).catch(() => undefined);
        const deletion = await api.delete(`${apiBaseUrl()}/api/sessions/${encodeURIComponent(session.id)}`, {
          data: { confirmationId: session.id },
          headers: { ...headers, "content-type": "application/json" },
        });
        if (deletion.ok()) { lastFailure = ""; break; }
        lastFailure = `${deletion.status()} ${await deletion.text()}`;
        if (deletion.status() !== 409) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (lastFailure) throw new Error(`Deleting session ${session.id} failed: ${lastFailure}`);
    }
  }
}

async function deleteModel(api: APIRequestContext, modelId: string): Promise<void> {
  const response = await api.delete(`${apiBaseUrl()}/api/models/${encodeURIComponent(modelId)}`, {
    headers: authorizationHeader(),
  });
  if (!response.ok()) throw new Error(`Deleting model ${modelId} failed: ${response.status()} ${await response.text()}`);
}

async function cleanupModels(api: APIRequestContext, ids: string[]): Promise<string[]> {
  const failures: string[] = [];
  if (!ids.length) return failures;
  for (const id of ids) {
    await clearDefaultModel(api, id).catch((error: unknown) => failures.push(String(error)));
  }
  await releaseModelReferences(api, new Set(ids)).catch((error: unknown) => failures.push(String(error)));
  for (const id of ids) {
    await deleteModel(api, id).catch((error: unknown) => failures.push(String(error)));
  }
  return failures;
}

export async function installStubModels(): Promise<StubModels> {
  const hang = await startHangingEndpoint();
  const slow = await startSlowEndpoint();
  // Playwright disposes the `request` fixture a `beforeAll` receives when that
  // hook ends, so the helper owns a context that outlives it instead.
  const api = await newRequestContext.newContext();

  let hangModelId: string;
  let slowModelId: string;
  const registeredIds: string[] = [];
  try {
    hangModelId = await ensureStubModel(api, HANG_MODEL_NAME, HANG_MODEL_ID, hang.origin);
    registeredIds.push(hangModelId);
    slowModelId = await ensureStubModel(api, SLOW_MODEL_NAME, SLOW_MODEL_ID, slow.origin);
    registeredIds.push(slowModelId);
  } catch (error) {
    // Registration can fail after the first profile became the global
    // default. Roll back completed registrations before closing their ports,
    // using the same cleanup as a successful run. Preserve the setup error
    // even if the API is unavailable during this best-effort rollback.
    try {
      await cleanupModels(api, registeredIds);
    } finally {
      await Promise.allSettled([api.dispose(), hang.close(), slow.close()]);
    }
    throw error;
  }

  return {
    dispose: async () => {
      let failures: string[];
      try {
        failures = await cleanupModels(api, registeredIds);
      } finally {
        await api.dispose();
        await hang.close();
        await slow.close();
      }
      if (failures.length) throw new Error(`Stub model cleanup failed: ${failures.join("; ")}`);
    },
    hangModelId,
    slowModelId,
  };
}
