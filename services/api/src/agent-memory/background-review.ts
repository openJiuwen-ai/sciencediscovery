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
 * Background review (V3-C1, DeepAnalyze background-review port): after every
 * N completed runs, re-read the session transcript tail and extract reusable
 * experiential notes into agent-memory CANDIDATES. Everything lands with
 * provenance.requiresReview — only a human promote() lets a note reach the
 * system prompt as a verified rule.
 *
 * Ported semantics worth keeping:
 * - cadence with empty-streak backoff: threshold = nudgeInterval × 2^min(empty,2)
 * - drain-then-run: the counter is consumed BEFORE the review runs, so a slow
 *   review can never double-fire while completions keep arriving
 * - fail-open LLM errors: consume the threshold, do NOT count as empty
 * - content gate: notes must be non-trivial (≥5 chars, no "nothing learned"
 *   placeholders) — an uninformative batch counts as an empty review
 */

import type { ModelEndpoint } from "@sciencediscovery/model";
import type { AgentMemoryCategory } from "@sciencediscovery/schema";
import { AGENT_MEMORY_CATEGORIES } from "@sciencediscovery/schema";

import { callPipelineLlmJson, type PipelineInvoke } from "../knowledge-engine/llm.js";
import type { SessionStore } from "../store.js";

const META_KEY = "background_review_state";
const TRANSCRIPT_TAIL_CHARS = 24_000;
const MAX_NOTES_PER_REVIEW = 5;
const MAX_NOTE_CHARS = 200;
const LLM_TIMEOUT_MS = 120_000;
/** Placeholder phrases that mean "nothing learned" — gated out (DA parity). */
const EMPTY_NOTE_PATTERNS = ["信息不足", "无可复用", "没有可复用", "无新经验", "没有新经验"];

interface BackgroundReviewState {
  runsSinceLastReview: number;
  consecutiveEmpty: number;
  lastReviewAt: string | null;
}

const INITIAL_STATE: BackgroundReviewState = {
  runsSinceLastReview: 0,
  consecutiveEmpty: 0,
  lastReviewAt: null,
};

const SYSTEM_PROMPT = "你是 agent 经验提取器。从对话中提取可复用的工作经验，只输出 JSON。";

function buildReviewPrompt(transcript: string): string {
  return [
    "以下是一段科研 agent 与用户的对话尾部。请提取 agent 在工作中展现出的、对未来任务可复用的经验。",
    "",
    "类别（四类，可多类混合）：",
    "- tool_technique：工具使用技巧（哪个工具适合什么、参数怎么给、踩过的坑）",
    "- workflow：工作流经验（哪类任务按什么顺序做效果好）",
    "- convention：用户/项目惯例（命名、格式、偏好）",
    "- lesson_learned：教训（什么做法失败了、为什么、以后怎么避免）",
    "",
    `要求：每条自包含、不超过 ${MAX_NOTE_CHARS} 字、最多 ${MAX_NOTES_PER_REVIEW} 条；只提取对话中真实发生的经验，不要编造；没有可提取的就返回空数组。`,
    '输出 JSON：{"notes": [{"category": "tool_technique|workflow|convention|lesson_learned", "content": "..."}]}',
    "",
    "对话：",
    transcript,
  ].join("\n");
}

interface ExtractedNote {
  category: AgentMemoryCategory;
  content: string;
}

/** Parse + gate the LLM's note list. Exported for tests. */
export function gateExtractedNotes(raw: unknown): ExtractedNote[] {
  const notes = (raw as { notes?: unknown })?.notes;
  if (!Array.isArray(notes)) return [];
  const accepted: ExtractedNote[] = [];
  for (const note of notes.slice(0, MAX_NOTES_PER_REVIEW)) {
    const category = (note as { category?: unknown })?.category;
    const content = (note as { content?: unknown })?.content;
    if (typeof content !== "string") continue;
    const trimmed = content.trim();
    if (trimmed.length < 5) continue;
    if (EMPTY_NOTE_PATTERNS.some((pattern) => trimmed.includes(pattern))) continue;
    if (!AGENT_MEMORY_CATEGORIES.includes(category as AgentMemoryCategory)) continue;
    accepted.push({ category: category as AgentMemoryCategory, content: trimmed.slice(0, MAX_NOTE_CHARS * 2) });
  }
  return accepted;
}

export interface BackgroundReviewDeps {
  store: SessionStore;
  /** Global default task model endpoint (same source as KE extraction). */
  resolveEndpoint: () => ModelEndpoint | undefined;
  /** Runtime gate — the layered agentMemoryBackgroundReview setting,
   *  resolved for the completing session (global → project → session). */
  enabled: (sessionId: string) => boolean;
  nudgeInterval?: number;
  invoke?: PipelineInvoke;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export class BackgroundReviewManager {
  private readonly nudgeInterval: number;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: BackgroundReviewDeps) {
    this.nudgeInterval = Math.max(1, deps.nudgeInterval ?? 10);
  }

  private state(): BackgroundReviewState {
    return { ...INITIAL_STATE, ...(this.deps.store.getAgentMemoryMeta<Partial<BackgroundReviewState>>(META_KEY) ?? {}) };
  }

  private saveState(state: BackgroundReviewState): void {
    this.deps.store.setAgentMemoryMeta(META_KEY, state);
  }

  /** Fire-and-forget hook on run completion. Cadence counting happens even
   *  when the review itself is gated off — enabling the setting later starts
   *  with a warm counter, matching DA's behavior. */
  recordCompletedRun(sessionId: string): void {
    const state = this.state();
    state.runsSinceLastReview += 1;
    const threshold = this.nudgeInterval * 2 ** Math.min(state.consecutiveEmpty, 2);
    // A review already running must NOT drain the slot (review P2): the
    // completions keep counting toward the next threshold instead.
    if (state.runsSinceLastReview < threshold || !this.deps.enabled(sessionId) || this.inFlight) {
      this.saveState(state);
      return;
    }
    // Drain before running: a slow review can never double-fire.
    state.runsSinceLastReview = 0;
    this.saveState(state);
    this.inFlight = this.review(sessionId)
      .catch((error: unknown) => {
        // Fail-open: the threshold is already consumed; an LLM outage costs
        // one review slot and nothing else.
        this.deps.log?.("background_review_failed", { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        this.inFlight = null;
      });
  }

  private async review(sessionId: string): Promise<void> {
    const endpoint = this.deps.resolveEndpoint();
    if (!endpoint) return;
    const messages = await this.deps.store.readMessages(sessionId);
    const transcript = transcriptTail(messages, TRANSCRIPT_TAIL_CHARS);
    if (!transcript) return;
    const raw = await callPipelineLlmJson<{ notes?: unknown }>(
      {
        endpoint,
        maxTokens: 4_096,
        requestTimeoutMs: LLM_TIMEOUT_MS,
        ...(this.deps.invoke ? { invoke: this.deps.invoke } : {}),
      },
      SYSTEM_PROMPT,
      buildReviewPrompt(transcript),
      AbortSignal.timeout(LLM_TIMEOUT_MS),
    );
    const notes = gateExtractedNotes(raw);
    const state = this.state();
    state.lastReviewAt = new Date().toISOString();
    if (!notes.length) {
      state.consecutiveEmpty += 1;
      this.saveState(state);
      return;
    }
    let added = 0;
    for (const note of notes) {
      const entry = this.deps.store.addAgentMemory({
        category: note.category,
        content: note.content,
        source: "background_review",
        provenance: { kind: "background_review", requiresReview: true, source: sessionId },
      });
      if (entry) added += 1;
    }
    // A batch that fully deduped against existing notes is an empty review
    // semantically (review P2): only genuinely new notes reset the streak.
    state.consecutiveEmpty = added > 0 ? 0 : state.consecutiveEmpty + 1;
    this.saveState(state);
    this.deps.log?.("background_review_extracted", { added, sessionId, total: notes.length });
  }
}

/** Render the session transcript tail within a character budget. */
export function transcriptTail(
  messages: ReadonlyArray<{ content?: unknown; role?: unknown }>,
  budgetChars: number,
): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (typeof message.content !== "string" || !message.content.trim()) continue;
    const role = typeof message.role === "string" ? message.role : "?";
    lines.push(`[${role}] ${message.content}`);
  }
  let joined = lines.join("\n");
  if (joined.length > budgetChars) joined = joined.slice(joined.length - budgetChars);
  return joined;
}
