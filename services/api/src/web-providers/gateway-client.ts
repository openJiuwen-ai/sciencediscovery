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

import type {
  DdgsBackend,
  WebFetchProvider,
  WebOperation,
  WebProxyMode,
  WebSearchProvider,
} from "@science-agent/schema";

export interface WebGatewayOptions {
  apiKey?: string;
  backend?: DdgsBackend;
  proxy?: string;
  proxyEnvironment?: Record<string, string>;
  proxyMode: WebProxyMode;
}

export interface WebGatewayResponse {
  attempts?: Array<{
    durationMs: number;
    endpoint?: string;
    errorCode?: string;
    errorMessage?: string;
    isError: boolean;
  }>;
  content: string;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  isError: boolean;
}

export class WebGatewayError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WebGatewayError";
  }
}

function optionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function normalizeResponse(value: unknown): WebGatewayResponse | undefined {
  if (!value || typeof value !== "object") return undefined;
  const response = value as Record<string, unknown>;
  if (typeof response.content !== "string"
    || typeof response.durationMs !== "number"
    || !Number.isFinite(response.durationMs)
    || typeof response.isError !== "boolean"
    || !optionalString(response.errorCode)
    || !optionalString(response.errorMessage)) return undefined;

  const rawAttempts = response.attempts;
  if (rawAttempts !== undefined && rawAttempts !== null && (!Array.isArray(rawAttempts)
    || !rawAttempts.every((value) => {
      if (!value || typeof value !== "object") return false;
      const attempt = value as Record<string, unknown>;
      return typeof attempt.durationMs === "number"
        && Number.isFinite(attempt.durationMs)
        && typeof attempt.isError === "boolean"
        && optionalString(attempt.endpoint)
        && optionalString(attempt.errorCode)
        && optionalString(attempt.errorMessage);
    }))) return undefined;

  return {
    content: response.content,
    durationMs: response.durationMs,
    ...(typeof response.errorCode === "string" ? { errorCode: response.errorCode } : {}),
    ...(typeof response.errorMessage === "string" ? { errorMessage: response.errorMessage } : {}),
    isError: response.isError,
    ...(Array.isArray(rawAttempts) && rawAttempts.length > 0 ? {
      attempts: rawAttempts.map((value) => {
        const attempt = value as Record<string, unknown>;
        return {
          durationMs: attempt.durationMs as number,
          ...(typeof attempt.endpoint === "string" ? { endpoint: attempt.endpoint } : {}),
          ...(typeof attempt.errorCode === "string" ? { errorCode: attempt.errorCode } : {}),
          ...(typeof attempt.errorMessage === "string" ? { errorMessage: attempt.errorMessage } : {}),
          isError: attempt.isError as boolean,
        };
      }),
    } : {}),
  };
}

function httpError(status: number, statusText: string, body: string): WebGatewayError {
  let detail = body;
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === "object" && typeof (value as { detail?: unknown }).detail === "string") {
      detail = (value as { detail: string }).detail;
    }
  } catch {
    // Keep the bounded response text when the gateway did not return JSON.
  }
  const code = status === 400 || status === 422
    ? "invalid-input"
    : status === 401 || status === 403
      ? "unauthorized"
      : status === 429
        ? "rate-limited"
        : status >= 500
          ? "server-error"
          : "gateway-contract-error";
  return new WebGatewayError(
    `Web gateway ${status}: ${detail || statusText}`,
    code,
    status === 429 || status >= 500,
  );
}

export class WebGatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async invoke(input: {
    arguments: Record<string, unknown>;
    operation: WebOperation;
    options: WebGatewayOptions;
    provider: WebSearchProvider | WebFetchProvider;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<WebGatewayResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/internal/web/invoke`, {
      body: JSON.stringify({
        arguments: input.arguments,
        operation: input.operation,
        options: input.options,
        provider: input.provider,
        timeoutMs: input.timeoutMs ?? 30_000,
      }),
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: input.signal,
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 2_000);
      throw httpError(response.status, response.statusText, body);
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new WebGatewayError(
        "Web gateway returned malformed JSON. Check the API/Gateway version compatibility.",
        "gateway-contract-error",
        false,
      );
    }
    const normalized = normalizeResponse(value);
    if (!normalized) {
      throw new WebGatewayError(
        "Web gateway returned an invalid response. Check the API/Gateway version compatibility.",
        "gateway-contract-error",
        false,
      );
    }
    return normalized;
  }
}
