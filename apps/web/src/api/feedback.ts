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

import {
  FEEDBACK_API_PATH,
  FEEDBACK_ENDPOINT,
  FEEDBACK_MAX_BYTES,
  isValidReceipt,
  type FeedbackSubmission,
} from "@sciencediscovery/operational-logging/feedback";

export const FEEDBACK_TIMEOUT_MS = 15_000;

/**
 * Normalized failure the dialog can render to a message and downgrade actions.
 * The Worker's `{ error }` codes are flattened into a client-side enum so callers
 * never inspect raw upstream bodies.
 */
export type FeedbackFailure =
  | { code: "network" }
  | { code: "timeout" }
  | { code: "forbidden" }
  | { code: "rate_limited" }
  | { code: "duplicate"; receipt?: string }
  | { code: "too_large" }
  | { code: "unavailable" }
  | { code: "upstream" }
  | { code: "invalid"; fields?: Record<string, string> }
  | { code: "http"; status: number };

export type SubmitFeedbackResult =
  | { ok: true; receipt: string; createdAt: string }
  | { ok: false; failure: FeedbackFailure };

export interface SubmitFeedbackOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal | null;
}

interface ErrorBody {
  error?: string;
  receipt?: string;
  fields?: Record<string, string>;
}

function normalize(status: number, body: unknown): FeedbackFailure {
  const payload = (body ?? {}) as ErrorBody;
  switch (status) {
    case 403: return { code: "forbidden" };
    case 409: return { code: "duplicate", ...(payload.receipt ? { receipt: payload.receipt } : {}) };
    case 413: return { code: "too_large" };
    case 429: return { code: "rate_limited" };
    case 503: return { code: "unavailable" };
    case 502: return { code: "upstream" };
    case 400: return { code: "invalid", ...(payload.fields ? { fields: payload.fields } : {}) };
    default:
      if (payload.error === "upstream_failed") return { code: "upstream" };
      return { code: "http", status };
  }
}

export async function submitFeedback(
  submission: FeedbackSubmission,
  options: SubmitFeedbackOptions = {},
): Promise<SubmitFeedbackResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEEDBACK_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);
  try {
    // The relay measures the body in bytes, not characters: a CJK report can be
    // three times its character count, so fail here with the same code the
    // Worker would return rather than sending a request that cannot succeed.
    const serialized = JSON.stringify(submission);
    if (new TextEncoder().encode(serialized).length > FEEDBACK_MAX_BYTES) {
      return { ok: false, failure: { code: "too_large" } };
    }
    let response: Response;
    try {
      response = await fetchImpl(`${FEEDBACK_ENDPOINT}${FEEDBACK_API_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submission),
        signal: controller.signal,
      });
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === "AbortError";
      return { ok: false, failure: aborted ? { code: "timeout" } : { code: "network" } };
    }

    if (response.status === 201) {
      const data = (await response.json()) as { receipt?: string; createdAt?: string };
      if (data.receipt && isValidReceipt(data.receipt)) {
        return { ok: true, receipt: data.receipt, createdAt: data.createdAt ?? new Date().toISOString() };
      }
      return { ok: false, failure: { code: "http", status: response.status } };
    }

    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    return { ok: false, failure: normalize(response.status, body) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}