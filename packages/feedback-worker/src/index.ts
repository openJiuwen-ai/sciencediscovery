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
import { createIssue } from "./github.js";

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

const INSTALL_DAILY_LIMIT = 5;
const IP_HOURLY_LIMIT = 10;
const DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;

/** Minimal surface of Cloudflare KV; the real namespace is a compatible superset. */
export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface WorkerEnv {
  FEEDBACK_KV: KVNamespaceLike;
  GITHUB_TOKEN: string;
  REPO_OWNER: string;
  REPO_NAME: string;
  DAILY_ISSUE_LIMIT?: string;
  ALLOWED_ORIGINS?: string;
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

function parseDailyLimit(env: WorkerEnv): number {
  const value = Number(env.DAILY_ISSUE_LIMIT ?? "200");
  return Number.isSafeInteger(value) && value > 0 ? value : 200;
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

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > FEEDBACK_MAX_BYTES) {
    return json({ error: "too_large" }, 413, corsOrigin);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400, corsOrigin);
  }
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
  if (installId) {
    const count = await increment(env.FEEDBACK_KV, `rl:install:${dayKey(now())}:${installId}`, DAY_SECONDS);
    if (count > INSTALL_DAILY_LIMIT) return json({ error: "rate_limited" }, 429, corsOrigin);
  }

  const ip = clientIp(request);
  if (ip) {
    // Store only a hash of the IP, never the raw address (AC-30), with a short TTL.
    const ipHash = await sha256Hex(ip);
    const count = await increment(env.FEEDBACK_KV, `rl:ip:${hourKey(now())}:${ipHash}`, HOUR_SECONDS);
    if (count > IP_HOURLY_LIMIT) return json({ error: "rate_limited" }, 429, corsOrigin);
  }

  const guardrailKey = `quota:issues:${dayKey(now())}`;
  const dailyLimit = parseDailyLimit(env);
  if (Number(await env.FEEDBACK_KV.get(guardrailKey) ?? "0") >= dailyLimit) {
    return json({ error: "unavailable" }, 503, corsOrigin);
  }

  // Keyed by reporter as well as content: the offline screen seeds every user
  // with the same failure text, so a content-only key would hand one user's
  // receipt to another and silently drop their report.
  const dedupKey = `dedup:${await sha256Hex(`${installId}\n${submission.kind}\n${submission.body}`)}`;
  const existingReceipt = await env.FEEDBACK_KV.get(dedupKey);
  if (existingReceipt) {
    return json({ error: "duplicate", receipt: existingReceipt }, 409, corsOrigin);
  }

  const receipt = generateReceipt(deps.randomBytes);
  try {
    await createIssue(fetchImpl, {
      token: env.GITHUB_TOKEN,
      owner: env.REPO_OWNER,
      repo: env.REPO_NAME,
      receipt,
      submission,
    });
  } catch (error) {
    // Never surface the token or internal stack to the client (AC-27); log the
    // GitHub status so operators can tell a 401 from a 422 in `wrangler tail`.
    console.error(
      "feedback: github issue create failed —",
      error instanceof Error ? error.message : String(error),
    );
    return json({ error: "upstream_failed" }, 502, corsOrigin);
  }

  await env.FEEDBACK_KV.put(dedupKey, receipt, { expirationTtl: DEDUP_TTL_SECONDS });
  await increment(env.FEEDBACK_KV, guardrailKey, DAY_SECONDS);
  return json({ receipt, createdAt: now().toISOString() }, 201, corsOrigin);
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
    return handleRequest(request, env);
  },
};