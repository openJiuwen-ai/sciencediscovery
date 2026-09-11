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
 * Finish gate (phase IV, C2): a TurnLifecycle decorator that intercepts the
 * moment the model answers without tool calls. When the run carries a skill
 * that declares a pre-finish audit (frontmatter metadata.pre-finish-audit)
 * and the trajectory shows no review_checkpoint call yet, the gate injects a
 * verification directive as a user message and lets the loop take one more
 * model turn instead of completing.
 *
 * Design notes (from the C4 evaluation, handoff 2026-09-11T0100):
 * - DA enforced this via skill frontmatter plus a separate audit subagent
 *   scored against a threshold. SD keeps the audit in the SAME run: the model
 *   audits against its own full trajectory, which is already in context —
 *   DA's audit read a truncated excerpt that was blind exactly where the
 *   decisive tool calls lived.
 * - The gate fires at most once per run (this class is composed per run); the
 *   loop additionally caps continuations at MAX_FINISH_GATE_CONTINUATIONS, so
 *   a misbehaving policy can never spin.
 * - The gate never blocks a finish: it can only ask for one extra turn. The
 *   already-reviewed scan is bounded to the current run's segment (messages
 *   after the last genuine user input), so a fresh task in the same session
 *   gets its own audit while a resume of the audited run stays silent.
 */

import type {
  FinishGateDecision,
  ModelTurn,
  RuntimeMessage,
  TurnLifecycle,
} from "@sciencediscovery/runtime-core";

export const FINISH_GATE_REVIEW_TOOL = "review_checkpoint";

/** Prefix identifying gate-injected directives in history (role "user" but not user input). */
const DIRECTIVE_PREFIX = "Pre-finish verification required by skill";

/**
 * Index just past the last genuine user message — the current run's segment.
 * Session history spans runs: a review_checkpoint from a PREVIOUS run must not
 * satisfy this run's audit duty, so the scan is bounded to the segment after
 * the last user message that is not itself a gate directive.
 */
function currentRunSegmentStart(history: readonly { role?: string; content?: unknown }[]): number {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!;
    if (message.role !== "user") continue;
    const content = typeof message.content === "string" ? message.content : "";
    if (!content.startsWith(DIRECTIVE_PREFIX)) return i + 1;
  }
  return 0;
}

export interface FinishGateSkill {
  id: string;
  preFinishAudit?: boolean;
}

export interface FinishGateLifecycleOptions<M extends RuntimeMessage, I, U> {
  /** Inner lifecycle (version recorder); its methods are always delegated. */
  inner?: TurnLifecycle<M, I, U>;
  /** Skills active for this run. */
  skills: readonly FinishGateSkill[];
  /** Whether the review tool is registered in this run's tool registry. */
  reviewCheckpointAvailable: boolean;
  /** Test seam / protocol seam: build the injected user message. */
  createMessage?: (text: string) => M;
}

export function buildFinishGateDirective(skillIds: readonly string[]): string {
  return (
    `${DIRECTIVE_PREFIX}${skillIds.length > 1 ? "s" : ""} ${skillIds.join(", ")}. ` +
    "Before concluding, audit your answer against the full trajectory above: " +
    "(1) every factual claim must trace to a tool result or a cited artifact — name the source for each; " +
    "(2) open questions you did not resolve must be stated explicitly, not silently dropped; " +
    "(3) budget or capability limits you hit must be disclosed. " +
    "If the audit reveals gaps, fix them first. " +
    `Then call the ${FINISH_GATE_REVIEW_TOOL} tool with a one-line reason summarizing this audit. ` +
    "Only after that call should you give your final answer."
  );
}

export class FinishGateLifecycle<M extends RuntimeMessage, I, U> implements TurnLifecycle<M, I, U> {
  private fired = false;
  private readonly options: FinishGateLifecycleOptions<M, I, U>;

  constructor(options: FinishGateLifecycleOptions<M, I, U>) {
    this.options = options;
  }

  beforeTurn(input: { turn: number; history: M[] }): Promise<void> {
    return this.options.inner?.beforeTurn(input) ?? Promise.resolve();
  }

  afterAssembly(input: Parameters<NonNullable<TurnLifecycle<M, I, U>["afterAssembly"]>>[0]): Promise<void> {
    return this.options.inner?.afterAssembly(input) ?? Promise.resolve();
  }

  afterTurn(input: Parameters<TurnLifecycle<M, I, U>["afterTurn"]>[0]): Promise<void> {
    return this.options.inner?.afterTurn(input) ?? Promise.resolve();
  }

  beforeFinish(input: { turn: number; history: M[]; modelTurn: ModelTurn<M, U> }): Promise<FinishGateDecision<M> | undefined> {
    if (this.fired || !this.options.reviewCheckpointAvailable) return Promise.resolve(undefined);
    const auditSkillIds = this.options.skills.filter((skill) => skill.preFinishAudit).map((skill) => skill.id);
    if (auditSkillIds.length === 0) return Promise.resolve(undefined);
    // Only this run's segment counts: a review in a previous run of the same
    // session fulfilled that run's duty, not this one's. (Note: the scan reads
    // the post-assembly history — compaction can prune an old review tool
    // result and re-fire the gate; the once-per-run latch bounds that to one
    // extra directive, which is acceptable.)
    const segment = input.history.slice(currentRunSegmentStart(input.history));
    const alreadyReviewed = segment.some(
      (message) => message.role === "tool" && message["name"] === FINISH_GATE_REVIEW_TOOL,
    );
    if (alreadyReviewed) return Promise.resolve(undefined);
    this.fired = true;
    const createMessage = this.options.createMessage ?? ((text: string) => ({ content: text, role: "user" }) as unknown as M);
    return Promise.resolve({
      action: "continue",
      message: createMessage(buildFinishGateDirective(auditSkillIds)),
    });
  }
}
