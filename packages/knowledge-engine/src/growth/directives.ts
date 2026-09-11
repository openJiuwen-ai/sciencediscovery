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
 * C3③ structured cycle reflection (OpenDDE reflection → directives):
 * at the end of every grow cycle, deterministic facts about that cycle
 * (frontier outcome counts, per-source hit rates, dedup absorption) are
 * compressed into DIRECTIVES that the next cycle's seeding reads. This is
 * the zero-LLM seedling of a loop driver: template rules only, every
 * threshold named, no model calls — the same facts could later feed an
 * LLM reflection without changing the contract.
 */

export interface GrowSourceFacts {
  readonly source: string;
  readonly items: number;
  readonly done: number;
  readonly failed: number;
  readonly skipped: number;
  /** Total discovery encounters including dedup re-finds (sum of cite_hits). */
  readonly encounters: number;
}

export interface GrowCycleFacts {
  readonly counts: { readonly total: number; readonly pending: number; readonly done: number; readonly failed: number; readonly skipped: number };
  readonly sources: readonly GrowSourceFacts[];
  /** Re-discoveries absorbed by dedup this cycle (encounters − items). */
  readonly duplicates: number;
  readonly converged: boolean;
}

export type GrowDirectiveKind =
  | "deprioritize-source"
  | "narrow-queries"
  | "broaden-queries"
  | "converged-hold";

export interface GrowDirective {
  readonly kind: GrowDirectiveKind;
  readonly text: string;
  /** Deterministic knob the next cycle's seeding applies mechanically. */
  readonly patchQueryCap?: number;
}

// Named thresholds — the "policy" of the reflection, kept in one place.
export const DIRECTIVE_MIN_SOURCE_ENCOUNTERS = 5;
export const DIRECTIVE_SOURCE_FAILURE_RATE = 0.8;
export const DIRECTIVE_DUPLICATE_RATE = 0.6;
export const DIRECTIVE_LOW_DUPLICATE_RATE = 0.2;
export const NARROW_PATCH_QUERY_CAP = 2;

/**
 * Derive directives from one cycle's facts. Pure and total: any facts in,
 * directives out — never throws, never reads the clock.
 */
export function buildGrowDirectives(facts: GrowCycleFacts): GrowDirective[] {
  const directives: GrowDirective[] = [];

  for (const source of facts.sources) {
    // Failure verdicts only count attempted items: skipped candidates were
    // never tried (budget/cap), so including them would both dilute the rate
    // and misstate the wording below as if they had resolved no full text.
    const attempted = source.done + source.failed;
    if (attempted < DIRECTIVE_MIN_SOURCE_ENCOUNTERS) continue;
    const failureRate = source.failed / attempted;
    if (failureRate >= DIRECTIVE_SOURCE_FAILURE_RATE) {
      directives.push({
        kind: "deprioritize-source",
        text:
          `Deprioritize ${source.source}: ${source.failed}/${attempted} attempted candidates failed to ` +
          `reach full text last cycle (ingest failures and rate-limit exhaustion) — prefer other discovery ` +
          `paths before expanding this source again.`,
      });
    }
  }

  const items = facts.counts.total;
  const duplicateRate = facts.duplicates + items > 0 ? facts.duplicates / (facts.duplicates + items) : 0;
  if (facts.duplicates >= 5 && duplicateRate >= DIRECTIVE_DUPLICATE_RATE) {
    directives.push({
      kind: "narrow-queries",
      text:
        `Discovery is saturating: ${facts.duplicates} of ${facts.duplicates + items} encounters were ` +
        `re-finds of known papers — keep only the most specific entity patch queries this cycle.`,
      patchQueryCap: NARROW_PATCH_QUERY_CAP,
    });
  } else if (
    !facts.converged && facts.counts.pending === 0 && items >= 10
    && duplicateRate < DIRECTIVE_LOW_DUPLICATE_RATE
  ) {
    directives.push({
      kind: "broaden-queries",
      text:
        `Frontier exhausted with low duplication (${facts.duplicates}/${facts.duplicates + items} re-finds) ` +
        `and convergence not reached — broaden entity patch queries toward adjacent terminology.`,
    });
  }

  if (facts.converged) {
    directives.push({
      kind: "converged-hold",
      text:
        "Convergence signals fired last cycle — prefer depth (verifying existing claims) over breadth " +
        "(admitting new papers) until divergence reopens growth.",
    });
  }

  return directives;
}

/**
 * Render directives as an injectable block (next-cycle seeding log, engine
 * state, or a future LLM reflection prompt — same text either way).
 */
export function formatDirectivesForPrompt(directives: readonly GrowDirective[]): string {
  if (directives.length === 0) return "";
  const lines = directives.map((directive) => `- ${directive.text}`);
  return ["GROWTH DIRECTIVES (deterministic reflection over the previous cycle):", ...lines].join("\n");
}
