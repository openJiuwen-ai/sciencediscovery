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
 * Post-run finish gate (JiuwenSwarm migration redo of the native
 * TurnLifecycle.beforeFinish seam — see native-agent/finish-gate.ts for the
 * stage semantics, which this module deliberately mirrors).
 *
 * Why this exists: the native agent loop consults FinishGateLifecycle at the
 * moment the model answers without tool calls. Under the JiuwenSwarm executor
 * the finish decision happens inside the Python loop and TS never sees it, so
 * the in-loop seam is inert there. This evaluator re-implements the gate one
 * level up, at the run orchestration layer where both executors look alike:
 * after a run completes, the gate re-evaluates from DURABLE session state
 * (store messages; each assistant message's modelContext carries that run's
 * closed tool trajectory) and, when a stage fires, the caller enqueues the
 * directive as a follow-up run in the same session. The follow-up run sees
 * the full chain through the normal history path, so the audit still reads
 * the trajectory it audits — only the run boundary moved.
 *
 * Executor parity is enforced at two layers:
 * - The caller (runs/index.ts run.completed path) skips this evaluation
 *   entirely when the run produced ANY in-loop finish_gate event — the native
 *   loop's gate owns such chains, including when the turn budget (rather than
 *   the directive cap) ended its continuations. Under JiuwenSwarm no in-loop
 *   events exist, so the gate always evaluates there.
 * - Belt and braces: the native in-loop directives also persist inside the
 *   run's modelContext, so the once-per-chain latches below (directive already
 *   present in the chain) would keep this evaluator silent on native anyway.
 * Both executors share one cap: directive messages in the chain are counted
 * regardless of which layer issued them, and the chain stops at
 * MAX_FINISH_GATE_CONTINUATIONS — the same budget the native loop enforces.
 *
 * Deliberate differences from the in-loop gate (recorded for review):
 * - The directive becomes a persisted user-role message (the continuation
 *   run's prompt). It is visible in the conversation transcript; the
 *   finish_gate run event marks why it exists.
 * - A gated chain is interruptible between runs: if the user (or a wake)
 *   enqueued a newer run, the caller skips the gate for the stale chain.
 */
import { MAX_FINISH_GATE_CONTINUATIONS } from "@sciencediscovery/runtime-core";
import type { ChatMessage } from "@sciencediscovery/schema";

import {
  buildFinishGateDirective,
  buildGroundingDirective,
  detectTerminationIntervention,
  FINISH_GATE_AUDIT_DIRECTIVE_PREFIX,
  FINISH_GATE_GROUNDING_DIRECTIVE_PREFIX,
  FINISH_GATE_INTERVENTION_DIRECTIVE_PREFIX,
  FINISH_GATE_REVIEW_TOOL,
  findUnverifiedQuotes,
  isFinishGateDirective,
  type FinishGateSkill,
} from "../native-agent/finish-gate.js";

/** The segment element shape the finish-gate scanners consume. */
type SegmentMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  name?: unknown;
  tool_call_id?: unknown;
};

export type PostRunFinishGateStage = "audit" | "intervention" | "grounding";

export interface PostRunFinishGateVerdict {
  directive: string;
  stage: PostRunFinishGateStage;
}

export interface PostRunFinishGateEvaluation {
  /**
   * Gate conditions remain unmet but the chain's continuation budget is
   * spent — the caller reports a denied finish_gate event (parity with the
   * native loop's capped continuation).
   */
  capped: boolean;
  verdict?: PostRunFinishGateVerdict;
}

export interface PostRunFinishGateInput {
  /**
   * Quote-coverage policy, mirroring the native gate's fuzzyQuoteCoverage
   * option. Default "verbatim-only": a fuzzy verdict is NOT coverage.
   */
  fuzzyQuoteCoverage?: "verbatim-only" | "allow-fuzzy";
  /** Durable session messages, oldest first (store.readMessages output). */
  messages: readonly ChatMessage[];
  /**
   * Deterministic plan-pending probe, same contract as the native gate's:
   * the chain's unfinished research_state plan items, or undefined when none.
   */
  pendingPlanItems?: () => Promise<Array<{ id: string; text: string }> | undefined>;
  /** Whether quote-verification tooling was registered for the finished run. */
  quoteVerificationAvailable: boolean;
  /** Whether the review_checkpoint tool was registered for the finished run. */
  reviewCheckpointAvailable: boolean;
  /** Skills active for the finished run (audit declarations + companions). */
  skills: readonly FinishGateSkill[];
}

/**
 * A genuine user message terminates the chain scan: user role, user-authored
 * kind (older messages predate the kind field), and not itself a gate
 * directive. Wake notices and review/checkpoint system messages never bound
 * a chain — an automatic wake continues the research thread it woke into.
 */
function isGenuineUserMessage(message: { content?: unknown; kind?: unknown; role?: string }): boolean {
  return message.role === "user"
    && (message.kind === undefined || message.kind === "message")
    && !isFinishGateDirective(message.content);
}

/**
 * Index just past the last genuine user message — the chain root. Exported
 * for the run-completion hook, which applies the same rule to the in-memory
 * trajectory when compaction removed the prompt echo from the persisted
 * model context.
 */
export function chainRootIndex(messages: readonly { content?: unknown; kind?: unknown; role?: string }[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isGenuineUserMessage(messages[i]!)) return i + 1;
  }
  return 0;
}

/**
 * Rebuild the chain segment in the shape the gate scanners read: everything
 * after the last genuine user message, with assistant messages expanded to
 * their persisted model context (which carries the run's tool calls and
 * results). This mirrors the promptHistory expansion in runs/index.ts so the
 * gate judges exactly what the next run's model would see.
 */
function chainSegment(messages: readonly ChatMessage[]): SegmentMessage[] {
  const segment: SegmentMessage[] = [];
  for (const message of messages.slice(chainRootIndex(messages))) {
    if (message.role === "assistant" && Array.isArray(message.modelContext) && message.modelContext.length) {
      segment.push(...(message.modelContext as SegmentMessage[]));
    } else {
      segment.push({ content: message.content, role: message.role });
    }
  }
  return segment;
}

function countDirectives(segment: readonly SegmentMessage[], prefix: string): number {
  return segment.filter((message) =>
    message.role === "user"
    && typeof message.content === "string"
    && message.content.startsWith(prefix)).length;
}

function countAllDirectives(segment: readonly SegmentMessage[]): number {
  return segment.filter((message) => message.role === "user" && isFinishGateDirective(message.content)).length;
}

function lastAssistantText(segment: readonly SegmentMessage[]): string {
  for (let i = segment.length - 1; i >= 0; i -= 1) {
    const message = segment[i]!;
    if (message.role === "assistant" && typeof message.content === "string") return message.content;
  }
  return "";
}

/**
 * Evaluate the finish gate for a just-completed run. Returns the directive to
 * enqueue as a continuation run, or nothing when the chain may close. Order
 * and latch rules mirror FinishGateLifecycle.beforeFinish: skill audit first
 * (once per chain), then the deterministic termination intervention (once per
 * chain), then groundedness enforcement (re-fires while unverified spans
 * remain, bounded by the shared cap).
 */
export async function evaluatePostRunFinishGate(
  input: PostRunFinishGateInput,
): Promise<PostRunFinishGateEvaluation> {
  const segment = chainSegment(input.messages);
  if (!segment.length) return { capped: false };
  const directives = countAllDirectives(segment);
  const spent = directives >= MAX_FINISH_GATE_CONTINUATIONS;
  const draft = lastAssistantText(segment);

  // Stage 1 — skill-declared audit, once per chain: fires when the chain has
  // neither a review_checkpoint observation nor an already-issued audit
  // directive (the native in-loop directive satisfies the latter, which is
  // what keeps this evaluator silent on the native executor).
  const auditSkillIds = input.skills.filter((skill) => skill.preFinishAudit).map((skill) => skill.id);
  const alreadyReviewed = segment.some(
    (message) => message.role === "tool" && message.name === FINISH_GATE_REVIEW_TOOL,
  );
  const auditPending = input.reviewCheckpointAvailable
    && auditSkillIds.length > 0
    && !alreadyReviewed
    && countDirectives(segment, FINISH_GATE_AUDIT_DIRECTIVE_PREFIX) === 0;

  // Stage 1.5 — deterministic termination intervention, once per chain. The
  // probe runs even when the budget is spent: the denied signal must know
  // whether an intervention-worthy finish was capped.
  const assistantContents = segment
    .filter((message) => message.role === "assistant" && typeof message.content === "string")
    .map((message) => message.content as string)
    // The draft under judgement is the last assistant message; the repetition
    // check compares against the turns before it (same convention as native).
    .slice(0, -1);
  const intervention = countDirectives(segment, FINISH_GATE_INTERVENTION_DIRECTIVE_PREFIX) === 0
    ? detectTerminationIntervention({
        assistantContents,
        draftText: draft,
        ...(input.pendingPlanItems
          ? { pendingPlanItems: await input.pendingPlanItems().catch(() => undefined) }
          : {}),
      })
    : undefined;

  // Stage 2 — groundedness enforcement, no latch: every finish that still
  // ships unverified quotes re-fires until the shared cap binds.
  const unverified = input.quoteVerificationAvailable && draft
    ? findUnverifiedQuotes(segment, draft, { allowFuzzy: input.fuzzyQuoteCoverage === "allow-fuzzy" })
    : [];

  if (spent) {
    return { capped: Boolean(auditPending || intervention || unverified.length) };
  }
  if (auditPending) {
    const selectedIds = new Set(input.skills.map((skill) => skill.id));
    const auditCompanions = auditSkillIds
      .map((id) => `audit-${id}`)
      .filter((id) => selectedIds.has(id));
    return {
      capped: false,
      verdict: { directive: buildFinishGateDirective(auditSkillIds, auditCompanions), stage: "audit" },
    };
  }
  if (intervention) {
    return { capped: false, verdict: { directive: intervention, stage: "intervention" } };
  }
  if (unverified.length) {
    const repeat = countDirectives(segment, FINISH_GATE_GROUNDING_DIRECTIVE_PREFIX) > 0;
    return {
      capped: false,
      verdict: { directive: buildGroundingDirective(unverified, repeat), stage: "grounding" },
    };
  }
  return { capped: false };
}
