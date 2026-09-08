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
 * Per-host token-bucket rate limiter with Retry-After awareness — ported
 * verbatim in behavior from the DeepAnalyze scholarly rate-limiter.
 * Deterministic: no heuristics, just capacity + explicit upstream signals.
 */

interface HostState {
  tokens: number;
  lastRefill: number;
  blockedUntil: number;
  capacity?: number;
  intervalMs?: number;
}

export class RateLimiter {
  private readonly hosts = new Map<string, HostState>();

  constructor(
    /** Tokens added per interval per host. */
    private readonly capacity = 1,
    /** Refill interval in ms (default: 1 token / second). */
    private readonly intervalMs = 1_000,
  ) {}

  /** Override the default rate for a specific host (e.g. stricter upstream limits). */
  setHostRate(host: string, capacity: number, intervalMs: number): void {
    this.state(host).capacity = capacity;
    this.state(host).intervalMs = intervalMs;
  }

  private state(host: string): HostState {
    let current = this.hosts.get(host);
    if (!current) {
      current = { tokens: this.capacity, lastRefill: Date.now(), blockedUntil: 0 };
      this.hosts.set(host, current);
    }
    return current;
  }

  /** Wait until a request to `host` is allowed. */
  async throttle(host: string): Promise<void> {
    const current = this.state(host);
    const capacity = current.capacity ?? this.capacity;
    const intervalMs = current.intervalMs ?? this.intervalMs;
    for (;;) {
      const now = Date.now();
      if (now < current.blockedUntil) {
        await sleep(current.blockedUntil - now);
        continue;
      }
      const elapsed = now - current.lastRefill;
      if (elapsed >= intervalMs) {
        current.tokens = Math.min(capacity, current.tokens + Math.floor(elapsed / intervalMs));
        current.lastRefill = now;
      }
      if (current.tokens >= 1) {
        current.tokens -= 1;
        return;
      }
      await sleep(intervalMs - (now - current.lastRefill));
    }
  }

  /**
   * Record an upstream rate-limit response. Parses Retry-After (seconds or
   * HTTP date); falls back to a conservative default block.
   */
  respectRetryAfter(host: string, retryAfterHeader: string | null, defaultMs = 30_000): number {
    const current = this.state(host);
    let waitMs = defaultMs;
    if (retryAfterHeader) {
      const seconds = Number(retryAfterHeader);
      if (Number.isFinite(seconds)) {
        waitMs = Math.max(0, seconds * 1_000);
      } else {
        const date = Date.parse(retryAfterHeader);
        if (!Number.isNaN(date)) {
          waitMs = Math.max(0, date - Date.now());
        }
      }
    }
    current.blockedUntil = Math.max(current.blockedUntil, Date.now() + waitMs);
    return waitMs;
  }
}

/**
 * Create the shared scholarly limiter (1 rps per host default) with the
 * stricter keyless tiers the DeepAnalyze deployment measured:
 * - Semantic Scholar keyless tier: ~100 req / 5 min → 1 req / 3s.
 * - arXiv API etiquette: no more than 1 request / 3s.
 */
export function createScholarlyRateLimiter(): RateLimiter {
  const limiter = new RateLimiter(1, 1_000);
  limiter.setHostRate("api.semanticscholar.org", 1, 3_000);
  limiter.setHostRate("export.arxiv.org", 1, 3_000);
  limiter.setHostRate("cn.arxiv.org", 1, 3_000);
  return limiter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
