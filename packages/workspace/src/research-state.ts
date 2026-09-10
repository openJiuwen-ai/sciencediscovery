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
 * C1 research state — a per-workspace JSON "world model" for long-horizon
 * research runs (ported from DeepAnalyze research-state.ts, Kosmos-inspired):
 *   - goal pinning (the research objective, survives context compaction on disk)
 *   - plan items with status lifecycle (pending → in_progress → done|dropped)
 *   - open questions with resolution lifecycle (open → answered|dropped)
 *   - ruled-out paths (what was tried and rejected, with reasons — the
 *     anti-resurrection mechanism for dead branches)
 *   - tried-action dedup index (hash of normalized action text — callers check
 *     before re-running an action)
 * What counts as a plan step / question / rejection, when to update statuses,
 * and what granularity of action to record are policy and belong to skills;
 * this module owns structure only.
 *
 * Storage: {workspaceRoot}/.research/state.json — plain JSON a human can
 * audit. Fail-soft: a corrupt or unreadable file degrades to an empty state,
 * never a crashed turn. Writes go through a tmp+rename so a crash mid-write
 * cannot leave a torn file. Read-modify-write is not mutex-protected: tool
 * calls within a turn serialize, but concurrent sub-agent writes to the same
 * workspace can lose an update (last writer wins) — recorded limitation, same
 * trade-off as ke-evidence-ledger.ts.
 *
 * Deliberate divergences from the DA original:
 *   - ids are sequential per collection (p1/q1/r1…) instead of UUIDs —
 *     deterministic, shorter, and friendlier for the ref-by-substring lookup.
 *   - ruledOut / triedActions caps evict the oldest entry (and report it)
 *     instead of erroring forever: DA's hard cap dead-ends a session because
 *     the tool surface has no delete action.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const RESEARCH_STATE_MAX_PLAN_ITEMS = 50;
export const RESEARCH_STATE_MAX_OPEN_QUESTIONS = 100;
export const RESEARCH_STATE_MAX_RULED_OUT = 200;
export const RESEARCH_STATE_MAX_TRIED_ACTIONS = 1000;
export const RESEARCH_STATE_MAX_GOAL_CHARS = 1000;
export const RESEARCH_STATE_MAX_TEXT_CHARS = 1000;
export const RESEARCH_STATE_MAX_REASON_CHARS = 500;

export type ResearchPlanStatus = "pending" | "in_progress" | "done" | "dropped";
export type ResearchQuestionStatus = "open" | "answered" | "dropped";

export interface ResearchPlanItem {
  id: string;
  text: string;
  status: ResearchPlanStatus;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchOpenQuestion {
  id: string;
  text: string;
  status: ResearchQuestionStatus;
  answer?: string;
  note?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface ResearchRuledOutPath {
  id: string;
  /** What was considered and rejected. */
  what: string;
  /** Why it was ruled out (evidence/reasoning pointer). */
  why: string;
  source?: string;
  createdAt: string;
}

export interface ResearchTriedAction {
  /** Dedup key: md5 of normalized action text. */
  hash: string;
  summary: string;
  tool?: string;
  /** Outcome in one line (what was learned / found nothing). */
  result?: string;
  /** How many times this action was (re-)recorded. */
  count: number;
  createdAt: string;
  lastTriedAt: string;
}

interface ResearchStateFile {
  version: 1;
  goal?: string;
  goalSetAt?: string;
  plan: ResearchPlanItem[];
  openQuestions: ResearchOpenQuestion[];
  ruledOut: ResearchRuledOutPath[];
  triedActions: ResearchTriedAction[];
  lastUpdated: string;
}

export function researchStatePath(workspaceRoot: string): string {
  return resolve(workspaceRoot, ".research", "state.json");
}

function emptyState(): ResearchStateFile {
  return {
    version: 1,
    plan: [],
    openQuestions: [],
    ruledOut: [],
    triedActions: [],
    // Epoch placeholder: a never-written state has no meaningful timestamp,
    // and emptyState is module-level so it cannot use the injected clock.
    // The first real write replaces it.
    lastUpdated: new Date(0).toISOString(),
  };
}

/** Read without locking; missing/corrupt file yields an empty state. Never throws. */
async function readState(
  path: string,
): Promise<{ state: ResearchStateFile; corrupt: boolean }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    // Missing file is a fresh start; an unreadable one is corrupt.
    return { state: emptyState(), corrupt: (err as NodeJS.ErrnoException).code !== "ENOENT" };
  }
  try {
    const parsed = JSON.parse(text) as Partial<ResearchStateFile>;
    if (
      !parsed
      || !Array.isArray(parsed.plan)
      || !Array.isArray(parsed.openQuestions)
      || !Array.isArray(parsed.ruledOut)
      || !Array.isArray(parsed.triedActions)
    ) {
      return { state: emptyState(), corrupt: true };
    }
    // Sanitize per element, not just per collection: a torn/hand-edited file
    // with e.g. `plan: [null]` would otherwise pass the shape check and then
    // crash every subsequent op on property access (same convention as
    // ke-evidence-ledger.ts readLedger).
    const state = parsed as ResearchStateFile;
    const before =
      state.plan.length + state.openQuestions.length + state.ruledOut.length + state.triedActions.length;
    state.plan = state.plan.filter((item) => item && typeof item.id === "string" && typeof item.text === "string");
    state.openQuestions = state.openQuestions.filter(
      (question) => question && typeof question.id === "string" && typeof question.text === "string",
    );
    state.ruledOut = state.ruledOut.filter(
      (ruledOut) => ruledOut && typeof ruledOut.id === "string" && typeof ruledOut.what === "string",
    );
    state.triedActions = state.triedActions.filter(
      (tried) => tried && typeof tried.hash === "string" && typeof tried.summary === "string",
    );
    const after =
      state.plan.length + state.openQuestions.length + state.ruledOut.length + state.triedActions.length;
    return { state, corrupt: after !== before };
  } catch {
    return { state: emptyState(), corrupt: true };
  }
}

/** tmp+rename so a crash mid-write never leaves a torn state file. */
async function writeState(path: string, state: ResearchStateFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

function clip(text: string, max: number, label: string, truncated: string[]): string {
  if (text.length <= max) return text;
  truncated.push(label);
  return `${text.slice(0, max)}…[truncated]`;
}

function normalizeActionText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function hashResearchAction(text: string): string {
  return createHash("md5").update(normalizeActionText(text)).digest("hex").slice(0, 16);
}

function nextId(items: readonly { id: string }[], prefix: string): string {
  const max = items.reduce((acc, item) => {
    const parsed = Number(item.id.slice(prefix.length));
    return Number.isInteger(parsed) ? Math.max(acc, parsed) : acc;
  }, 0);
  return `${prefix}${max + 1}`;
}

/** Resolve a reference by exact id or unique case-insensitive text substring. */
function findByRef<T extends { id: string; text?: string; what?: string }>(
  items: readonly T[],
  ref: string,
  kind: string,
): T {
  const byId = items.find((item) => item.id === ref);
  if (byId) return byId;
  const needle = ref.toLowerCase();
  // An empty needle would substring-match every entry — refuse instead.
  if (!needle) throw new Error(`${kind} ref must be a non-empty id or unique text substring.`);
  const textOf = (item: T) => item.text ?? item.what ?? "";
  const matches = items.filter((item) => textOf(item).toLowerCase().includes(needle));
  const labelOf = (item: T) => `${textOf(item).slice(0, 30)}(${item.id})`;
  if (matches.length === 0) {
    const examples = items.slice(0, 5).map(labelOf).join(", ") || "(empty)";
    throw new Error(`${kind} "${ref}" matched nothing. Existing entries: ${examples}`);
  }
  if (matches.length > 1) {
    const candidates = matches.slice(0, 5).map(labelOf).join(", ");
    throw new Error(`${kind} "${ref}" matched ${matches.length} entries; use an exact id: ${candidates}`);
  }
  return matches[0]!;
}

export interface ResearchMarkTriedResult {
  alreadyTried: boolean;
  count: number;
  actionId: string;
  /** Present when alreadyTried — the recorded outcome of the first try. */
  previousResult?: string;
  previousTool?: string;
  firstTriedAt?: string;
  truncated: string[];
}

export interface ResearchSummary {
  goal?: string;
  goalSetAt?: string;
  plan: { total: number; pending: number; inProgress: number; done: number; dropped: number };
  currentItems: Array<{ id: string; text: string }>;
  openQuestions: { total: number; open: number; answered: number; dropped: number };
  /** Oldest still-open questions first, up to 10. */
  topOpenQuestions: Array<{ id: string; text: string }>;
  ruledOut: { total: number; recent: Array<{ id: string; what: string; why: string }> };
  triedActions: { total: number; repeated: number };
  lastUpdated: string;
  corrupt: boolean;
}

export interface ResearchStatePort {
  setGoal(input: { workspaceRoot: string; goal: string }): Promise<{ goal: string; updated: boolean; truncated: string[] }>;
  addPlanItems(input: { workspaceRoot: string; items: string[] }): Promise<{ added: string[]; total: number; truncated: string[] }>;
  updatePlanItem(input: {
    workspaceRoot: string;
    ref: string;
    status: ResearchPlanStatus;
    note?: string;
  }): Promise<{ itemId: string; status: ResearchPlanStatus; truncated: string[] }>;
  addQuestion(input: { workspaceRoot: string; text: string }): Promise<{ questionId: string; total: number; truncated: string[] }>;
  resolveQuestion(input: {
    workspaceRoot: string;
    ref: string;
    status: "answered" | "dropped";
    answer?: string;
  }): Promise<{ questionId: string; status: ResearchQuestionStatus; truncated: string[] }>;
  addRuledOut(input: {
    workspaceRoot: string;
    what: string;
    why: string;
    source?: string;
  }): Promise<{ ruledOutId: string; total: number; evicted: number; truncated: string[] }>;
  markTried(input: {
    workspaceRoot: string;
    action: string;
    tool?: string;
    result?: string;
  }): Promise<ResearchMarkTriedResult>;
  /** Read-only dedup check: has this action been tried? (no state mutation) */
  checkTried(input: { workspaceRoot: string; action: string }): Promise<{ tried: boolean; count: number; previousResult?: string }>;
  /** Compact digest — the anti-drift view designed for context injection. */
  summary(input: { workspaceRoot: string }): Promise<ResearchSummary>;
  clear(input: { workspaceRoot: string }): Promise<{ cleared: boolean }>;
}

export function createResearchStatePort(clock: () => Date = () => new Date()): ResearchStatePort {
  const now = () => clock().toISOString();

  return {
    async setGoal(input) {
      const text = input.goal.trim();
      if (!text) throw new Error("set-goal requires goal (the research objective text).");
      const path = researchStatePath(input.workspaceRoot);
      const { state } = await readState(path);
      const truncated: string[] = [];
      const clipped = clip(text, RESEARCH_STATE_MAX_GOAL_CHARS, "goal", truncated);
      const updated = state.goal !== undefined;
      state.goal = clipped;
      state.goalSetAt = now();
      state.lastUpdated = now();
      await writeState(path, state);
      return { goal: clipped, updated, truncated };
    },

    async addPlanItems(input) {
      const texts = input.items.map((item) => item.trim()).filter(Boolean);
      if (texts.length === 0) throw new Error("plan-add requires items (an array of plan-step texts).");
      const path = researchStatePath(input.workspaceRoot);
      const { state } = await readState(path);
      // Cap counts ACTIVE items only (pending/in_progress) — done/dropped items
      // stay as history and don't block new work (DA review finding M4: counting
      // all items dead-ends a session because there is no delete action).
      const active = state.plan.filter((item) => item.status === "pending" || item.status === "in_progress").length;
      if (active + texts.length > RESEARCH_STATE_MAX_PLAN_ITEMS) {
        throw new Error(
          `Active plan items (pending/in_progress) would exceed the cap ${RESEARCH_STATE_MAX_PLAN_ITEMS} `
            + `(${active} active, ${state.plan.length} including history) — mark finished items done/dropped first.`,
        );
      }
      const truncated: string[] = [];
      const added: string[] = [];
      for (const text of texts) {
        const id = nextId(state.plan, "p");
        state.plan.push({ id, text: clip(text, RESEARCH_STATE_MAX_TEXT_CHARS, "item", truncated), status: "pending", createdAt: now(), updatedAt: now() });
        added.push(id);
      }
      state.lastUpdated = now();
      await writeState(path, state);
      return { added, total: state.plan.length, truncated };
    },

    async updatePlanItem(input) {
      const STATUSES: ResearchPlanStatus[] = ["pending", "in_progress", "done", "dropped"];
      if (!STATUSES.includes(input.status)) throw new Error(`plan-update status must be one of ${STATUSES.join("/")}.`);
      const path = researchStatePath(input.workspaceRoot);
      const { state } = await readState(path);
      const item = findByRef(state.plan, input.ref.trim(), "Plan item");
      const truncated: string[] = [];
      item.status = input.status;
      if (input.note?.trim()) item.note = clip(input.note.trim(), RESEARCH_STATE_MAX_REASON_CHARS, "note", truncated);
      item.updatedAt = now();
      state.lastUpdated = now();
      await writeState(path, state);
      return { itemId: item.id, status: input.status, truncated };
    },

    async addQuestion(input) {
      const text = input.text.trim();
      if (!text) throw new Error("question-add requires text (the question text).");
      const path = researchStatePath(input.workspaceRoot);
      const { state } = await readState(path);
      // Cap counts OPEN questions only — resolved ones are history.
      const open = state.openQuestions.filter((question) => question.status === "open").length;
      if (open >= RESEARCH_STATE_MAX_OPEN_QUESTIONS) {
        throw new Error(`Open questions already at the cap ${RESEARCH_STATE_MAX_OPEN_QUESTIONS} — resolve or drop some first.`);
      }
      const truncated: string[] = [];
      const id = nextId(state.openQuestions, "q");
      state.openQuestions.push({ id, text: clip(text, RESEARCH_STATE_MAX_TEXT_CHARS, "text", truncated), status: "open", createdAt: now() });
      state.lastUpdated = now();
      await writeState(path, state);
      return { questionId: id, total: state.openQuestions.length, truncated };
    },

    async resolveQuestion(input) {
      if (input.status !== "answered" && input.status !== "dropped") {
        throw new Error("question-resolve status must be answered/dropped.");
      }
      const path = researchStatePath(input.workspaceRoot);
      const { state } = await readState(path);
      const question = findByRef(state.openQuestions, input.ref.trim(), "Open question");
      const truncated: string[] = [];
      question.status = input.status;
      if (input.status === "answered") {
        if (!input.answer?.trim()) throw new Error("question-resolve answered requires answer (a summary of the answer).");
        question.answer = clip(input.answer.trim(), RESEARCH_STATE_MAX_TEXT_CHARS, "answer", truncated);
      } else {
        // dropped: clear any previously recorded answer — a dropped question has none.
        delete question.answer;
      }
      question.resolvedAt = now();
      state.lastUpdated = now();
      await writeState(path, state);
      return { questionId: question.id, status: input.status, truncated };
    },

    async addRuledOut(input) {
      const what = input.what.trim();
      const why = input.why.trim();
      if (!what || !why) throw new Error("rule-out requires what (the ruled-out direction) and why (the reason).");
      const path = researchStatePath(input.workspaceRoot);
      const { state } = await readState(path);
      const truncated: string[] = [];
      const id = nextId(state.ruledOut, "r");
      state.ruledOut.push({
        id,
        what: clip(what, RESEARCH_STATE_MAX_TEXT_CHARS, "what", truncated),
        why: clip(why, RESEARCH_STATE_MAX_REASON_CHARS, "why", truncated),
        ...(input.source?.trim() ? { source: clip(input.source.trim(), RESEARCH_STATE_MAX_REASON_CHARS, "source", truncated) } : {}),
        createdAt: now(),
      });
      // Bounded history: evict the oldest beyond the cap and report it (DA
      // hard-errors at the cap with no delete action — a dead end).
      let evicted = 0;
      while (state.ruledOut.length > RESEARCH_STATE_MAX_RULED_OUT) {
        state.ruledOut.shift();
        evicted += 1;
      }
      state.lastUpdated = now();
      await writeState(path, state);
      return { ruledOutId: id, total: state.ruledOut.length, evicted, truncated };
    },

    async markTried(input) {
      const action = input.action.trim();
      if (!action) throw new Error("mark-tried requires action (a one-line description incl. key parameters).");
      const path = researchStatePath(input.workspaceRoot);
      const { state } = await readState(path);
      const truncated: string[] = [];
      const hash = hashResearchAction(action);
      const existing = state.triedActions.find((tried) => tried.hash === hash);
      if (existing) {
        // Capture the previous outcome BEFORE overwriting: the caller needs
        // what the FIRST try learned, not the result they just submitted.
        const previousResult = existing.result;
        const previousTool = existing.tool;
        const firstTriedAt = existing.createdAt;
        existing.count += 1;
        existing.lastTriedAt = now();
        if (input.result?.trim()) existing.result = clip(input.result.trim(), RESEARCH_STATE_MAX_REASON_CHARS, "result", truncated);
        state.lastUpdated = now();
        await writeState(path, state);
        return {
          alreadyTried: true,
          count: existing.count,
          actionId: existing.hash,
          ...(previousResult === undefined ? {} : { previousResult }),
          ...(previousTool === undefined ? {} : { previousTool }),
          firstTriedAt,
          truncated,
        };
      }
      // Bounded index: evict the least-recently-tried beyond the cap.
      if (state.triedActions.length >= RESEARCH_STATE_MAX_TRIED_ACTIONS) {
        let oldest = 0;
        for (let i = 1; i < state.triedActions.length; i += 1) {
          if (state.triedActions[i]!.lastTriedAt < state.triedActions[oldest]!.lastTriedAt) oldest = i;
        }
        state.triedActions.splice(oldest, 1);
      }
      state.triedActions.push({
        hash,
        summary: clip(action, RESEARCH_STATE_MAX_TEXT_CHARS, "action", truncated),
        ...(input.tool?.trim() ? { tool: input.tool.trim() } : {}),
        ...(input.result?.trim() ? { result: clip(input.result.trim(), RESEARCH_STATE_MAX_REASON_CHARS, "result", truncated) } : {}),
        count: 1,
        createdAt: now(),
        lastTriedAt: now(),
      });
      state.lastUpdated = now();
      await writeState(path, state);
      return { alreadyTried: false, count: 1, actionId: hash, truncated };
    },

    async checkTried(input) {
      const action = input.action.trim();
      if (!action) throw new Error("check-tried requires action.");
      const { state } = await readState(researchStatePath(input.workspaceRoot));
      const existing = state.triedActions.find((tried) => tried.hash === hashResearchAction(action));
      return existing
        ? { tried: true, count: existing.count, ...(existing.result === undefined ? {} : { previousResult: existing.result }) }
        : { tried: false, count: 0 };
    },

    async summary(input) {
      const { state, corrupt } = await readState(researchStatePath(input.workspaceRoot));
      const count = <S extends string>(items: Array<{ status: S }>, status: S) => items.filter((item) => item.status === status).length;
      const open = state.openQuestions.filter((question) => question.status === "open");
      return {
        ...(state.goal === undefined ? {} : { goal: state.goal }),
        ...(state.goalSetAt === undefined ? {} : { goalSetAt: state.goalSetAt }),
        plan: {
          total: state.plan.length,
          pending: count(state.plan, "pending"),
          inProgress: count(state.plan, "in_progress"),
          done: count(state.plan, "done"),
          dropped: count(state.plan, "dropped"),
        },
        currentItems: state.plan.filter((item) => item.status === "in_progress").map((item) => ({ id: item.id, text: item.text })),
        openQuestions: {
          total: state.openQuestions.length,
          open: open.length,
          answered: count(state.openQuestions, "answered"),
          dropped: count(state.openQuestions, "dropped"),
        },
        topOpenQuestions: open.slice(0, 10).map((question) => ({ id: question.id, text: question.text })),
        ruledOut: {
          total: state.ruledOut.length,
          recent: state.ruledOut.slice(-10).map((ruledOut) => ({ id: ruledOut.id, what: ruledOut.what, why: ruledOut.why })),
        },
        triedActions: {
          total: state.triedActions.length,
          repeated: state.triedActions.filter((tried) => tried.count > 1).length,
        },
        lastUpdated: state.lastUpdated,
        corrupt,
      };
    },

    async clear(input) {
      try {
        await unlink(researchStatePath(input.workspaceRoot));
      } catch {
        // Already gone — fine.
      }
      return { cleared: true };
    },
  };
}
