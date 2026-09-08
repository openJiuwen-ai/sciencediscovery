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

export class HttpScholarlyTransport implements ScholarlyTransport {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly userAgent = "ScienceDiscovery/1.0 (knowledge-engine connector)",
  ) {}

  async get(url: string, options: ScholarlyRequest = {}): Promise<ScholarlyResponse> {
    const host = new URL(url).host;
    await this.limiter.throttle(host);
    const response = await fetch(url, {
      headers: { "user-agent": this.userAgent, ...options.headers },
      redirect: options.redirect ?? "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (response.status === 429) {
      const wait = this.limiter.respectRetryAfter(host, response.headers.get("retry-after"));
      throw new RateLimitError(`${host} rate limited (retry in ${wait}ms)`, wait);
    }
    // Buffer once so text/json/bytes are all safe to call repeatedly.
    const body = new Uint8Array(await response.arrayBuffer());
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
