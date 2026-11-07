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
  FEEDBACK_MAX_BYTES,
  generateReceipt,
  validateFeedbackSubmission,
  type FeedbackSubmission,
} from "@sciencediscovery/operational-logging/feedback";
import { createIssue, deleteFeedbackImage, uploadFeedbackImage } from "./github.js";

// ---------------------------------------------------------------------------
// The Worker shares every wire constant and validation rule with the client
// through @sciencediscovery/operational-logging/feedback, so the two ends never
// drift on the contract.
// ---------------------------------------------------------------------------

const API_PATH = "/api/feedback";
const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:4310",
  "http://localhost:4310",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:5174",
  "http://localhost:5174",
];

const DAY_SECONDS = 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;

/** Defaults for the limits that moved out of `wrangler.toml` into the dashboard. */
const DEFAULT_INSTALL_DAILY_LIMIT = 5;
const DEFAULT_IP_HOURLY_LIMIT = 10;
const DEFAULT_DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Minimal surface of Cloudflare KV; the real namespace is a compatible superset. */
export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/**
 * Every operational value comes from the Cloudflare dashboard (Settings →
 * Variables). The per-install limits and the dedupe TTL keep the values this
 * Worker used to ship in `wrangler.toml`, so a deploy that does not re-enter
 * them keeps serving instead of answering 503 to every report. The
 * repository-wide issue quota has no default: forgetting it should be loud.
 */
export interface WorkerEnv {
  FEEDBACK_KV?: KVNamespaceLike;
  GITHUB_TOKEN?: string;
  REPO_OWNER?: string;
  REPO_NAME?: string;
  INSTALL_DAILY_LIMIT?: string;
  IP_HOURLY_LIMIT?: string;
  DAILY_ISSUE_LIMIT?: string;
  DEDUP_TTL_SECONDS?: string;
  ALLOWED_ORIGINS?: string;
}

export interface WorkerConfig {
  token: string;
  repoOwner: string;
  repoName: string;
  installDailyLimit: number;
  ipHourlyLimit: number;
  dailyIssueLimit: number;
  dedupTtlSeconds: number;
}

export interface FeedbackDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
}

export interface ExecutionContextLike {
  waitUntil?(promise: Promise<unknown>): void;
}

function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  return crypto.subtle.digest("SHA-256", data).then((digest) =>
    Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function hourKey(now: Date): string {
  return now.toISOString().slice(0, 13);
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? "";
}

function allowedOrigins(env: WorkerEnv): string[] {
  const extra = (env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return [...DEFAULT_ALLOWED_ORIGINS, ...extra];
}

function originAllowed(origin: string | null, allowed: string[]): boolean {
  return origin !== null && allowed.includes(origin);
}

function json(body: unknown, status: number, corsOrigin: string | null, extra: Record<string, string> = {}): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (corsOrigin) headers["Access-Control-Allow-Origin"] = corsOrigin;
  headers["Vary"] = "Origin";
  return new Response(JSON.stringify(body), { status, headers });
}

async function increment(kv: KVNamespaceLike, key: string, ttl: number): Promise<number> {
  const previous = await kv.get(key);
  const value = (previous ? Number(previous) : 0) + 1;
  await kv.put(key, String(value), { expirationTtl: ttl });
  return value;
}

function readString(env: WorkerEnv, name: keyof WorkerEnv): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(env: WorkerEnv, name: keyof WorkerEnv): number | undefined {
  const raw = readString(env, name);
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Missing values use the fallback; a value that is present but invalid is still
 *  a configuration error, so a typo never silently becomes the default. */
function readLimit(env: WorkerEnv, name: keyof WorkerEnv, fallback: number): number | undefined {
  return readString(env, name) === undefined ? fallback : readPositiveInteger(env, name);
}

/**
 * Read the dashboard configuration. Every miss is logged by name because
 * `wrangler tail` is the only place an operator can see why a deployment
 * answers 503, and the client intentionally gets no detail.
 */
function readConfig(env: WorkerEnv): WorkerConfig | undefined {
  const missing: string[] = [];
  const token = readString(env, "GITHUB_TOKEN");
  const repoOwner = readString(env, "REPO_OWNER");
  const repoName = readString(env, "REPO_NAME");
  const installDailyLimit = readLimit(env, "INSTALL_DAILY_LIMIT", DEFAULT_INSTALL_DAILY_LIMIT);
  const ipHourlyLimit = readLimit(env, "IP_HOURLY_LIMIT", DEFAULT_IP_HOURLY_LIMIT);
  const dailyIssueLimit = readPositiveInteger(env, "DAILY_ISSUE_LIMIT");
  const dedupTtlSeconds = readLimit(env, "DEDUP_TTL_SECONDS", DEFAULT_DEDUP_TTL_SECONDS);

  if (!env.FEEDBACK_KV) missing.push("FEEDBACK_KV binding");
  if (!token) missing.push("GITHUB_TOKEN");
  if (!repoOwner) missing.push("REPO_OWNER");
  if (!repoName) missing.push("REPO_NAME");
  if (!installDailyLimit) missing.push("INSTALL_DAILY_LIMIT");
  if (!ipHourlyLimit) missing.push("IP_HOURLY_LIMIT");
  if (!dailyIssueLimit) missing.push("DAILY_ISSUE_LIMIT");
  // KV rejects an expirationTtl below 60 seconds.
  if (!dedupTtlSeconds || dedupTtlSeconds < 60) missing.push("DEDUP_TTL_SECONDS");

  if (missing.length > 0) {
    console.error(`feedback: misconfigured — set on the Cloudflare dashboard: ${missing.join(", ")}`);
    return undefined;
  }
  return {
    token: token!,
    repoOwner: repoOwner!,
    repoName: repoName!,
    installDailyLimit: installDailyLimit!,
    ipHourlyLimit: ipHourlyLimit!,
    dailyIssueLimit: dailyIssueLimit!,
    dedupTtlSeconds: dedupTtlSeconds!,
  };
}

/** UTF-8 size of a string without materialising a second copy of a body that
 *  may be 24 MiB: `TextEncoder().encode()` would double the peak allocation. */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export async function handleRequest(request: Request, env: WorkerEnv, deps: FeedbackDeps = {}): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const origin = request.headers.get("Origin");
  const allowed = allowedOrigins(env);

  // CORS preflight: a JSON POST from the browser is always preceded by OPTIONS.
  if (request.method === "OPTIONS") {
    if (!originAllowed(origin, allowed)) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin!,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const url = new URL(request.url);
  if (url.pathname !== API_PATH) return new Response("not found", { status: 404 });
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { Allow: "POST, OPTIONS" } });
  }

  // Origin is a coarse browser-cross-site filter, not a security boundary. No
  // Origin header (Electron shell / CLI) is allowed through.
  const corsOrigin = origin && originAllowed(origin, allowed) ? origin : null;
  if (origin !== null && !originAllowed(origin, allowed)) {
    return json({ error: "forbidden" }, 403, corsOrigin);
  }

  const config = readConfig(env);
  if (!config) return json({ error: "misconfigured" }, 503, corsOrigin);
  const kv = env.FEEDBACK_KV!;

  // Reject an oversized upload before buffering it. The header is advisory, so
  // the exact size is still checked below without copying the string.
  const declaredLength = Number(request.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > FEEDBACK_MAX_BYTES) {
    return json({ error: "too_large" }, 413, corsOrigin);
  }
  let raw = await request.text();
  if (utf8ByteLength(raw) > FEEDBACK_MAX_BYTES) {
    return json({ error: "too_large" }, 413, corsOrigin);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400, corsOrigin);
  }
  // Release the serialised body before image uploads hold their own copies.
  raw = "";
  if (typeof parsed !== "object" || parsed === null || (parsed as { v?: unknown }).v !== 1) {
    return json({ error: "invalid", fields: { v: "expected 1" } }, 400, corsOrigin);
  }

  const submission = parsed as FeedbackSubmission;
  const errors = validateFeedbackSubmission(submission);
  if (errors.length > 0) {
    const fields = Object.fromEntries(errors.map((error) => [error.field, error.reason]));
    return json({ error: "invalid", fields }, 400, corsOrigin);
  }

  const installId = (submission.meta?.installId ?? "").slice(0, 64);

  // Dedupe before the counters: a client retrying the same report must not spend
  // its own daily allowance or the shared quota on a request that creates
  // nothing. Keyed by reporter as well as content: the offline screen seeds every
  // user with the same failure text, so a content-only key would hand one user's
  // receipt to another and silently drop their report. Screenshots are part of
  // the content, otherwise the same words with a new screenshot would be a 409.
  // Each image is folded in by digest instead of concatenating its Base64 body,
  // which would copy up to 22 MiB of strings just to hash them. Digests are
  // computed one at a time so only one image buffer is live at a time.
  const imageDigests: string[] = [];
  for (const image of submission.images ?? []) {
    imageDigests.push(await sha256Hex(image.data));
  }
  const dedupKey = `dedup:${await sha256Hex(
    `${installId}\n${submission.kind}\n${submission.body}\n${imageDigests.join(",")}`,
  )}`;
  const existingReceipt = await kv.get(dedupKey);
  if (existingReceipt) {
    return json({ error: "duplicate", receipt: existingReceipt }, 409, corsOrigin);
  }

  if (installId) {
    const count = await increment(kv, `rl:install:${dayKey(now())}:${installId}`, DAY_SECONDS);
    if (count > config.installDailyLimit) return json({ error: "rate_limited" }, 429, corsOrigin);
  }

  const ip = clientIp(request);
  if (ip) {
    // Store only a hash of the IP, never the raw address (AC-30), with a short TTL.
    const ipHash = await sha256Hex(ip);
    const count = await increment(kv, `rl:ip:${hourKey(now())}:${ipHash}`, HOUR_SECONDS);
    if (count > config.ipHourlyLimit) return json({ error: "rate_limited" }, 429, corsOrigin);
  }

  const guardrailKey = `quota:issues:${dayKey(now())}`;
  if (Number(await kv.get(guardrailKey) ?? "0") >= config.dailyIssueLimit) {
    return json({ error: "unavailable" }, 503, corsOrigin);
  }

  const receipt = generateReceipt(deps.randomBytes);

  // Screenshots go into the repository first, because the issue body needs
  // their URLs. Uploads run one at a time: eight 2 MiB images in parallel would
  // hold tens of megabytes of extra request bodies in memory at once and can
  // trip GitHub's secondary rate limits. A failed upload must not lose the
  // report: the body records the failure and the issue is still created. If the
  // issue itself cannot be created, the files already uploaded are removed so a
  // retry does not leave orphaned screenshots behind.
  const images = submission.images ?? [];
  const urls: string[] = [];
  const uploadedPaths: string[] = [];
  let failed = 0;
  for (let index = 0; index < images.length; index += 1) {
    try {
      const uploaded = await uploadFeedbackImage(fetchImpl, {
        token: config.token,
        owner: config.repoOwner,
        repo: config.repoName,
        receipt,
        index,
        image: images[index]!,
      });
      urls.push(uploaded.url);
      uploadedPaths.push(uploaded.path);
    } catch (error) {
      urls.push("");
      failed += 1;
      console.error(
        `feedback: image ${index + 1} upload failed —`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  try {
    await createIssue(fetchImpl, {
      token: config.token,
      owner: config.repoOwner,
      repo: config.repoName,
      receipt,
      submission,
      attachments: { urls, failed },
    });
  } catch (error) {
    // Never surface the token or internal stack to the client (AC-27); log the
    // GitHub status so operators can tell a 401 from a 422 in `wrangler tail`.
    console.error(
      "feedback: github issue create failed —",
      error instanceof Error ? error.message : String(error),
    );
    const cleanup = await Promise.allSettled(
      uploadedPaths.map((path) =>
        deleteFeedbackImage(fetchImpl, {
          token: config.token,
          owner: config.repoOwner,
          repo: config.repoName,
          path,
        }),
      ),
    );
    for (const result of cleanup) {
      if (result.status === "rejected") {
        console.error(
          "feedback: orphaned screenshot cleanup failed —",
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        );
      }
    }
    return json({ error: "upstream_failed" }, 502, corsOrigin);
  }

  await kv.put(dedupKey, receipt, { expirationTtl: config.dedupTtlSeconds });
  await increment(kv, guardrailKey, DAY_SECONDS);
  return json({ receipt, createdAt: now().toISOString() }, 201, corsOrigin);
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
    return handleRequest(request, env);
  },
};
