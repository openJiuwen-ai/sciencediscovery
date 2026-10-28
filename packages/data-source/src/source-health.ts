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

import type { McpAttempt } from "@sciencediscovery/schema";

// Internal policy: three distinct, attributed endpoint rejections in one minute;
// one recovery probe; exponential cooldowns capped at two minutes (406) / 30s (429).
export const SOURCE_HEALTH_POLICY = { rejectionThreshold: 3, rejectionWindowMs: 60_000,
  rejectionCooldownMs: 30_000, maxRejectionCooldownMs: 120_000, rateCooldownMs: 1_000, maxRateCooldownMs: 30_000 } as const;

export interface SourceHealthDiagnostic {
  decision: "cooldown" | "probe-in-flight";
  endpoint?: string;
  statusCode: number;
  retryAt: string;
}
interface State {
  until: number; probe: boolean; generation: number; strikes: number;
  rejected: Set<string>; since: number; endpoint?: string; statusCode: number;
}
export interface SourceAdmission { generation: number; probe: boolean }
export class SourceCoolingError extends Error {
  constructor(readonly diagnostic: SourceHealthDiagnostic, readonly retryAfterMs: number, readonly queueWaitMs = 0) {
    super("Source temporarily unavailable");
    this.name = "SourceCoolingError";
  }
}

/** In-memory only. Shared by broker instances using the same process limiter. */
export class SourceHealth {
  private readonly states = new Map<string, State>();
  constructor(private readonly now: () => number = Date.now) {}

  check(key: string): void {
    const state = this.states.get(key);
    if (state && (state.until > this.now() || state.probe)) throw this.error(state);
  }
  admit(key: string): SourceAdmission {
    this.check(key);
    const state = this.states.get(key);
    if (state && state.until > 0) {
      state.probe = true;
      return { generation: state.generation, probe: true };
    }
    return { generation: state?.generation ?? 0, probe: false };
  }
  abandon(key: string, admission: SourceAdmission): void {
    const state = this.states.get(key);
    if (admission.probe && state?.generation === admission.generation) state.probe = false;
  }
  success(key: string, admission: SourceAdmission): void {
    const state = this.states.get(key);
    // A success already in flight before a sibling's failure cannot erase it.
    if (state?.generation === admission.generation) this.states.delete(key);
  }
  failure(key: string, admission: SourceAdmission, attempt: McpAttempt, fingerprint: string): SourceCoolingError | undefined {
    const now = this.now();
    const state = this.states.get(key) ?? { until: 0, probe: false, generation: 0, strikes: 0,
      rejected: new Set<string>(), since: now, statusCode: 0 };
    const rateLimited = attempt.status === "rate-limited";
    const rejected = attempt.upstream?.statusCode === 406 && attempt.upstream.failureScope === "endpoint";
    if (!rateLimited && !rejected && !admission.probe) {
      // Request-specific errors are never evidence of persistent endpoint refusal.
      if (state.until === 0) this.states.delete(key);
      return undefined;
    }
    if (rejected && !admission.probe) {
      if (now - state.since > SOURCE_HEALTH_POLICY.rejectionWindowMs) {
        state.rejected.clear(); state.since = now;
      }
      state.rejected.add(fingerprint);
      this.states.set(key, state);
      if (state.rejected.size < SOURCE_HEALTH_POLICY.rejectionThreshold) return undefined;
    }
    state.strikes++;
    const retry = attempt.retryAfterMs;
    const delay = rateLimited
      ? retry !== undefined && Number.isFinite(retry) && retry >= 0
        ? Math.max(1, retry)
        : Math.min(SOURCE_HEALTH_POLICY.maxRateCooldownMs, SOURCE_HEALTH_POLICY.rateCooldownMs * 2 ** Math.min(state.strikes - 1, 10))
      : Math.min(SOURCE_HEALTH_POLICY.maxRejectionCooldownMs, SOURCE_HEALTH_POLICY.rejectionCooldownMs * 2 ** Math.min(state.strikes - 1, 10));
    state.until = Math.max(state.until, now + delay);
    state.statusCode = attempt.upstream?.statusCode ?? (rateLimited ? 429 : state.statusCode);
    state.endpoint = attempt.upstream?.endpoint ?? state.endpoint;
    state.probe = false;
    state.generation++;
    this.states.set(key, state);
    return this.error(state);
  }
  private error(state: State): SourceCoolingError {
    return new SourceCoolingError({ decision: state.probe ? "probe-in-flight" : "cooldown",
      ...(state.endpoint ? { endpoint: state.endpoint } : {}), statusCode: state.statusCode,
      retryAt: new Date(Math.min(8.64e15, Math.max(this.now(), state.until))).toISOString(),
    }, Math.max(1, state.until - this.now()));
  }
}
