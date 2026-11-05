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

// Client-side feedback plumbing shared by apps/web and apps/desktop. The two
// front ends differ only in the storage-key prefix and their translations, so
// the store, the imperative open hook and the HTTP call live here once; the app
// modules stay thin re-exports and keep their existing import paths.

import {
  FEEDBACK_API_PATH,
  FEEDBACK_ENDPOINT,
  FEEDBACK_MAX_BYTES,
  isValidReceipt,
  type FeedbackKind,
  type FeedbackMeta,
  type FeedbackSubmission,
} from "./feedback.js";

// ---------------------------------------------------------------------------
// Draft / history store
// ---------------------------------------------------------------------------

export interface FeedbackDraft {
  kind: FeedbackKind;
  body: string;
  contact: string;
  reproducibility: string;
  impact: string;
  includeDiagnostics: boolean;
}

export interface FeedbackRecord {
  receipt: string;
  kind: FeedbackKind;
  title: string;
  submittedAt: string;
  status: "submitted";
}

/** Narrower-than-`Storage` surface, matching the browser-storage conventions. */
export interface FeedbackStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function isFeedbackKind(value: unknown): value is FeedbackKind {
  return value === "bug" || value === "idea" || value === "other";
}

function isFeedbackRecord(value: unknown): value is FeedbackRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<FeedbackRecord>;
  return typeof record.receipt === "string" && typeof record.submittedAt === "string";
}

export interface FeedbackStore {
  /** A stable per-install id, generated once and reused for rate limiting identity. */
  readFeedbackInstallId(storage: FeedbackStorage): string;
  emptyFeedbackDraft(): FeedbackDraft;
  loadFeedbackDraft(storage: FeedbackStorage): FeedbackDraft;
  saveFeedbackDraft(storage: FeedbackStorage, draft: FeedbackDraft): void;
  clearFeedbackDraft(storage: FeedbackStorage): void;
  loadFeedbackHistory(storage: FeedbackStorage): FeedbackRecord[];
  saveFeedbackRecord(storage: FeedbackStorage, record: FeedbackRecord): FeedbackRecord[];
  removeFeedbackRecord(storage: FeedbackStorage, receipt: string): FeedbackRecord[];
}

/**
 * Build one app's feedback store. `prefix` is the localStorage namespace and is
 * frozen into the keys (`${prefix}-install`, `-draft`, `-history`), so changing
 * it would orphan existing drafts — treat it as part of the on-disk format.
 */
export function createFeedbackStore(prefix: string): FeedbackStore {
  const installKey = `${prefix}-install`;
  const draftKey = `${prefix}-draft`;
  const historyKey = `${prefix}-history`;

  /** Fallback identity for a storage that refuses the read or the write: one id
   *  per storage object, so a retry keeps the same install rather than minting a
   *  new one and bypassing dedupe and the per-install quota. */
  const fallbackInstallIds = new WeakMap<FeedbackStorage, string>();

  const emptyFeedbackDraft = (): FeedbackDraft => ({
    kind: "bug",
    body: "",
    contact: "",
    reproducibility: "",
    impact: "",
    includeDiagnostics: true,
  });

  const loadHistory = (storage: FeedbackStorage): FeedbackRecord[] => {
    try {
      const raw = storage.getItem(historyKey);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isFeedbackRecord);
    } catch {
      return [];
    }
  };

  const writeHistory = (storage: FeedbackStorage, history: FeedbackRecord[]): FeedbackRecord[] => {
    try { storage.setItem(historyKey, JSON.stringify(history)); } catch { /* ignore */ }
    return history;
  };

  return {
    readFeedbackInstallId(storage) {
      try {
        const existing = storage.getItem(installKey);
        if (existing) return existing;
      } catch {
        // Private mode and sandboxed frames can throw on read; fall through to
        // the in-memory id instead of failing the submission.
      }
      const cached = fallbackInstallIds.get(storage);
      if (cached) return cached;
      const id = uuid();
      fallbackInstallIds.set(storage, id);
      try { storage.setItem(installKey, id); } catch { /* keep serving the id */ }
      return id;
    },

    emptyFeedbackDraft,

    loadFeedbackDraft(storage) {
      try {
        const raw = storage.getItem(draftKey);
        if (!raw) return emptyFeedbackDraft();
        const parsed = JSON.parse(raw) as Partial<FeedbackDraft>;
        return {
          kind: isFeedbackKind(parsed.kind) ? parsed.kind : "bug",
          body: typeof parsed.body === "string" ? parsed.body : "",
          contact: typeof parsed.contact === "string" ? parsed.contact : "",
          reproducibility: typeof parsed.reproducibility === "string" ? parsed.reproducibility : "",
          impact: typeof parsed.impact === "string" ? parsed.impact : "",
          includeDiagnostics: parsed.includeDiagnostics !== false,
        };
      } catch {
        return emptyFeedbackDraft();
      }
    },

    saveFeedbackDraft(storage, draft) {
      try { storage.setItem(draftKey, JSON.stringify(draft)); } catch { /* quota or private mode */ }
    },

    clearFeedbackDraft(storage) {
      try { storage.removeItem?.(draftKey); } catch { /* ignore */ }
    },

    loadFeedbackHistory(storage) {
      return loadHistory(storage);
    },

    saveFeedbackRecord(storage, record) {
      return writeHistory(storage, [record, ...loadHistory(storage)].slice(0, 50));
    },

    removeFeedbackRecord(storage, receipt) {
      return writeHistory(storage, loadHistory(storage).filter((item) => item.receipt !== receipt));
    },
  };
}

// ---------------------------------------------------------------------------
// Imperative open hook
// ---------------------------------------------------------------------------

/**
 * Pre-fill for a feedback dialog opened from a specific context. The sidebar
 * entry opens without a seed; the error diagnostics "anonymous submit" button
 * opens with the error title/diagnostic and correlation ids.
 */
export interface FeedbackSeed {
  kind?: FeedbackKind;
  title?: string;
  body?: string;
  diagnostics?: string;
  meta?: FeedbackMeta;
}

type OpenFeedbackListener = (seed?: FeedbackSeed) => void;

export interface FeedbackOpenHook {
  /** Imperative open hook used by entry points that are not the dialog itself. */
  openFeedback(seed?: FeedbackSeed): void;
  /** The single mounted dialog subscribes here; returns an unsubscribe function. */
  subscribeFeedbackOpen(listener: OpenFeedbackListener): () => void;
}

/** One hook per app: the listener is module state, and two apps in one process
 *  must not steal each other's dialog. */
export function createFeedbackOpenHook(): FeedbackOpenHook {
  let openListener: OpenFeedbackListener | undefined;
  return {
    openFeedback(seed) {
      openListener?.(seed);
    },
    subscribeFeedbackOpen(listener) {
      openListener = listener;
      return () => { if (openListener === listener) openListener = undefined; };
    },
  };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

// Up to eight screenshots are uploaded one by one by the Worker before the
// issue is created, so the deadline has to cover serialized GitHub round trips
// rather than a single POST.
export const FEEDBACK_TIMEOUT_MS = 45_000;

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
    // The relay measures the body in bytes, not characters: a CJK report or a
    // Base64 screenshot can be much larger than its character count, so fail
    // here with the same code the Worker would return rather than sending a
    // request that cannot succeed.
    const serialized = JSON.stringify(submission);
    if (new TextEncoder().encode(serialized).length > FEEDBACK_MAX_BYTES) {
      return { ok: false, failure: { code: "too_large" } };
    }
    let response: Response;
    try {
      response = await fetchImpl(`${FEEDBACK_ENDPOINT}${FEEDBACK_API_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serialized,
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
