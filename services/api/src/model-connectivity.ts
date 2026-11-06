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

import { completeChatRequest, normalizeUsage, carriedThinkingControls, rejectedThinkingControlFields, ModelRequestError, streamModelTurn, isAnthropicEndpoint, type ModelEndpoint, type ModelTurn } from "@sciencediscovery/model";
import { request, type Dispatcher } from "undici";
import { Readable } from "node:stream";
import { MODEL_API_VARIANTS, DEFAULT_MODEL_API_VARIANT, type ModelApiProtocol, type ModelCompatibilityOutcome, type ModelConnectivityTestCategory, type ModelConnectivityTestResult, type ModelProfile, type ResolvedProxy } from "@sciencediscovery/schema";

interface ModelConnectivityTestOptions {
  allowMissingToken?: boolean;
  beforeDispatch?: (profile: ModelProfile) => void;
  apiToken?: string;
  profile: ModelProfile;
  resolveProxy: () => ResolvedProxy;
  timeoutMs?: number;
  compatibility?: boolean;
}
const PROTOCOLS: ModelApiProtocol[] = ["openai-chat-completions", "openai-responses", "anthropic-messages"];
const SYSTEM = "This is a synthetic model compatibility check. Follow only these instructions.";
const HISTORY = [{ role: "user", content: "Reply with OK." }];
const TOOLS = [{ name: "compatibility_echo", description: "Echo the supplied synthetic value", parameters: { type: "object", properties: { value: { type: "string", enum: ["OK"] } }, required: ["value"], additionalProperties: false } }];
function networkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return /^(UND_ERR_|E(?:CONN|HOST|NET|AI_|PIPE|TIMEDOUT))/.test(code)
    || (error instanceof Error && error.message.startsWith("Model endpoint is unavailable:"));
}

function category(status: number): ModelConnectivityTestCategory {
  if (status === 401 || status === 403) return "authorization";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  return "provider_error";
}
function providerFailure(status: number): ModelCompatibilityOutcome {
  const kind = category(status);
  const message = kind === "authorization" ? "API key is invalid or is not authorized"
    : kind === "not_found" ? "Base URL or model ID was not found"
    : kind === "rate_limited" ? "Provider is rate limiting requests or the account has insufficient quota"
    : "The model provider rejected the request or is temporarily unavailable";
  return { category: kind, ok: false, providerStatus: status, message };
}
function failure(error: unknown, signal: AbortSignal): ModelCompatibilityOutcome {
  if (signal.aborted) return { category: "timeout", ok: false, message: "Compatibility check timed out; support is unknown" };
  if (error instanceof ModelRequestError) return providerFailure(error.statusCode);
  if (error instanceof Error && error.message === "Model response exceeds the byte limit") return { category: "invalid_response", ok: false, message: "The endpoint response exceeded the connectivity-test byte limit" };
  if (networkError(error)) return { category: "network", ok: false, message: "Could not connect to model provider; support is unknown" };
  return { category: "invalid_response", ok: false, message: "No valid capability evidence; inspect the configured endpoint and retry explicitly" };
}
const unknown = (): ModelCompatibilityOutcome => ({ category: "invalid_response", ok: false, message: "Not measured; support is unknown" });

export async function testModelConnectivity(options: ModelConnectivityTestOptions): Promise<ModelConnectivityTestResult> {
  const started = Date.now();
  const wrap = (outcome: ModelCompatibilityOutcome): ModelConnectivityTestResult => ({ ...outcome, latencyMs: Date.now() - started, testedAt: new Date().toISOString() });
  if (!options.apiToken?.trim() && !options.allowMissingToken) return wrap({ category: "missing_token", ok: false, message: "Save an API key before testing" });
  let proxy: ResolvedProxy;
  try { proxy = options.resolveProxy(); } catch { return wrap({ category: "network", ok: false, message: "Could not resolve configured model proxy" }); }
  const selected = options.profile.apiProtocol ?? (isAnthropicEndpoint(options.profile.baseUrl) ? "anthropic-messages" : "openai-chat-completions");
  const variant = options.profile.apiVariant ?? DEFAULT_MODEL_API_VARIANT[selected];
  if (!Object.hasOwn(MODEL_API_VARIANTS, selected) || !MODEL_API_VARIANTS[selected].includes(variant)) return wrap({ category: "invalid_response", ok: false, message: "The endpoint protocol or variant is not supported" });
  const timeout = Math.max(1, Math.min(10_000, options.timeoutMs ?? 10_000));
  const protocols: NonNullable<ModelConnectivityTestResult["protocols"]> = [];
  for (const apiProtocol of options.compatibility ? PROTOCOLS : [selected]) {
    const endpoint: ModelEndpoint = { ...options.profile, apiProtocol, apiVariant: apiProtocol === selected ? options.profile.apiVariant : undefined,
      apiToken: options.apiToken, proxy, thinkingMode: "disabled" };
    const dispatchProfile: ModelProfile = { ...options.profile, apiProtocol, apiVariant: endpoint.apiVariant };
    const signal = AbortSignal.timeout(timeout);
    const policy = { maxTokens: 64, maxRetries: 0, requestTimeoutMs: options.timeoutMs ?? 10_000, maxResponseBytes: 64 * 1024 };
    let basic = unknown(), streaming = unknown(), tools = unknown();
    let usage: "available" | "unknown" = "unknown";
    // Fields to remove from the next dispatch's body, and the body of the most
    // recent one. The recovery strips the serialized request instead of asking
    // for a different thinking mode, because a mode is not a promise that a
    // control disappears: the catalog resolves it first (`constrainCatalogThinking`
    // may rewrite `auto` to the model's declared default, and `kimi-k3` declares
    // `modes: ["enabled"]`), so `thinkingMode: "auto"` can rebuild the very body
    // the endpoint just refused. The streamed sender strips the named fields for
    // the same reason (`withoutThinkingControls`).
    let stripFromBody: string[] = [];
    let sentBody = "";
    const dispatch = async (target: ModelEndpoint) => {
      options.beforeDispatch?.(dispatchProfile);
      return completeChatRequest(target, { messages: [{ role: "system", content: SYSTEM }, ...HISTORY], max_tokens: apiProtocol === "openai-responses" ? 16 : 8 }, signal, async (url, init) => {
        let body = typeof init?.body === "string" ? init.body : "";
        if (body && stripFromBody.length) {
          try {
            const parsed = JSON.parse(body) as Record<string, unknown>;
            for (const field of stripFromBody) delete parsed[field];
            body = JSON.stringify(parsed);
          } catch {
            // Not JSON: nothing to strip, and the provider gets what it was
            // given so its own error stands.
          }
        }
        sentBody = body;
        const headers = new Headers(init?.headers);
        if (!options.apiToken) { headers.delete("authorization"); headers.delete("x-api-key"); }
        const incoming = await request(String(url), { method: "POST", headers: Object.fromEntries(headers), body,
          signal: init?.signal as AbortSignal, headersTimeout: timeout, bodyTimeout: 0, idempotent: false,
          ...((init as RequestInit & { dispatcher?: Dispatcher })?.dispatcher ? { dispatcher: (init as RequestInit & { dispatcher?: Dispatcher }).dispatcher } : {}) });
        return new Response([204, 205, 304].includes(incoming.statusCode) ? null : Readable.toWeb(incoming.body) as ReadableStream<Uint8Array>, { status: incoming.statusCode });
      }, 64 * 1024);
    };
    const readCompletion = async (response: Response): Promise<ModelCompatibilityOutcome> => {
      const payload = await response.json() as { usage?: unknown; choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string; tool_calls?: unknown[]; anthropic_content?: unknown[]; response_items?: unknown[] } }> };
      if (normalizeUsage(payload.usage, "openai-chat-completions")) usage = "available";
      if (payload.choices?.[0]?.finish_reason === "length") {
        // The probe asks for a reply of a handful of tokens. A reasoning
        // model spends that budget thinking and comes back with
        // `finish_reason: "length"` and no final text, which used to be
        // reported as inconclusive — so configuring one failed a check that
        // had already proved the thing it asks about. `completeChatRequest`
        // has parsed and validated the envelope by the time this runs: the
        // endpoint accepted the key, answered on the configured protocol,
        // and stopped at a limit this check wrote. That the cut is ours is
        // not evidence against the model.
        return { category: "ok", ok: true, providerStatus: response.status, message: "Valid basic completion structure; the synthetic reply was cut at the probe's output limit" };
      }
      const message = payload.choices?.[0]?.message;
      if (!message || !(message.content || message.reasoning_content || message.tool_calls?.length || message.anthropic_content?.length || message.response_items?.length)) throw new Error("No basic completion evidence");
      return { category: "ok", ok: true, providerStatus: response.status, message: "Valid basic completion structure" };
    };
    try {
      let response = await dispatch(endpoint);
      if (!response.ok && response.status === 400) {
        // A 400 that names the thinking control this request carried says
        // nothing about the endpoint: the streamed sender strips exactly the
        // named control and retries, so an endpoint whose streaming chat works
        // must not be reported as broken here. The transport keeps no fallback
        // of its own (see `completeChatRequest`), so this caller owns the retry.
        //
        // The intersection is what makes the retry honest. A 400 names what the
        // endpoint refused, not what this request sent, and a variant that
        // injects nothing here would otherwise send the identical body again and
        // report a strip that never happened.
        const detail = await response.text().catch(() => "");
        const carried = carriedThinkingControls(sentBody);
        const named = [...rejectedThinkingControlFields(detail)].filter((field) => carried.has(field));
        if (named.length) {
          stripFromBody = named;
          response = await dispatch(endpoint);
          stripFromBody = [];
          basic = response.ok
            ? { ...(await readCompletion(response)), message: "Valid basic completion structure after retrying without the thinking control this endpoint rejects" }
            : providerFailure(response.status);
        } else basic = providerFailure(response.status);
      } else if (!response.ok) basic = providerFailure(response.status);
      else basic = await readCompletion(response);
    } catch (error) {
      basic = failure(error, signal);
    }
    if (options.compatibility) {
      // Independent requests: a basic failure does not imply streaming or tool incompatibility.
      const streamSignal = AbortSignal.timeout(timeout);
      try {
        options.beforeDispatch?.(dispatchProfile);
        let deltas = "";
        const turn = await streamModelTurn(endpoint, SYSTEM, HISTORY, [], policy, streamSignal, { onTextDelta: d => { deltas += d; } });
        streaming = validTurn(turn) && deltas ? { category: "ok", ok: true, message: "Observed streaming text and a complete response" } : unknown();
        if (turn.usage) usage = "available";
      } catch (error) { streaming = failure(error, streamSignal); }
      const toolSignal = AbortSignal.timeout(timeout);
      try {
        options.beforeDispatch?.(dispatchProfile);
        const instruction = `${SYSTEM} Call compatibility_echo with value OK, then after the tool result reply OK.`;
        const first = await streamModelTurn(endpoint, instruction, HISTORY, TOOLS, policy, toolSignal);
        if (first.usage) usage = "available";
        if (validTurn(first) && first.toolCalls.length === 1 && first.toolCalls[0]!.name === TOOLS[0]!.name && first.toolCalls[0]!.args.value === "OK" && !first.toolCalls[0]!.argsParseError) {
          options.beforeDispatch?.(dispatchProfile);
          const final = await streamModelTurn(endpoint, instruction, [...HISTORY, first.assistantMessage, { role: "tool", tool_call_id: first.toolCalls[0]!.id, content: "OK" }], TOOLS, policy, toolSignal);
          tools = validTurn(final) && typeof final.assistantMessage.content === "string" && /^OK[.!]?$/i.test(final.assistantMessage.content.trim()) && !final.toolCalls.length ? { category: "ok", ok: true, message: "Tool call ID, arguments and result completed a round-trip" } : unknown();
          if (final.usage) usage = "available";
        }
      } catch (error) { tools = failure(error, toolSignal); }
    }
    protocols.push({ apiProtocol, basic, streaming, tools, usage });
  }
  const chosen = protocols.find(p => p.apiProtocol === selected)!;
  return { ...wrap(chosen.basic), ...(options.compatibility ? { protocols } : {}) };
}
function validTurn(turn: ModelTurn): boolean {
  return turn.completionObserved === true && !turn.truncated && !turn.streamDiagnostics?.unparseableSsePayloads && (Boolean(turn.assistantMessage.content) || turn.toolCalls.length > 0);
}

export class ModelConnectivityTestCoordinator {
  private readonly inFlight = new Map<string, Promise<ModelConnectivityTestResult>>();
  run(modelId: string, test: () => Promise<ModelConnectivityTestResult>): Promise<ModelConnectivityTestResult> {
    const existing = this.inFlight.get(modelId);
    if (existing) return existing;
    const pending = test().finally(() => { if (this.inFlight.get(modelId) === pending) this.inFlight.delete(modelId); });
    this.inFlight.set(modelId, pending);
    return pending;
  }
}
