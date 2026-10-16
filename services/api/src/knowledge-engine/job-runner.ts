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
 * Persistent job runner for the knowledge engine.
 *
 * Deliberately serial: one job at a time, no in-process parallelism. The
 * DeepAnalyze deployment learned that scholarly task storms (extraction +
 * downloads + growth competing) OOM the host; the queue semantics live in
 * the store (claim/fail/backoff/dead-letter), this loop is only the driver.
 */

import type { KeJobRow, KnowledgeEngineStore } from "./store.js";

export type KeJobHandler = (job: KeJobRow, signal: AbortSignal) => Promise<void>;

export interface KeJobRunnerOptions {
  readonly pollIntervalMs?: number;
  readonly backoffBaseMs?: number;
  readonly onError?: (message: string, detail: unknown) => void;
}

export class KeJobRunner {
  private readonly store: KnowledgeEngineStore;
  private readonly handlers = new Map<string, KeJobHandler>();
  private readonly pollIntervalMs: number;
  private readonly backoffBaseMs: number;
  private readonly onError: (message: string, detail: unknown) => void;
  private timer: NodeJS.Timeout | undefined;
  private abort: AbortController | undefined;
  private busy = false;
  private polling = false;

  constructor(store: KnowledgeEngineStore, options: KeJobRunnerOptions = {}) {
    this.store = store;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.backoffBaseMs = options.backoffBaseMs ?? 5_000;
    this.onError = options.onError ?? (() => {});
  }

  register(type: string, handler: KeJobHandler): void {
    this.handlers.set(type, handler);
  }

  /** Recover crash-orphaned jobs, then start polling. Idempotent. */
  start(): void {
    if (this.polling) {
      return;
    }
    this.polling = true;
    this.abort = new AbortController();
    const { recovered, deadLettered } = this.store.recoverStaleJobs();
    if (recovered > 0 || deadLettered > 0) {
      this.onError("ke_job_recovery", { recovered, deadLettered });
    }
    this.schedule(0);
  }

  /** Stop polling; an in-flight job is signalled but not waited on. */
  stop(): void {
    this.polling = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.abort?.abort();
  }

  private schedule(delayMs: number): void {
    if (!this.polling) {
      return;
    }
    // Never stack polling chains: a new schedule replaces any pending one.
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      if (!this.polling) {
        return;
      }
      void this.tick();
    }, delayMs);
  }

  /**
   * Public for tests: run one claim-execute cycle. Returns true if a job ran.
   * Manual invocation is safe at any time — rescheduling only happens while
   * the runner is polling, so test-driven ticks never spawn a polling chain.
   */
  async tick(): Promise<boolean> {
    if (this.busy) {
      return false;
    }
    this.busy = true;
    let ran = false;
    try {
      const types = [...this.handlers.keys()];
      if (types.length === 0) {
        return false;
      }
      const job = this.store.claimNextJob(types);
      if (!job) {
        return false;
      }
      const handler = this.handlers.get(job.type);
      if (!handler) {
        return false;
      }
      try {
        await handler(job, this.abort?.signal ?? new AbortController().signal);
        this.store.completeJob(job.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Handlers mark definitive failures (doom-loop aborts, contract
        // errors) nonRetryable: dead-letter immediately instead of burning
        // backoff cycles on work that can never succeed.
        const deadLetter = (error as { nonRetryable?: boolean }).nonRetryable === true;
        // A source Retry-After (connector 429) overrides the computed backoff
        // when longer — the requeue frees this serial runner's slot, so a
        // throttled grow never starves extract/ingest/seed work behind it.
        const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
        this.store.failJob(job.id, message, {
          backoffBaseMs: this.backoffBaseMs,
          deadLetter,
          ...(typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
        });
        this.onError("ke_job_failed", { jobId: job.id, type: job.type, attempts: job.attempts, error: message });
      }
      ran = true;
      return true;
    } catch (error) {
      this.onError("ke_job_tick_error", error);
      return false;
    } finally {
      this.busy = false;
      // Fast-follow while work remains (drain a backlog without idle gaps),
      // otherwise back off to the poll cadence. No-op when not polling.
      this.schedule(ran ? 0 : this.pollIntervalMs);
    }
  }
}
