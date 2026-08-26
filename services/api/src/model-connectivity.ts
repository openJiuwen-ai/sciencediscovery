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

import { request } from "undici";

import { isAnthropicEndpoint, proxyDispatcher } from "@sciencediscovery/model";
import type {
  ModelConnectivityTestCategory,
  ModelConnectivityTestResult,
  ModelProfile,
  ResolvedProxy,
} from "@sciencediscovery/schema";

const CONNECTIVITY_TIMEOUT_MS = 10_000;
const CONNECTIVITY_MAX_TOKENS = 8;
const MAX_RESPONSE_BYTES = 64 * 1024;

interface ModelConnectivityTestOptions {
  apiToken?: string;
  profile: ModelProfile;
  resolveProxy: () => ResolvedProxy;
  timeoutMs?: number;
}

interface ConnectivityRequest {
  body: string;
  headers: Record<string, string>;
  url: string;
  validate: (payload: unknown) => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function result(
  category: ModelConnectivityTestCategory,
  startedAt: number,
  message: string,
  providerStatus?: number,
): ModelConnectivityTestResult {
  return {
    category,
    latencyMs: elapsedSince(startedAt),
    message,
    ok: category === "ok",
    ...(providerStatus === undefined ? {} : { providerStatus }),
    testedAt: new Date().toISOString(),
  };
}

function classifyProviderStatus(status: number, startedAt: number): ModelConnectivityTestResult {
  if (status === 401 || status === 403) {
    return result("authorization", startedAt, "API key is invalid or is not authorized", status);
  }
  if (status === 404) {
    return result("not_found", startedAt, "Base URL or model ID was not found", status);
  }
  if (status === 429) {
    return result("rate_limited", startedAt, "Provider is rate limiting requests or the account has insufficient quota", status);
  }
  return result("provider_error", startedAt, "The model provider rejected the request or is temporarily unavailable", status);
}

function validOpenAiCompletion(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) return false;
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return false;
  const { content, reasoning_content: reasoningContent, tool_calls: toolCalls } = choice.message;
  return content === null
    || typeof content === "string"
    || typeof reasoningContent === "string"
    || Array.isArray(toolCalls);
}

function validAnthropicMessage(payload: unknown): boolean {
  return isRecord(payload)
    && payload.type === "message"
    && Array.isArray(payload.content);
}

function connectivityRequest(profile: ModelProfile, apiToken: string): ConnectivityRequest {
  const baseUrl = profile.baseUrl.replace(/\/+$/, "");
  if (isAnthropicEndpoint(profile.baseUrl)) {
    return {
      body: JSON.stringify({
        max_tokens: CONNECTIVITY_MAX_TOKENS,
        messages: [{ role: "user", content: "Reply with OK." }],
        model: profile.model,
        stream: false,
        system: "This is a model connectivity test.",
      }),
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": apiToken,
      },
      url: `${baseUrl}/v1/messages`,
      validate: validAnthropicMessage,
    };
  }
  return {
    body: JSON.stringify({
      max_tokens: CONNECTIVITY_MAX_TOKENS,
      messages: [
        { role: "system", content: "This is a model connectivity test." },
        { role: "user", content: "Reply with OK." },
      ],
      model: profile.model,
      stream: false,
    }),
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    url: `${baseUrl}/chat/completions`,
    validate: validOpenAiCompletion,
  };
}

async function readBoundedResponse(
  body: AsyncIterable<Uint8Array> & { dump(): Promise<void> },
): Promise<string | undefined> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of body) {
    text += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      await body.dump().catch(() => undefined);
      return undefined;
    }
  }
  return text + decoder.decode();
}

export async function testModelConnectivity(
  options: ModelConnectivityTestOptions,
): Promise<ModelConnectivityTestResult> {
  const startedAt = Date.now();
  const apiToken = options.apiToken?.trim();
  if (!apiToken) {
    return result("missing_token", startedAt, "Save an API key before testing");
  }

  let proxy: ResolvedProxy;
  try {
    proxy = options.resolveProxy();
  } catch {
    return result("network", startedAt, "Could not resolve the configured model proxy");
  }

  const probe = connectivityRequest(options.profile, apiToken);
  const controller = new AbortController();
  const dispatcher = proxyDispatcher(proxy);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? CONNECTIVITY_TIMEOUT_MS);

  try {
    const response = await request(probe.url, {
      body: probe.body,
      bodyTimeout: 0,
      headers: probe.headers,
      headersTimeout: options.timeoutMs ?? CONNECTIVITY_TIMEOUT_MS,
      method: "POST",
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      await response.body.dump().catch(() => undefined);
      return classifyProviderStatus(response.statusCode, startedAt);
    }
    const raw = await readBoundedResponse(response.body);
    if (raw === undefined) {
      return result("invalid_response", startedAt, "The endpoint response exceeded the connectivity-test limit", response.statusCode);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      return result("invalid_response", startedAt, "The endpoint did not return valid JSON", response.statusCode);
    }
    if (!probe.validate(payload)) {
      return result("invalid_response", startedAt, "The endpoint response is not a supported model completion", response.statusCode);
    }
    return result("ok", startedAt, "Connection succeeded", response.statusCode);
  } catch {
    if (timedOut) {
      return result("timeout", startedAt, "Connection to the model provider timed out");
    }
    return result("network", startedAt, "Could not connect to the model provider; check network and proxy settings");
  } finally {
    clearTimeout(timeout);
    await dispatcher?.close().catch(() => undefined);
  }
}

export class ModelConnectivityTestCoordinator {
  private readonly inFlight = new Map<string, Promise<ModelConnectivityTestResult>>();

  run(modelId: string, test: () => Promise<ModelConnectivityTestResult>): Promise<ModelConnectivityTestResult> {
    const existing = this.inFlight.get(modelId);
    if (existing) return existing;
    const pending = test().finally(() => {
      if (this.inFlight.get(modelId) === pending) this.inFlight.delete(modelId);
    });
    this.inFlight.set(modelId, pending);
    return pending;
  }
}
