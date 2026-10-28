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

import type { ApiErrorBody } from "./types.js";

/** Field names deliberately match `apps/web/src/api/auth.ts` so that lifting
 *  this client into a shared package later is a move, not a rewrite. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** True only for the control plane's "your bearer token is wrong" answer. The
 *  `/api/*` gate returns 401 from exactly one place, so the status alone is a
 *  precise signal: a transport failure or a 5xx never masquerades as one. */
export function isAuthFailure(reason: unknown): boolean {
  return reason instanceof ApiRequestError && reason.status === 401;
}

/** True for the rejection `fetch` and the body reader raise on abort. */
export function isAbortError(reason: unknown): boolean {
  return typeof reason === "object" && reason !== null && (reason as { name?: unknown }).name === "AbortError";
}

/**
 * The thin layer between the views and the HTTP API: it owns the base path,
 * the bearer header, JSON encoding/decoding and turning a non-2xx into a
 * throwable with something the user can read.
 *
 * Deliberately free of i18n. The server always sends an `error` string, so a
 * failure surfaces as what the backend actually said; the fallback is only for
 * a body that is not JSON at all. That is the property that makes this file
 * extractable into a shared package later.
 */
export class ApiClient {
  constructor(
    readonly token: string,
    private readonly onAuthFailure?: () => void,
  ) {}

  /** Report a rejected token from any request path, including the raw `fetch`
   *  callers that read SSE streams instead of going through `request`. */
  reportAuthStatus(status: number): void {
    if (status === 401) this.onAuthFailure?.();
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, this.decorate(init));
    if (!response.ok) throw await this.toError(response);
    return (await response.json()) as T;
  }

  /** A `fetch` whose headers are already authenticated, for callers that read
   *  the body as a stream (SSE) rather than as JSON. */
  async fetchStream(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(path, this.decorate(init));
    if (!response.ok) throw await this.toError(response);
    return response;
  }

  private decorate(init: RequestInit): RequestInit {
    // A `FormData` body carries its own content type, boundary included, and
    // only the browser can produce that boundary — naming the type here would
    // send `multipart/form-data` with no boundary and the server would read the
    // upload as an empty part list. Same rule as `apps/web/src/api/auth.ts`.
    const isForm = init.body instanceof FormData;
    return {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body && !isForm ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    };
  }

  private async toError(response: Response): Promise<ApiRequestError> {
    this.reportAuthStatus(response.status);
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    return new ApiRequestError(
      body.error || `Request failed (${response.status})`,
      response.status,
      body.code,
      body.details,
    );
  }
}
