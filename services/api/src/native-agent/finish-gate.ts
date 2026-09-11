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
 * Finish gate (phase IV, C2; phase V adds stage 2): a TurnLifecycle decorator
 * that intercepts the moment the model answers without tool calls.
 *
 * Stage 1 (C2): when the run carries a skill that declares a pre-finish audit
 * (frontmatter metadata.pre-finish-audit) and the trajectory shows no
 * review_checkpoint call yet, the gate injects a verification directive as a
 * user message and lets the loop take one more model turn instead of
 * completing.
 *
 * Stage 2 (V2-C3, groundedness enforcement): verbatim-intended quote spans
 * in the draft answer must carry a verification verdict from this run
 * (verify_citation call, or evidence_ledger add+verify). Unverified spans
 * trigger one more turn with a directive to verify or paraphrase-and-label —
 * OpenScholar-style mandatory citation verification as a hard pipeline
 * stage, skill-independent.
 *
 * Design notes (from the C4 evaluation, handoff 2026-09-11T0100):
 * - DA enforced this via skill frontmatter plus a separate audit subagent
 *   scored against a threshold. SD keeps the audit in the SAME run: the model
 *   audits against its own full trajectory, which is already in context —
 *   DA's audit read a truncated excerpt that was blind exactly where the
 *   decisive tool calls lived.
 * - Each stage fires at most once per run (this class is composed per run);
 *   the loop additionally caps continuations at MAX_FINISH_GATE_CONTINUATIONS
 *   (=2, exactly stage-1 + stage-2), so a misbehaving policy can never spin.
 * - The gate never blocks a finish: it can only ask for one extra turn per
 *   stage. The already-reviewed scan is bounded to the current run's segment
 *   (messages after the last genuine user input), so a fresh task in the same
 *   session gets its own audit while a resume of the audited run stays silent.
 */

import type {
  FinishGateDecision,
  ModelTurn,
  RuntimeMessage,
  TurnLifecycle,
} from "@sciencediscovery/runtime-core";

export const FINISH_GATE_REVIEW_TOOL = "review_checkpoint";

/** Tools whose call args count as quote-verification coverage (stage 2). */
const VERIFY_CITATION_TOOL = "verify_citation";
const EVIDENCE_LEDGER_TOOL = "evidence_ledger";

/** Prefix identifying gate-injected directives in history (role "user" but not user input). */
const DIRECTIVE_PREFIX = "Pre-finish verification required by skill";
/** Prefix identifying stage-2 grounding directives (also not user input). */
const GROUNDING_DIRECTIVE_PREFIX = "Pre-finish grounding enforcement:";

// --- Stage 2: groundedness enforcement (V2-C3) ------------------------------
// OpenScholar-style mandatory citation verification as a hard pipeline
// stage: verbatim-intended quote spans in the draft final answer must have a
// verification verdict from this run, or the gate asks for one (or an honest
// paraphrase-and-label) instead of letting the answer ship.
//
// Deliberate conventions and recorded false-positive surface (review P2/P3):
// - A blockquote line ("> …") counts as verbatim intent, so note/TL;DR style
//   callouts are also intercepted — the price is one extra turn; the
//   discipline pressure is intentional. Do not use blockquotes for asides.
// - An odd number of straight quotes (inch marks, unbalanced prose) can pair
//   narrative text into a pseudo-span — the directive lists candidates and
//   the model judges; cost stays one bounded turn.
// - A span quoting the USER's own words cannot verify against a KB; the
//   model should mark it as quoting the user (the directive's paraphrase
//   path covers this).

const MAX_SPANS_PER_AUDIT = 10;
const MAX_SPANS_IN_DIRECTIVE = 5;
const MIN_SPAN_CHARS = 30;
const MAX_SPAN_CHARS = 500;

/** Extract verbatim-intended quote spans from the draft final answer. */
export function extractQuotedSpans(text: string): string[] {
  const spans: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const span = raw.trim().replaceAll(/\s+/g, " ");
    if (span.length < MIN_SPAN_CHARS || span.length > MAX_SPAN_CHARS) return;
    // Require at least five words — codes, ids, and symbol runs are not quotes.
    if (span.split(" ").filter((word) => /[\p{L}\p{N}]/u.test(word)).length < 5) return;
    const key = normalizeForMatch(span);
    if (seen.has(key)) return;
    seen.add(key);
    spans.push(span);
  };
  // Paired quote marks (curly, straight, CJK corner brackets) — the content
  // excludes BOTH open and close marks so a straight quote cannot span
  // across a neighbouring quoted fragment.
  for (const match of text.matchAll(/[“"「]([^”"「“」]{30,500})[”"」]/gu)) push(match[1]!);
  // Blockquote lines.
  for (const match of text.matchAll(/^[ \t]*>[ \t]*(["“][^"”]{30,500}["”]|[^"”\n]{30,500})[ \t]*$/gmu)) {
    push(match[1]!.replace(/^["“]|["”]$/g, ""));
  }
  return spans.slice(0, MAX_SPANS_PER_AUDIT);
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replaceAll(/\s+/g, " ").trim();
}

interface ToolCallRecord { argsText: string; name: string }

/** Pull (name, raw-args) pairs out of assistant tool_calls in the run segment. */
function segmentToolCalls(segment: readonly { role?: string; tool_calls?: unknown }[]): ToolCallRecord[] {
  const calls: ToolCallRecord[] = [];
  for (const message of segment) {
    if (!Array.isArray(message.tool_calls)) continue;
    for (const raw of message.tool_calls) {
      if (!raw || typeof raw !== "object") continue;
      const fn = (raw as Record<string, unknown>).function;
      const fnRecord = fn && typeof fn === "object" ? fn as Record<string, unknown> : raw as Record<string, unknown>;
      const name = typeof fnRecord.name === "string" ? fnRecord.name : "";
      if (!name) continue;
      const args = fnRecord.arguments;
      calls.push({ argsText: typeof args === "string" ? args : JSON.stringify(args ?? {}), name });
    }
  }
  return calls;
}

/**
 * Spans in the draft that have no verification coverage in this run segment.
 * Coverage = a verify_citation call whose quote arg text contains the
 * normalized span (the model may verify a longer passage containing it), or
 * an evidence_ledger add recording the span as its quote plus any
 * evidence_ledger verify call this run. A span assembled from two
 * separately-verified fragments is intentionally NOT covered — a spliced
 * quote is not verbatim and belongs in paraphrase-and-label.
 */
export function findUnverifiedQuotes(
  segment: readonly { role?: string; tool_calls?: unknown }[],
  draftText: string,
): string[] {
  const spans = extractQuotedSpans(draftText);
  if (!spans.length) return [];
  const calls = segmentToolCalls(segment);
  const verifyArgs = calls
    .filter((call) => call.name === VERIFY_CITATION_TOOL)
    .map((call) => normalizeForMatch(call.argsText));
  const ledgerActions = calls
    .filter((call) => call.name === EVIDENCE_LEDGER_TOOL)
    .map((call) => {
      try { return JSON.parse(call.argsText) as { action?: string; quote?: unknown }; } catch { return undefined; }
    });
  const ledgerQuoteArgs = ledgerActions
    .filter((args) => args?.action === "add" && typeof args.quote === "string")
    .map((args) => normalizeForMatch(args!.quote as string));
  const ledgerVerified = ledgerActions.some((args) => args?.action === "verify");
  return spans.filter((span) => {
    const needle = normalizeForMatch(span);
    if (verifyArgs.some((args) => args.includes(needle))) return false;
    if (ledgerVerified && ledgerQuoteArgs.some((args) => args.includes(needle))) return false;
    return true;
  });
}

/** Stage-2 directive listing the unverified spans (bounded). */
export function buildGroundingDirective(unverified: readonly string[]): string {
  const listed = unverified.slice(0, MAX_SPANS_IN_DIRECTIVE)
    .map((span, index) => `  ${index + 1}. "${span.length > 80 ? `${span.slice(0, 80)}…` : span}"`)
    .join("\n");
  const extra = unverified.length > MAX_SPANS_IN_DIRECTIVE ? ` (and ${unverified.length - MAX_SPANS_IN_DIRECTIVE} more)` : "";
  return (
    `${GROUNDING_DIRECTIVE_PREFIX} your draft answer presents the following quoted spans as source text, ` +
    `but this run has no verification verdict for them:\n${listed}${extra}\n` +
    `For EACH span: call ${VERIFY_CITATION_TOOL} with the exact quote (or record it with evidence_ledger and run its verify action). ` +
    "A span that comes back verbatim may stay quoted; fuzzy or not-found means paraphrase it and label it as paraphrase — " +
    "do not present it as the source's words. Only then give your final answer."
  );
}

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
    if (!content.startsWith(DIRECTIVE_PREFIX) && !content.startsWith(GROUNDING_DIRECTIVE_PREFIX)) return i + 1;
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
  /**
   * Whether quote-verification tooling (verify_citation or evidence_ledger)
   * is registered in this run's registry. Stage 2 stays silent when absent
   * — directing the model at a nonexistent tool is worse than no gate.
   * Undefined is treated as available (unit-test convenience); the assembly
   * always passes the real detection.
   */
  quoteVerificationAvailable?: boolean;
  /** Test seam / protocol seam: build the injected user message. */
  createMessage?: (text: string) => M;
}

export function buildFinishGateDirective(skillIds: readonly string[], auditCompanionIds: readonly string[] = []): string {
  const auditLine = auditCompanionIds.length
    ? ` Skill-specific audit checklist${auditCompanionIds.length > 1 ? "s" : ""} selected for this run: read ${auditCompanionIds.map((id) => `\`${id}\``).join(", ")} with the read_skill tool and apply every applicable check as part of this audit.`
    : "";
  return (
    `${DIRECTIVE_PREFIX}${skillIds.length > 1 ? "s" : ""} ${skillIds.join(", ")}. ` +
    "Before concluding, audit your answer against the full trajectory above: " +
    "(1) every factual claim must trace to a tool result or a cited artifact — name the source for each; " +
    "(2) open questions you did not resolve must be stated explicitly, not silently dropped; " +
    "(3) budget or capability limits you hit must be disclosed; " +
    "(4) quotes presented as verbatim must have passed verification this run (verify_citation for knowledge-base content) — a failed or fuzzy check means paraphrase-and-label; " +
    "(5) if the tools and knowledge bases did not contain the answer, the answer must say so explicitly (and what was searched) rather than fill the gap from general model knowledge." +
    auditLine +
    " If the audit reveals gaps, fix them first. " +
    `Then call the ${FINISH_GATE_REVIEW_TOOL} tool with a one-line reason summarizing this audit. ` +
    "Only after that call should you give your final answer."
  );
}

export class FinishGateLifecycle<M extends RuntimeMessage, I, U> implements TurnLifecycle<M, I, U> {
  private auditFired = false;
  private groundingFired = false;
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
    const createMessage = this.options.createMessage ?? ((text: string) => ({ content: text, role: "user" }) as unknown as M);
    const segment = input.history.slice(currentRunSegmentStart(input.history));

    // Stage 1 — skill-declared audit (once per run): the model audits its
    // answer against its own trajectory, optionally guided by the selected
    // audit-<id> companion skill, and records review_checkpoint.
    if (!this.auditFired && this.options.reviewCheckpointAvailable) {
      const auditSkillIds = this.options.skills.filter((skill) => skill.preFinishAudit).map((skill) => skill.id);
      // Only this run's segment counts: a review in a previous run of the same
      // session fulfilled that run's duty, not this one's. (Note: the scan reads
      // the post-assembly history — compaction can prune an old review tool
      // result and re-fire the gate; the once-per-run latch bounds that to one
      // extra directive, which is acceptable.)
      const alreadyReviewed = segment.some(
        (message) => message.role === "tool" && message["name"] === FINISH_GATE_REVIEW_TOOL,
      );
      if (auditSkillIds.length && !alreadyReviewed) {
        this.auditFired = true;
        // Name the audit companions (`audit-<id>`) only when they are actually
        // selected for this run (auto-selected at run start when present in the
        // catalog); otherwise the generic checklist above carries the audit.
        const selectedIds = new Set(this.options.skills.map((skill) => skill.id));
        const auditCompanions = auditSkillIds
          .map((id) => `audit-${id}`)
          .filter((id) => selectedIds.has(id));
        return Promise.resolve({
          action: "continue",
          message: createMessage(buildFinishGateDirective(auditSkillIds, auditCompanions)),
        });
      }
    }

    // Stage 2 — groundedness enforcement (once per run, skill-independent):
    // verbatim-intended quotes in the draft answer must carry a verification
    // verdict from this run. The runtime's continuation cap (2) bounds
    // stage-1 + stage-2 together, so this can never spin. Silent when no
    // verification tool exists in this run's registry.
    if (!this.groundingFired && this.options.quoteVerificationAvailable !== false) {
      const draft = typeof input.modelTurn.assistantMessage?.content === "string"
        ? input.modelTurn.assistantMessage.content as string
        : "";
      const unverified = draft ? findUnverifiedQuotes(segment, draft) : [];
      if (unverified.length) {
        this.groundingFired = true;
        return Promise.resolve({
          action: "continue",
          message: createMessage(buildGroundingDirective(unverified)),
        });
      }
    }
    return Promise.resolve(undefined);
  }
}
