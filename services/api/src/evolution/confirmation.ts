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

import { randomUUID } from "node:crypto";

/**
 * The budget gate in front of an evolution search.
 *
 * A search spends real budget (mutations plus sandboxed evaluations), so it
 * never starts without the user deciding. The run loop owns the decision
 * machinery (a `permission.required` card in ask mode); this module owns the
 * two things the gate must get right by itself:
 *
 * 1. **Which grant the decision covers.** The permission runtime matches a
 *    standing grant by `action` + `resource` (`store.ts`'s `requestPermission`,
 *    `permissionMatcherResource` in `@sciencediscovery/governance`); the tool
 *    call id is only recorded on the authorization. A resource shared by the
 *    whole session therefore turns one "allow matching" click into a silent
 *    allow for every later search.
 * 2. **What happens when there is no way to ask.** Typed callers cannot omit
 *    the confirmation callback (it is required on `EvolveTurnContext`), but a
 *    caller outside the type system must still be refused rather than allowed.
 */

/** What the gate asks the turn to put to the user, in the permission runtime's vocabulary. */
export interface EvolveConfirmationRequest {
  /** Names the decision: one search attempt, never every search in the session. */
  resource: string;
  summary: string;
  toolCallId?: string;
}

/** Asks the user about one search; true when they allowed it, false when they denied it. */
export type RequestEvolveConfirmation = (input: EvolveConfirmationRequest) => Promise<boolean>;

/** The slice of an evolve turn the gate needs. */
export interface EvolveConfirmationContext {
  requestConfirmation?: RequestEvolveConfirmation;
  sessionId: string;
}

export type EvolveConfirmationResult =
  | { confirmed: true }
  | { confirmed: false; refusedBecause: string };

/**
 * The grant key one search attempt is recorded under.
 *
 * Fresh for every attempt, including a retried tool call: "allow matching"
 * covers the search the user was shown and nothing after it. The session id
 * keeps a decision readable in the audit trail and keeps two sessions apart.
 */
export function evolveSearchResource(sessionId: string): string {
  return `evolve-search:${sessionId}:${randomUUID()}`;
}

/** The card text: what the search will do, and that it costs budget. */
export function evolveSearchSummary(proposal: { expansions: number; howScored: unknown }): string {
  return `Start an evolution search (${proposal.expansions} expansions) to improve "${
    typeof proposal.howScored === "string" ? proposal.howScored.slice(0, 120) : "the target"
  }"? It runs mutations and sandboxed evaluations and spends budget.`;
}

/**
 * Ask before the search starts. A denial and a missing approval path are both
 * refusals, and both are data the agent relays in its own words.
 */
export async function confirmEvolveSearch(
  context: EvolveConfirmationContext,
  proposal: { expansions: number; howScored: unknown },
  toolCallId?: string,
): Promise<EvolveConfirmationResult> {
  const ask = context.requestConfirmation;
  if (!ask) {
    // A typed caller cannot get here: `EvolveTurnContext.requestConfirmation`
    // is required, so a new construction site that forgets it is a compile
    // error. This closes the same hole for a caller outside the type system —
    // an untyped script, a stale build, a test double — because "no way to
    // ask" must mean "no search", never "always_allow, so go ahead".
    return {
      confirmed: false,
      refusedBecause: "confirmation unavailable: this turn has no approval path, so the evolution search was not started",
    };
  }
  const allowed = await ask({
    resource: evolveSearchResource(context.sessionId),
    summary: evolveSearchSummary(proposal),
    toolCallId,
  });
  return allowed
    ? { confirmed: true }
    : { confirmed: false, refusedBecause: "the evolution search was not confirmed by the user" };
}
