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
 * in the draft answer must carry a PASSING verification verdict from this
 * run's tool RESULTS (verify_citation, or evidence_ledger add+verify).
 * Coverage is result-aware: a call alone is not coverage, and a fuzzy or
 * not-found outcome is a verdict the model must act on (paraphrase-and-
 * label), never a pass. Uncovered spans trigger another turn with a
 * directive to verify or paraphrase-and-label — OpenScholar-style mandatory
 * citation verification as a hard pipeline stage, skill-independent.
 *
 * Design notes (from the C4 evaluation, handoff 2026-09-11T0100):
 * - DA enforced this via skill frontmatter plus a separate audit subagent
 *   scored against a threshold. SD keeps the audit in the SAME run: the model
 *   audits against its own full trajectory, which is already in context —
 *   DA's audit read a truncated excerpt that was blind exactly where the
 *   decisive tool calls lived.
 * - Stages 1 and 1.5 fire at most once per run (this class is composed per
 *   run). Stage 2 re-fires on EVERY finish attempt that still ships uncovered
 *   spans — a model that ignores the grounding directive must not be able to
 *   wait the gate out; the loop caps continuations at
 *   MAX_FINISH_GATE_CONTINUATIONS (=3) and reports a capped gate as a denied
 *   finish_gate event, so a misbehaving policy can never spin and can never
 *   ship unverified quotes silently.
 * - The gate never blocks a finish on its own: it asks for extra turns
 *   (stage 2 repeatedly while uncovered spans remain). The already-reviewed
 *   scan is bounded to the current run's segment
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
/** Prefix identifying stage-1.5 intervention directives (also not user input). */
const INTERVENTION_DIRECTIVE_PREFIX = "Pre-finish termination intervention:";

/**
 * All gate-directive prefixes. The post-run evaluator
 * (runs/finish-gate-followup.ts) uses them to recognize gate-injected user
 * messages in the DURABLE transcript — under the JiuwenSwarm executor the
 * directives are persisted as continuation-run prompts, while on the native
 * executor they survive inside the assistant message's modelContext. Either
 * way the prefixes are the canonical marker that a "user" message is not
 * user input, and the shared continuation cap counts them.
 */
export const FINISH_GATE_AUDIT_DIRECTIVE_PREFIX = DIRECTIVE_PREFIX;
export const FINISH_GATE_GROUNDING_DIRECTIVE_PREFIX = GROUNDING_DIRECTIVE_PREFIX;
export const FINISH_GATE_INTERVENTION_DIRECTIVE_PREFIX = INTERVENTION_DIRECTIVE_PREFIX;
export const FINISH_GATE_DIRECTIVE_PREFIXES: readonly string[] = [
  DIRECTIVE_PREFIX,
  GROUNDING_DIRECTIVE_PREFIX,
  INTERVENTION_DIRECTIVE_PREFIX,
];

/** Whether a user-role message content is a gate directive rather than user input. */
export function isFinishGateDirective(content: unknown): boolean {
  return typeof content === "string"
    && FINISH_GATE_DIRECTIVE_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * Deterministic termination-intervention detection (V2-C6 — SA
 * termination-interventions.ts adapted): catches premature finishes the
 * audit and grounding stages do not cover. Evaluated in order; the first
 * hit wins. Returns the directive text, or undefined when the finish is clean.
 */
export function detectTerminationIntervention(input: {
  assistantContents: readonly string[];
  draftText: string;
  pendingPlanItems?: readonly { id: string; text: string }[];
}): string | undefined {
  const { assistantContents, draftText, pendingPlanItems } = input;
  // Thinking-only / empty turn: reasoning streamed but no answer text.
  if (!draftText.trim()) {
    return (
      `${INTERVENTION_DIRECTIVE_PREFIX} your last turn produced reasoning but no answer text. ` +
      "Write the actual answer now, or take a concrete action — do not end the run on an empty turn."
    );
  }
  // Degenerate repetition: the same assistant text three turns in a row.
  const normalize = (text: string) => text.replaceAll(/\s+/g, " ").trim();
  const draft = normalize(draftText);
  if (draft && assistantContents.length >= 2
    && normalize(assistantContents[assistantContents.length - 1]!) === draft
    && normalize(assistantContents[assistantContents.length - 2]!) === draft) {
    return (
      `${INTERVENTION_DIRECTIVE_PREFIX} you have produced the same answer text three turns in a row — the loop is degenerate. ` +
      "Change the approach now: use a different tool, a different angle, or state plainly what is blocking you. Do not repeat the same text again."
    );
  }
  // Plan-not-execute: research_state has unfinished plan items.
  if (pendingPlanItems?.length) {
    const listed = pendingPlanItems.slice(0, 3).map((item) => `${item.id} "${item.text.length > 60 ? `${item.text.slice(0, 60)}…` : item.text}"`).join(", ");
    const extra = pendingPlanItems.length > 3 ? ` and ${pendingPlanItems.length - 3} more` : "";
    return (
      `${INTERVENTION_DIRECTIVE_PREFIX} your research plan (research_state) still has ${pendingPlanItems.length} unfinished item${pendingPlanItems.length > 1 ? "s" : ""}: ${listed}${extra}. ` +
      "Execute them now, or update them to done/dropped with a one-line reason via research_state plan-update — do not silently abandon planned work. " +
      "If they are genuinely out of scope for the answer, say so explicitly in the answer."
    );
  }
  return undefined;
}

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

interface ToolCallRecord { argsText: string; name: string; id?: string; resultText?: string }

/** Segment message shape the coverage scan reads (assistant calls + tool results). */
type SegmentMessage = { role?: string; tool_calls?: unknown; name?: unknown; content?: unknown; tool_call_id?: unknown };

/**
 * Pull (name, raw-args, paired result) records out of the run segment.
 * Results are matched by tool_call_id when present; id-less result messages
 * (some transports strip the id) pair with the first same-name call that has
 * no result yet. A call with no paired result keeps resultText undefined —
 * downstream coverage treats that as fail-closed.
 */
function segmentToolCalls(segment: readonly SegmentMessage[]): ToolCallRecord[] {
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
      const rawId = (raw as Record<string, unknown>).id;
      calls.push({
        argsText: typeof args === "string" ? args : JSON.stringify(args ?? {}),
        id: typeof rawId === "string" ? rawId : undefined,
        name,
      });
    }
  }
  const nextByName = new Map<string, number>();
  for (const message of segment) {
    if (message.role !== "tool") continue;
    const name = typeof message.name === "string" ? message.name : "";
    const callId = typeof message.tool_call_id === "string" ? message.tool_call_id : undefined;
    if (!name && !callId) continue;
    const content = typeof message.content === "string" ? message.content : undefined;
    let target: ToolCallRecord | undefined;
    if (callId) {
      target = calls.find((call) => call.id === callId);
    } else {
      for (let i = nextByName.get(name) ?? 0; i < calls.length; i += 1) {
        if (calls[i]!.name === name && calls[i]!.resultText === undefined) {
          nextByName.set(name, i + 1);
          target = calls[i]!;
          break;
        }
      }
    }
    if (target && target.resultText === undefined) target.resultText = content ?? "";
  }
  return calls;
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * States that count as verification coverage. Verbatim always passes; fuzzy
 * only under an explicit policy (default: fuzzy means the span is a
 * paraphrase and must not be presented as a quote).
 */
function isCoveringState(state: unknown, allowFuzzy: boolean): boolean {
  return state === "verbatim" || (allowFuzzy && state === "fuzzy");
}

/**
 * Spans in the draft that have no PASSING verification verdict in this run
 * segment. Coverage = a verify_citation call whose quote arg text contains
 * the normalized span (the model may verify a longer passage containing it)
 * AND whose paired tool result carries a covering state, or an
 * evidence_ledger add recording the span as its quote plus a verify action
 * whose RESULT carries a covering verdict for that entry. A call without a
 * result, a not-found verdict, and (by default) a fuzzy verdict are all NOT
 * coverage — they are verdicts the model must act on. A span assembled from
 * two separately-verified fragments is intentionally NOT covered — a
 * spliced quote is not verbatim and belongs in paraphrase-and-label.
 */
export function findUnverifiedQuotes(
  segment: readonly SegmentMessage[],
  draftText: string,
  options: { allowFuzzy?: boolean } = {},
): string[] {
  const spans = extractQuotedSpans(draftText);
  if (!spans.length) return [];
  const allowFuzzy = options.allowFuzzy === true;
  const calls = segmentToolCalls(segment);

  const verifyRecords = calls
    .filter((call) => call.name === VERIFY_CITATION_TOOL)
    .map((call) => {
      const verdict = parseJsonObject(call.resultText);
      return { argsNeedle: normalizeForMatch(call.argsText), state: verdict?.state };
    });

  const ledgerVerdicts = new Map<string, unknown>();
  const ledgerAdds: Array<{ argsNeedle: string; entryId?: string }> = [];
  for (const call of calls) {
    if (call.name !== EVIDENCE_LEDGER_TOOL) continue;
    const args = parseJsonObject(call.argsText);
    const result = parseJsonObject(call.resultText);
    if (args?.action === "add" && typeof args.quote === "string") {
      const entry = result?.entry;
      ledgerAdds.push({
        argsNeedle: normalizeForMatch(args.quote),
        entryId: entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).id === "string"
          ? (entry as Record<string, unknown>).id as string
          : undefined,
      });
    }
    if (args?.action === "verify" && Array.isArray(result?.results)) {
      for (const row of result.results as unknown[]) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        if (typeof record.id === "string") ledgerVerdicts.set(record.id, record.state);
      }
    }
  }

  return spans.filter((span) => {
    const needle = normalizeForMatch(span);
    if (verifyRecords.some((record) => record.argsNeedle.includes(needle) && isCoveringState(record.state, allowFuzzy))) return false;
    if (ledgerAdds.some((add) =>
      add.entryId !== undefined
      && add.argsNeedle.includes(needle)
      && isCoveringState(ledgerVerdicts.get(add.entryId), allowFuzzy))) return false;
    return true;
  });
}

/** Stage-2 directive listing the unverified spans (bounded). */
export function buildGroundingDirective(unverified: readonly string[], repeat = false): string {
  const listed = unverified.slice(0, MAX_SPANS_IN_DIRECTIVE)
    .map((span, index) => `  ${index + 1}. "${span.length > 80 ? `${span.slice(0, 80)}…` : span}"`)
    .join("\n");
  const extra = unverified.length > MAX_SPANS_IN_DIRECTIVE ? ` (and ${unverified.length - MAX_SPANS_IN_DIRECTIVE} more)` : "";
  const escalation = repeat
    ? "\nThese spans were already flagged in an earlier finish attempt of this run. A verbatim quote may appear ONLY with a passing verdict recorded in this run; every other span MUST be paraphrased and labeled as paraphrase. The run cannot complete while unverified quotes remain in the answer."
    : "";
  return (
    `${GROUNDING_DIRECTIVE_PREFIX} your draft answer presents the following quoted spans as source text, ` +
    `but this run has no passing verification verdict for them:\n${listed}${extra}\n` +
    `For EACH span: call ${VERIFY_CITATION_TOOL} with the exact quote (or record it with evidence_ledger and run its verify action). ` +
    "A span that comes back verbatim may stay quoted; fuzzy or not-found means paraphrase it and label it as paraphrase — " +
    "do not present it as the source's words. Only then give your final answer." +
    escalation
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
    if (!isFinishGateDirective(message.content)) return i + 1;
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
  /**
   * Whether a fuzzy verify_citation verdict counts as coverage for a quoted
   * span. Default "verbatim-only": the stage-2 directive tells the model a
   * fuzzy outcome means paraphrase-and-label, so the gate must hold that
   * line too. "allow-fuzzy" is an explicit operator policy for runs where
   * near-verbatim quoting is acceptable.
   */
  fuzzyQuoteCoverage?: "verbatim-only" | "allow-fuzzy";
  /**
   * Deterministic plan-pending probe (V2-C6): returns the run's unfinished
   * research_state plan items (pending/in_progress, capped), or undefined
   * when none. The assembly wires it to the workspace research-state file.
   */
  pendingPlanItems?: () => Promise<Array<{ id: string; text: string }> | undefined>;
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
  private groundingDirectives = 0;
  private interventionFired = false;
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

  async beforeFinish(input: { turn: number; history: M[]; modelTurn: ModelTurn<M, U> }): Promise<FinishGateDecision<M> | undefined> {
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

    // Stage 1.5 — deterministic termination interventions (once per run):
    // empty turns, degenerate repetition, and plan-not-execute — premature
    // finishes the audit and grounding stages do not cover.
    if (!this.interventionFired) {
      const draft = typeof input.modelTurn.assistantMessage?.content === "string"
        ? input.modelTurn.assistantMessage.content as string
        : "";
      const assistantContents = segment
        .filter((message) => message.role === "assistant" && typeof message.content === "string")
        .map((message) => message.content as string)
        // The current draft is the last assistant message in history — the
        // repetition check compares against the turns BEFORE it.
        .slice(0, -1);
      // A throwing probe must never kill the run — degrade to no plan data.
      const pendingPlanItems = this.options.pendingPlanItems
        ? await this.options.pendingPlanItems().catch(() => undefined)
        : undefined;
      const intervention = detectTerminationIntervention({
        assistantContents,
        draftText: draft,
        ...(pendingPlanItems ? { pendingPlanItems } : {}),
      });
      if (intervention) {
        this.interventionFired = true;
        return Promise.resolve({ action: "continue", message: createMessage(intervention) });
      }
    }

    // Stage 2 — groundedness enforcement (skill-independent): verbatim-intended
    // quotes in the draft answer must carry a PASSING verification verdict
    // from this run's tool results. No one-shot latch: every finish attempt
    // that still ships uncovered spans re-fires (with an escalating
    // directive), so a model cannot wait the gate out — the runtime's
    // continuation cap (3) bounds the retries and reports the final capped
    // attempt as a denied finish_gate event. Silent when no verification
    // tool exists in this run's registry.
    if (this.options.quoteVerificationAvailable !== false) {
      const draft = typeof input.modelTurn.assistantMessage?.content === "string"
        ? input.modelTurn.assistantMessage.content as string
        : "";
      const unverified = draft
        ? findUnverifiedQuotes(segment, draft, { allowFuzzy: this.options.fuzzyQuoteCoverage === "allow-fuzzy" })
        : [];
      if (unverified.length) {
        this.groundingDirectives += 1;
        return Promise.resolve({
          action: "continue",
          message: createMessage(buildGroundingDirective(unverified, this.groundingDirectives > 1)),
        });
      }
    }
    return Promise.resolve(undefined);
  }
}
