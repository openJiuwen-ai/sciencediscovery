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


import type { ApiError } from "@sciencediscovery/schema";

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

/** True only for the control plane's "your bearer token is wrong" answer.
 *  `/api/*` returns 401 from exactly one place — the token comparison in
 *  `services/api/src/http/index.ts` — so the status alone is a precise signal,
 *  and transport failures, aborts and 5xx never masquerade as a bad token. */
export function isAuthFailure(reason: unknown): boolean {
  return reason instanceof ApiRequestError && reason.status === 401;
}

export class AuthApiClient {
  /** @param onAuthFailure notified whenever the server rejects this token, so
   *  the UI can offer the token dialog instead of showing a bare error. */
  constructor(
    protected readonly token: string,
    protected readonly onAuthFailure?: () => void,
  ) {}

  /** Report a rejected token from any request path, including raw `fetch`
   *  callers that read streams or blobs instead of going through `request`. */
  protected reportAuthStatus(status: number): void {
    if (status === 401) this.onAuthFailure?.();
  }

  protected async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
    const response = await fetch(path, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body && !isFormData ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      this.reportAuthStatus(response.status);
      const body = (await response.json().catch(() => ({ error: response.statusText }))) as ApiError;
      throw new ApiRequestError(
        body.error || `Request failed (${response.status})`,
        response.status,
        body.code,
        body.details,
      );
    }
    return (await response.json()) as T;
  }

  /** Same as `request` but returns the raw response body as text, for endpoints
   *  that are not JSON (e.g. `/api/cas/{hash}` returns `application/octet-stream`
   *  bytes — `request` would try `response.json()` and throw). Shares the same
   *  auth header + error envelope so callers can `catch (ApiRequestError)`. */
  protected async requestText(path: string, init: RequestInit = {}): Promise<string> {
    const response = await fetch(path, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...init.headers,
      },
    });
    if (!response.ok) {
      this.reportAuthStatus(response.status);
      const body = (await response.json().catch(() => ({ error: response.statusText }))) as ApiError;
      throw new ApiRequestError(
        body.error || `Request failed (${response.status})`,
        response.status,
        body.code,
        body.details,
      );
    }
    return await response.text();
  }

}
