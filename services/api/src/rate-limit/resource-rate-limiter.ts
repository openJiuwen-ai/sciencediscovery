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

export interface ResourceRateLimitOptions {
  /** Maximum requests in flight; omitted means unlimited. */
  maxConcurrent?: number;
  /** Waiting requests allowed before acquire fails fast; omitted means unlimited. */
  maxQueueDepth?: number;
  /** Minimum spacing between grants; omitted or 0 disables pacing. */
  minIntervalMs?: number;
  /** Longest a request may wait in the queue; omitted disables the timeout. */
  queueTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface ResourceRateLease {
  /** Time spent waiting for the slot, for observability. */
  queueWaitMs: number;
  release(): void;
}

export class ResourceRateLimitQueueFullError extends Error {
  constructor(
    readonly key: string,
    readonly queueDepth: number,
  ) {
    super(`Rate-limit queue for ${key} is full (${queueDepth} waiting)`);
    this.name = "ResourceRateLimitQueueFullError";
  }
}

export class ResourceRateLimitQueueTimeoutError extends Error {
  constructor(
    readonly key: string,
    readonly queueWaitMs: number,
  ) {
    super(`Timed out after ${queueWaitMs}ms waiting for a ${key} rate-limit slot`);
    this.name = "ResourceRateLimitQueueTimeoutError";
  }
}

interface Waiter {
  enqueuedAt: number;
  onAbort: () => void;
  options: ResourceRateLimitOptions;
  reject: (error: unknown) => void;
  resolve: (lease: ResourceRateLease) => void;
  timeoutTimer?: NodeJS.Timeout;
}

interface KeyState {
  active: number;
  cooldownUntil: number;
  lastGrantedAt: number;
  /** Pacing of the most recent acquire, so an empty-queue cooldown still honours it. */
  lastMinIntervalMs: number;
  pumpTimer?: NodeJS.Timeout;
  queue: Waiter[];
}

/**
 * Process-wide limiter keyed by an arbitrary resource name (upstream host
 * group, or reserved namespaces such as `llm:<host>`). Combines minimum
 * request spacing, a concurrency cap, a FIFO wait queue with optional depth
 * and timeout guards, and an upstream-429 cooldown. State is in-memory only.
 */
export class ResourceRateLimiter {
  private readonly keys = new Map<string, KeyState>();

  async acquire(key: string, options: ResourceRateLimitOptions): Promise<ResourceRateLease> {
    if (options.maxConcurrent !== undefined
      && (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1)) {
      throw new Error("maxConcurrent must be a positive integer");
    }
    if (options.maxQueueDepth !== undefined
      && (!Number.isInteger(options.maxQueueDepth) || options.maxQueueDepth < 0)) {
      throw new Error("maxQueueDepth must be a non-negative integer");
    }
    if (options.minIntervalMs !== undefined && !(options.minIntervalMs >= 0)) {
      throw new Error("minIntervalMs must be non-negative");
    }
    if (options.queueTimeoutMs !== undefined && !(options.queueTimeoutMs > 0)) {
      throw new Error("queueTimeoutMs must be positive");
    }
    if (options.signal?.aborted) throw abortError(options.signal);

    const state = this.keys.get(key) ?? {
      active: 0,
      cooldownUntil: 0,
      lastGrantedAt: Number.NEGATIVE_INFINITY,
      lastMinIntervalMs: 0,
      queue: [],
    };
    this.keys.set(key, state);
    state.lastMinIntervalMs = options.minIntervalMs ?? 0;

    // Fast path: an idle key grants synchronously without touching timers.
    if (state.queue.length === 0 && state.active < (options.maxConcurrent ?? Number.POSITIVE_INFINITY)
      && Date.now() >= this.nextEligibleAt(state, options)) {
      return this.grant(key, state, 0);
    }
    if (options.maxQueueDepth !== undefined && state.queue.length >= options.maxQueueDepth) {
      throw new ResourceRateLimitQueueFullError(key, state.queue.length);
    }

    return new Promise<ResourceRateLease>((resolve, reject) => {
      const waiter: Waiter = {
        enqueuedAt: Date.now(),
        onAbort: () => {
          this.dropWaiter(key, state, waiter);
          reject(abortError(options.signal));
        },
        options,
        reject,
        resolve,
      };
      if (options.queueTimeoutMs !== undefined) {
        waiter.timeoutTimer = setTimeout(() => {
          this.dropWaiter(key, state, waiter);
          reject(new ResourceRateLimitQueueTimeoutError(key, Date.now() - waiter.enqueuedAt));
        }, options.queueTimeoutMs);
      }
      state.queue.push(waiter);
      options.signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.pump(key, state);
    });
  }

  /**
   * Records upstream throttling (HTTP 429) so subsequent grants for the key
   * wait out the advertised or inferred cooldown before hitting the provider.
   */
  reportUpstreamRateLimit(key: string, retryAfterMs?: number): void {
    const state = this.keys.get(key);
    if (!state) return;
    const fallback = Math.max(
      1_000,
      state.lastMinIntervalMs,
      ...state.queue.map((waiter) => waiter.options.minIntervalMs ?? 0),
    );
    const cooldownMs = retryAfterMs !== undefined && retryAfterMs >= 0 ? retryAfterMs : fallback;
    state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + cooldownMs);
    this.pump(key, state);
  }

  private nextEligibleAt(state: KeyState, options: ResourceRateLimitOptions): number {
    return Math.max(state.lastGrantedAt + (options.minIntervalMs ?? 0), state.cooldownUntil);
  }

  private grant(key: string, state: KeyState, queueWaitMs: number): ResourceRateLease {
    state.active += 1;
    state.lastGrantedAt = Date.now();
    let released = false;
    return {
      queueWaitMs,
      release: () => {
        if (released) return;
        released = true;
        state.active = Math.max(0, state.active - 1);
        this.pump(key, state);
      },
    };
  }

  private dropWaiter(key: string, state: KeyState, waiter: Waiter): void {
    const index = state.queue.indexOf(waiter);
    if (index >= 0) state.queue.splice(index, 1);
    if (waiter.timeoutTimer) clearTimeout(waiter.timeoutTimer);
    waiter.options.signal?.removeEventListener("abort", waiter.onAbort);
    this.pump(key, state);
  }

  private pump(key: string, state: KeyState): void {
    if (state.pumpTimer) {
      clearTimeout(state.pumpTimer);
      state.pumpTimer = undefined;
    }
    while (state.queue.length > 0) {
      const head = state.queue[0]!;
      if (state.active >= (head.options.maxConcurrent ?? Number.POSITIVE_INFINITY)) return;
      const wait = this.nextEligibleAt(state, head.options) - Date.now();
      if (wait > 0) {
        state.pumpTimer = setTimeout(() => {
          state.pumpTimer = undefined;
          this.pump(key, state);
        }, wait);
        state.pumpTimer.unref?.();
        return;
      }
      state.queue.shift();
      if (head.timeoutTimer) clearTimeout(head.timeoutTimer);
      head.options.signal?.removeEventListener("abort", head.onAbort);
      head.resolve(this.grant(key, state, Date.now() - head.enqueuedAt));
    }
  }
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Cancelled", "AbortError");
}
