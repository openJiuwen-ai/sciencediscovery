// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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
 * Scholarly transport seam (W1 fixture injection point, per
 * qa/specs/W1-acceptance.md #11). Every connector talks HTTP exclusively
 * through this interface:
 *
 * - `HttpScholarlyTransport` — production: undici fetch + per-host token
 *   bucket + Retry-After bookkeeping. HTTP 429 becomes a RateLimitError
 *   carrying the upstream-signalled wait; other statuses are returned to the
 *   connector for its own classification.
 * - `FixtureScholarlyTransport` — mocked E2E: replays recorded responses from
 *   test/fixtures/scholarly/. A URL with no recorded fixture is a LOUD error
 *   (a silent 404 would let a journey pass against a hole in the recordings).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { RateLimitError } from "./types.js";
import type { RateLimiter } from "./rate-limiter.js";

export interface ScholarlyResponse {
  readonly status: number;
  readonly url: string;
  header(name: string): string | null;
  text(): Promise<string>;
  json(): Promise<unknown>;
  bytes(): Promise<Uint8Array>;
}

export interface ScholarlyRequest {
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  /**
   * Redirect policy. "follow" (default) for metadata APIs; "manual" for
   * downloads of untrusted URLs, where the caller re-validates every hop
   * (SSRF guard — see source-chain fetchPdf).
   */
  readonly redirect?: "follow" | "manual";
}

export interface ScholarlyTransport {
  get(url: string, options?: ScholarlyRequest): Promise<ScholarlyResponse>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** Extra grace for the body-read race beyond the request timeout (capped so
 *  short-timeout callers — and tests — keep a short total budget). */
const BODY_READ_GRACE_MS = 10_000;

/**
 * Read a response body with its own clock. The request's AbortSignal covers
 * the fetch lifecycle, but a body stream that stalls after headers (or whose
 * socket dies quietly — observed live with a bandwidth-throttled arxiv.org)
 * can leave arrayBuffer() pending forever with no handle, no timer and no
 * rejection: an invisible, restart-only hang. Race it instead.
 */
async function readBodyWithTimeout(response: {
  arrayBuffer(): Promise<ArrayBuffer>;
}, timeoutMs: number, url: string): Promise<Uint8Array> {
  const read = response.arrayBuffer();
  read.catch(() => {}); // a late rejection after the race lost is handled
  let timer: NodeJS.Timeout | undefined;
  try {
    const buffer = await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`body read timed out after ${timeoutMs}ms: ${url.slice(0, 120)}`)),
          timeoutMs,
        );
      }),
    ]);
    return new Uint8Array(buffer);
  } finally {
    clearTimeout(timer);
  }
}

export class HttpScholarlyTransport implements ScholarlyTransport {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly userAgent = "ScienceDiscovery/1.0 (knowledge-engine connector)",
  ) {}

  async get(url: string, options: ScholarlyRequest = {}): Promise<ScholarlyResponse> {
    const host = new URL(url).host;
    await this.limiter.throttle(host);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const response = await fetch(url, {
      headers: { "user-agent": this.userAgent, ...options.headers },
      redirect: options.redirect ?? "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 429) {
      const wait = this.limiter.respectRetryAfter(host, response.headers.get("retry-after"));
      throw new RateLimitError(`${host} rate limited (retry in ${wait}ms)`, wait);
    }
    // Buffer once so text/json/bytes are all safe to call repeatedly. The
    // body read gets its own race: a stalled body can outlive the request
    // abort (see readBodyWithTimeout).
    const body = await readBodyWithTimeout(response, timeoutMs + Math.min(BODY_READ_GRACE_MS, timeoutMs), url);
    return {
      status: response.status,
      url,
      header: (name) => response.headers.get(name.toLowerCase()),
      text: async () => new TextDecoder().decode(body),
      json: async () => JSON.parse(new TextDecoder().decode(body)),
      bytes: async () => body,
    };
  }
}

/**
 * Map a URL to its fixture filename deterministically: sanitized path +
 * short sha of the full URL (query strings included). Recording tooling and
 * replay must use the same mapping.
 */
export function fixtureFileName(url: string): string {
  const parsed = new URL(url);
  const raw = `${parsed.host}${parsed.pathname}`;
  const sanitized = raw.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);
  return `${sanitized}-${hash}`;
}

interface FixtureRecord {
  readonly status: number;
  readonly headers?: Record<string, string>;
  /** Text body. Binary bodies are stored base64 with encoding:"base64". */
  readonly body: string;
  readonly encoding?: "utf8" | "base64";
}

export class FixtureScholarlyTransport implements ScholarlyTransport {
  constructor(private readonly fixtureDir: string) {}

  async get(url: string): Promise<ScholarlyResponse> {
    const path = resolve(this.fixtureDir, `${fixtureFileName(url)}.json`);
    let record: FixtureRecord;
    try {
      record = JSON.parse(await readFile(path, "utf8")) as FixtureRecord;
    } catch {
      throw new Error(
        `no scholarly fixture recorded for ${url} (expected ${path}). ` +
          "Record it or the journey is exercising an unrecorded request.",
      );
    }
    const headers = new Map(Object.entries(record.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const body = record.encoding === "base64" ? new Uint8Array(Buffer.from(record.body, "base64")) : new TextEncoder().encode(record.body);
    return {
      status: record.status,
      url,
      header: (name) => headers.get(name.toLowerCase()) ?? null,
      text: async () => new TextDecoder().decode(body),
      json: async () => JSON.parse(new TextDecoder().decode(body)),
      bytes: async () => body,
    };
  }
}
