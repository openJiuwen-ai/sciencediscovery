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

/**
 * Living review (port of the DeepAnalyze cron `living_review` action,
 * scheduler.ts:256-305): periodically re-check converged knowledge bases for
 * drift and, when the monitor says reopen, auto-start a top-up grow cycle
 * with the KB's last successful query. Until now SD only COMPUTED the
 * monitor verdict for display (`livingReview` in the grow status payload) —
 * reopening stayed a manual action, so a converged KB silently went stale.
 *
 * Opt-in, mirroring the entity-resolution switch: env
 * SCIENCE_AGENT_KE_LIVING_REVIEW=on wins, then the ke_settings row
 * `ke_living_review_enabled` = "on"; default OFF. An always-on background
 * crawler that spends external API quota must be an explicit operator
 * choice, never a default.
 */

import { monitorConvergence } from "@sciencediscovery/knowledge-engine";

import type { KeOrchestrator } from "./orchestrator.js";
import { DEFAULT_CRAWL_BUDGET, type CrawlBudget } from "./grow.js";
import type { KnowledgeEngineStore } from "./store.js";

/** DA parity: the top-up is deliberately small — fresh material trickles in. */
const TOP_UP_BUDGET: CrawlBudget = { ...DEFAULT_CRAWL_BUDGET, maxPapers: 15, maxDepth: 1 };
/** DA ticks every 60s; the check itself is two cheap SQL reads per KB. */
const DEFAULT_INTERVAL_MS = 60_000;
/**
 * Per-KB cooldown between auto-reopens. Without it the loop is
 * self-sustaining: the top-up's new entities feed the novelty numerator while
 * the sticky convergedAt latch never re-stamps, so the very next tick would
 * fire again (verified in review). DA's cron effectively ran the action on a
 * daily schedule — this cooldown restores that cadence.
 */
const REOPEN_COOLDOWN_MS = 24 * 3_600_000;
const reopenWatermarkKey = (kbId: string): string => `living_review_reopened_at:${kbId}`;

export interface KeLivingReviewRunnerDeps {
  readonly store: KnowledgeEngineStore;
  readonly orchestrator: KeOrchestrator;
  readonly onWarn?: (message: string, detail?: unknown) => void;
  readonly intervalMs?: number;
  /** Test seam: override the enabled switch (default: env → ke_settings → off). */
  readonly enabled?: () => boolean;
}

export function resolveLivingReviewEnabled(store: KnowledgeEngineStore): boolean {
  const env = process.env.SCIENCE_AGENT_KE_LIVING_REVIEW?.trim().toLowerCase();
  if (env === "on") return true;
  if (env === "off") return false;
  // Same normalization as the env branch and the entity-resolution switch:
  // setSetting stores verbatim, so a hand-written 'ON'/'on ' must still work.
  return store.getSetting("ke_living_review_enabled")?.trim().toLowerCase() === "on";
}

export class KeLivingReviewRunner {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: KeLivingReviewRunnerDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => {
        this.deps.onWarn?.("ke_living_review_tick_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass over every KB: reopen the ones whose converged graph drifted.
   *  Exported (not just interval-driven) so tests and ops can fire it on demand. */
  async tick(): Promise<{ checked: number; reopened: string[] }> {
    const enabled = this.deps.enabled ?? (() => resolveLivingReviewEnabled(this.deps.store));
    if (!enabled()) return { checked: 0, reopened: [] };
    const reopened: string[] = [];
    let checked = 0;
    for (const kb of this.deps.store.listKnowledgeBases()) {
      const engineState = (kb.engineState ?? {}) as Record<string, unknown>;
      const convergedAt = typeof engineState["convergedAt"] === "string" ? engineState["convergedAt"] : null;
      if (!convergedAt) continue;
      checked += 1;
      const verdict = monitorConvergence({
        convergedAt,
        newEntities: this.deps.store.countEntitiesCreatedSince(kb.id, convergedAt),
      });
      if (!verdict.reopen) continue;
      // Cooldown: at most one auto-reopen per KB per window — a just-fired
      // top-up otherwise re-triggers the monitor on the very next tick (the
      // sticky latch keeps convergedAt old while its own new entities pump
      // the novelty numerator).
      const lastReopen = this.deps.store.getSetting(reopenWatermarkKey(kb.id));
      if (lastReopen && Date.now() - new Date(lastReopen).getTime() < REOPEN_COOLDOWN_MS) continue;
      // The cycle's own engine-state query; fall back to the KB identity
      // (same rule as a manual grow with an empty query).
      const query = typeof engineState["query"] === "string" && engineState["query"]
        ? engineState["query"]
        : [kb.name, kb.description].filter(Boolean).join(" — ");
      // startGrow dedups per KB (`reused`), so ticking while a top-up (or a
      // manual cycle) is already active never doubles the crawl.
      const handle = this.deps.orchestrator.startGrow(kb.id, query, TOP_UP_BUDGET);
      if (!handle.reused) {
        reopened.push(kb.id);
        this.deps.store.setSetting(reopenWatermarkKey(kb.id), new Date().toISOString());
        this.deps.onWarn?.("ke_living_review_reopen", { kbId: kb.id, reason: verdict.reason, query });
      }
    }
    return { checked, reopened };
  }
}
