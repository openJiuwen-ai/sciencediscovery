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
 * Shared outbound transport for the Node-native web providers.
 *
 * Every provider call goes through `providerRequest` so proxy selection,
 * timeouts, response bounding, and error classification stay identical across
 * vendors — the properties the audit record and the broker's retry decision
 * depend on. The classification vocabulary is the one `WebInvocationAttempt`
 * already stores, so provider failures keep their existing meaning.
 */

import { request } from "undici";

import type { ResolvedProxy } from "@sciencediscovery/schema";

import { proxyDispatcher } from "../../proxy/index.js";

/** Matches the response ceiling the gateway enforced before this path moved. */
export const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;

export type ProviderErrorCode =
  | "rate-limited"
  | "semantic-error"
  | "server-error"
  | "timeout"
  | "transport-error"
  | "unauthorized";

export interface ProviderResponse {
  body: string;
  statusCode: number;
}

export class ProviderRequestError extends Error {
  constructor(message: string, readonly code: ProviderErrorCode) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

/** Map an HTTP status onto the shared attempt vocabulary. */
export function statusErrorCode(statusCode: number): ProviderErrorCode {
  if (statusCode === 401 || statusCode === 403) return "unauthorized";
  if (statusCode === 429) return "rate-limited";
  if (statusCode >= 500) return "server-error";
  return "semantic-error";
}

/** Map a thrown transport/abort error onto the shared attempt vocabulary. */
export function thrownErrorCode(error: unknown): ProviderErrorCode {
  if (error instanceof ProviderRequestError) return error.code;
  const name = error instanceof Error ? error.name : "";
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (name === "TimeoutError" || name === "HeadersTimeoutError" || name === "BodyTimeoutError") return "timeout";
  if (message.includes("timed out") || message.includes("timeout")) return "timeout";
  if (name === "AbortError" || message.includes("aborted")) return "timeout";
  return "transport-error";
}

/** Read a response body, refusing anything past the shared 1 MB ceiling. */
async function readBounded(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new ProviderRequestError(
        "Web provider response exceeded the 1 MB limit.",
        "semantic-error",
      );
    }
    chunks.push(decoder.decode(chunk, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

export interface ProviderRequestOptions {
  body?: string;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  proxy?: ResolvedProxy;
  signal?: AbortSignal;
  timeoutMs: number;
  url: string;
}

/**
 * One bounded outbound call. Timeouts are enforced with an internal
 * AbortController so a hung vendor cannot outlive the operation's budget even
 * when it keeps the socket open by trickling bytes.
 */
export async function providerRequest(options: ProviderRequestOptions): Promise<ProviderResponse> {
  const controller = new AbortController();
  const abortOuter = () => controller.abort();
  options.signal?.addEventListener("abort", abortOuter, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs));
  try {
    const dispatcher = options.proxy ? proxyDispatcher(options.proxy, options.url) : undefined;
    const response = await request(options.url, {
      method: options.method ?? "GET",
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.body === undefined ? {} : { body: options.body }),
      signal: controller.signal,
      // The wall-clock budget above owns the deadline; per-phase undici timeouts
      // would otherwise fire with a less specific error than the caller expects.
      bodyTimeout: 0,
      headersTimeout: Math.max(1, options.timeoutMs),
      ...(dispatcher ? { dispatcher } : {}),
    });
    return { body: await readBounded(response.body), statusCode: response.statusCode };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortOuter);
  }
}
