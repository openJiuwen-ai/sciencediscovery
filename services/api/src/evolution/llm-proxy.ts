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

/**
 * The search's model calls, proxied so the sidecar never holds a provider key.
 *
 * The sidecar runs model-written code. Handing it a provider key would mean a
 * candidate that escapes its sandbox — or a bug in the sidecar itself — could
 * spend the user's account. Instead it is handed a **run-scoped token** that
 * this proxy issues when the search starts and revokes when it ends:
 *
 * * it authenticates exactly one endpoint, the completions one, and nothing
 *   else in the API;
 * * it dies with the run, so a leaked token has the lifetime of the search
 *   rather than of the account;
 * * every call through it is attributed to that run, which is what makes the
 *   spend visible in model-usage instead of appearing from nowhere.
 *
 * The provider key is read here, per request, and never leaves this process.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";

import type { ModelInvocationUsage } from "@sciencediscovery/schema";

import { readJson } from "../http/body.js";
import { sendError, sendJson } from "../http/response.js";
import { apiLog } from "../logging.js";
import type { SessionStore } from "../store.js";

/** What a run token is allowed to do, and for whom. */
interface RunGrant {
  modelId: string;
  runId: string;
  sessionId: string;
  token: string;
}

/**
 * Run-scoped tokens, in memory only.
 *
 * Not persisted on purpose: a token that outlives the process would outlive the
 * run it belongs to, and the whole point is that it does not. A control-plane
 * restart therefore invalidates every outstanding token, which is the same
 * thing that happens to the runs themselves.
 */
export class RunTokenRegistry {
  /**
   * Grants per run, not one grant per run.
   *
   * A search can need two models: the one that rewrites the candidate and, for
   * a judged scorecard, the one that grades it. They must stay separate — the
   * proxy pins the model to the token precisely so a caller cannot pick what it
   * is billed for — so each gets its own token, and both die with the run.
   */
  private readonly grants = new Map<string, RunGrant[]>();

  issue(runId: string, sessionId: string, modelId: string): string {
    const token = randomBytes(32).toString("base64url");
    const existing = this.grants.get(runId) ?? [];
    existing.push({ modelId, runId, sessionId, token });
    this.grants.set(runId, existing);
    return token;
  }

  revoke(runId: string): void {
    // Every token for the run, so a judge token cannot outlive the search it
    // was issued for any more than a mutation token can.
    this.grants.delete(runId);
  }

  /** Constant-time compare: the token is a bearer secret, and a timing oracle
   *  on it is a real (if slow) way to guess one. Every grant for the run is
   *  compared, so which model a token buys is decided by the token, not by
   *  anything the caller says. */
  resolve(runId: string, presented: string | undefined): RunGrant | undefined {
    if (!presented) return undefined;
    const actual = Buffer.from(presented);
    for (const grant of this.grants.get(runId) ?? []) {
      const expected = Buffer.from(grant.token);
      if (expected.length !== actual.length) continue;
      if (timingSafeEqual(expected, actual)) return grant;
    }
    return undefined;
  }

  /** Runs with at least one live token. */
  get size(): number {
    return this.grants.size;
  }
}

export interface EvolveCompletionDeps {
  fetchImpl?: typeof fetch;
  onUsage?: (usage: ModelInvocationUsage) => void;
  store: SessionStore;
  tokens: RunTokenRegistry;
}

interface CompletionBody {
  max_tokens?: number;
  messages?: Array<{ content: string; role: string }>;
  temperature?: number;
  /** Passed through. Unlike `model` this is the caller's to decide: it changes
   *  how the chosen model answers, not which model is billed. */
  thinking?: { type: string };
  /** Ignored: the model is the one the run was created with, not the one the
   *  caller asks for. A sidecar that could name any model could bill the user
   *  for a model they never chose. */
  model?: string;
}

/**
 * `POST /internal/evolve-llm/:runId/v1/chat/completions`.
 *
 * OpenAI-shaped because that is what the vendored port's completion adapter
 * speaks; the provider on the other side may be anything the user configured.
 */
/**
 * Dispatcher for the one call this module makes.
 *
 * `bodyTimeout: 0` because the response arrives in one piece once it starts;
 * `headersTimeout` is the real budget, and it is the *thinking* time of a model
 * asked to rewrite a program. Fifteen minutes rather than undici's five: at five
 * the call was aborted mid-thought and the search recorded a candidate that
 * "would not run".
 *
 * It is paired with undici's own `fetch` below, and the pairing is the point.
 * Node's global `fetch` is backed by the copy of undici built into the runtime,
 * which does not recognise a dispatcher constructed from the package in
 * `node_modules` — the call fails immediately with a bare "fetch failed", which
 * reads exactly like an unreachable provider. Both sides come from the same
 * copy here, as they do everywhere else in this product that talks to a model.
 */
const LONG_CALL_DISPATCHER = new UndiciAgent({ bodyTimeout: 0, headersTimeout: 15 * 60_000 });

/** Calls this process currently has open to a provider, by start time. Only for
 *  the log line: how many were already in flight is what tells a serialised
 *  proxy apart from a slow provider. */
const inFlight = new Set<number>();

export async function handleEvolveCompletion(
  request: IncomingMessage,
  response: ServerResponse,
  runId: string,
  deps: EvolveCompletionDeps,
): Promise<void> {
  const presented = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const grant = deps.tokens.resolve(runId, presented || undefined);
  if (!grant) {
    // Deliberately the same answer for "no such run", "wrong token" and "the
    // run already finished": each of those is a caller who should not be here,
    // and telling them apart is free reconnaissance.
    apiLog.warn("evolve_llm_denied", { runId });
    return sendError(response, 401, "Unauthorized");
  }

  const model = deps.store.getModel(grant.modelId);
  const apiToken = model ? deps.store.getModelApiToken(model.id) : undefined;
  if (!model || !apiToken) {
    return sendError(response, 503, "The model this run was created with has no API token");
  }

  const body = await readJson<CompletionBody>(request);
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return sendError(response, 400, "messages is required");
  }

  const startedAt = new Date().toISOString();
  const call = deps.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
  let upstream: Response;
  // Timed, and logged at both ends, because a search that produces nothing
  // looks identical from outside whether the provider is slow, the proxy is
  // queueing, or the reply came back empty — and those need opposite fixes.
  // Without this the only instrument was a stack sampler on the sidecar.
  const began = Date.now();
  apiLog.info("evolve_llm_call_started", {
    ceiling: body.max_tokens, inFlight: inFlight.size, runId,
    thinking: body.thinking?.type ?? "default",
  });
  inFlight.add(began);
  try {
    // `${baseUrl}/chat/completions`, not `/v1/chat/completions`: a profile's
    // base URL already carries the provider's version segment, which is the
    // convention every other caller in this product follows (session-naming,
    // papers, native-agent/model-client). Appending another one produced
    // `.../api/coding/v3/v1/chat/completions` and a 404 that the proxy
    // faithfully forwarded — so every expansion became an empty reply, and the
    // search read as a model that could not write code.
    upstream = await call(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      body: JSON.stringify({
        max_tokens: body.max_tokens,
        messages: body.messages,
        model: model.model,
        temperature: body.temperature,
        // Forwarded, not invented: the sidecar decides whether this workload
        // wants a reasoning model's thinking, and for a whole-program rewrite
        // upstream's answer is that it does not — with it on, the model spends
        // the entire output budget thinking and returns nothing.
        ...(body.thinking === undefined ? {} : { thinking: body.thinking }),
      }),
      // A reasoning model rewriting a program thinks for minutes before the
      // first byte, and undici's 300-second default aborted the call — which
      // arrived at the sidecar as "the provider could not be reached" and
      // became a failed candidate. Same shape the agent's model client uses:
      // no body timeout, an explicit ceiling on the wait for headers.
      dispatcher: LONG_CALL_DISPATCHER,
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      method: "POST",
    } as RequestInit);
  } catch (error) {
    inFlight.delete(began);
    apiLog.warn("evolve_llm_unreachable", {
      elapsedMs: Date.now() - began,
      reason: error instanceof Error ? error.message : String(error), runId,
    });
    return sendError(response, 502, "The model provider could not be reached");
  }
  inFlight.delete(began);

  const payload = await upstream.json().catch(() => ({})) as Record<string, unknown>;
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
  const spend = (payload.usage ?? {}) as Record<string, unknown>;
  apiLog.info("evolve_llm_call_finished", {
    // Named "count", not "tokens": the operational logger redacts any field
    // whose name looks like a credential, and it redacted these — which left
    // the log unable to answer the one question it was added for. These are
    // counts of output, not secrets.
    completionCount: Number(spend.completion_tokens ?? -1),
    contentChars: typeof content === "string" ? content.length : -1,
    elapsedMs: Date.now() - began,
    // The pair that separates "the model thought and said nothing" from "the
    // provider returned nothing at all": the first reports a completion count
    // with no content, the second reports neither. Only one is worth paying
    // for again, and they are indistinguishable from the sidecar.
    promptCount: Number(spend.prompt_tokens ?? -1),
    runId,
    status: upstream.status,
  });
  if (!upstream.ok) {
    // The provider's own message is forwarded because the sidecar surfaces it
    // as the reason an expansion failed, and "something went wrong" would make
    // a bad key indistinguishable from a bad prompt.
    return sendJson(response, upstream.status, payload);
  }

  // The call already happened and was already paid for. A bookkeeping failure
  // — an unknown session, a full disk — must not turn it into a failed
  // expansion: that would spend the user's money and then throw the answer
  // away, and the search would read as a model that returns nothing. Logged
  // loudly, because unrecorded spend is a real problem; just not this
  // request's problem.
  try {
    const usage = await recordUsage(deps, grant, model, payload, startedAt);
    deps.onUsage?.(usage);
  } catch (error) {
    apiLog.warn("evolve_llm_usage_unrecorded", {
      reason: error instanceof Error ? error.message : String(error),
      runId,
      sessionId: grant.sessionId,
    });
  }
  sendJson(response, 200, payload);
}

async function recordUsage(
  deps: EvolveCompletionDeps,
  grant: RunGrant,
  model: { id: string; model: string; name: string },
  payload: Record<string, unknown>,
  startedAt: string,
): Promise<ModelInvocationUsage> {
  const reported = payload.usage as
    | { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number }
    | undefined;
  const record: ModelInvocationUsage = {
    attemptIndex: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    finishedAt: new Date().toISOString(),
    id: randomBytes(16).toString("hex"),
    inputTokens: reported?.prompt_tokens ?? null,
    invocationId: `evolve:${grant.runId}`,
    // Its own kind: a search's spend is not a chat turn, and the usage page has
    // to be able to say "this month went on evolution" rather than burying it.
    invocationKind: "evolve",
    model: model.model,
    modelProfileId: model.id,
    modelProfileName: model.name,
    outputTokens: reported?.completion_tokens ?? null,
    runId: grant.runId,
    sessionId: grant.sessionId,
    startedAt,
    totalTokens: reported?.total_tokens ?? null,
    // A provider that reports nothing is recorded as such rather than as zero:
    // "we do not know" and "it was free" are different facts.
    usageStatus: reported?.total_tokens === undefined ? "provider-not-reported" : "reported",
  };
  await deps.store.appendModelInvocationUsage(record);
  return record;
}
