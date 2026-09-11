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
 * cannot leave a torn file. Session-file read-modify-write is not
 * mutex-protected: tool calls within a turn serialize, but concurrent
 * sub-agent writes to the same workspace can lose an update (last writer
 * wins) — recorded limitation, same trade-off as ke-evidence-ledger.ts.
 * The PROJECT ledger (V2-C2) is mutex-protected: promote runs its
 * read-modify-write under withLedgerLock (atomic mkdir + ownership-token
 * fenced release), while hydrate reads the ledger lock-free (tmp+rename
 * keeps reads consistent) and writes only the session file. Recorded
 * limitation: the fenced release's read-then-rm is not atomic, so a frozen
 * holder that outlives the stale window can still race a stealer — the
 * outcome is a lost merge (never a torn file), and the next promote
 * re-applies it.
 *
 * Deliberate divergences from the DA original:
 *   - ids are sequential per collection (p1/q1/r1…) instead of UUIDs —
 *     deterministic, shorter, and friendlier for the ref-by-substring lookup.
 *   - ruledOut / triedActions caps evict the oldest entry (and report it)
 *     instead of erroring forever: DA's hard cap dead-ends a session because
 *     the tool surface has no delete action.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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
  /**
   * The id this item carried in the store it was copied from (session ↔
   * project ledger). Ids are store-local and renumbered on copy — cross-store
   * references must use text, never ids (review P1).
   */
  originId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchOpenQuestion {
  id: string;
  text: string;
  status: ResearchQuestionStatus;
  answer?: string;
  /** Uncertainty ledger pointer (V2-C2): where the answer/evidence lives. */
  evidence?: string;
  note?: string;
  /** The id in the store this entry was copied from — see ResearchPlanItem. */
  originId?: string;
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
  /** The id in the store this entry was copied from — see ResearchPlanItem. */
  originId?: string;
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

export interface ResearchStateFile {
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

/**
 * Project-level research ledger (phase V, V2-C2): the cross-trajectory world
 * model — sessions promote their durable findings into it and hydrate from
 * it on their first read, so a new session of the same project inherits the
 * goal, open questions, and ruled-out paths of its predecessors.
 */
export function researchLedgerPath(projectRoot: string): string {
  return resolve(projectRoot, ".research", "ledger.json");
}

/** A lock is stolen after this age — a crashed holder must not deadlock the project. */
const LEDGER_LOCK_STALE_MS = 30_000;
const LEDGER_LOCK_RETRY_MS = 40;
const LEDGER_LOCK_MAX_ATTEMPTS = 250; // ~10s of retries before giving up

/**
 * Cross-process mutex for ledger read-modify-write, via atomic mkdir (the
 * session file is same-turn serialized by the tool registry, but the project
 * ledger can be touched by two sessions — or a session and a subagent — of
 * the same project concurrently). tmp+rename inside keeps the write torn-free.
 * The ownership token fences the release: a stale lock can be stolen, and
 * only the token holder may remove the lock dir — a recovering slow holder
 * never deletes a successor's lock (review P2).
 */
async function withLedgerLock<T>(ledgerPath: string, fn: () => Promise<T>): Promise<T> {
  // The lock dir's parent must exist before the atomic mkdir can succeed.
  await mkdir(dirname(ledgerPath), { recursive: true });
  const lockDir = `${ledgerPath}.lock`;
  const tokenPath = join(lockDir, "owner");
  const token = `${process.pid}:${randomUUID()}`;
  let attempts = 0;
  for (;;) {
    try {
      await mkdir(lockDir);
      try {
        await writeFile(tokenPath, token, "utf8");
      } catch (writeError) {
        // A failed token write would leave an unfenced lock that blocks every
        // acquirer until the stale window expires — clean up our own lock
        // instead of leaking it (review P3).
        await rm(lockDir, { force: true, recursive: true }).catch(() => {});
        throw writeError;
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      attempts += 1;
      if (attempts > LEDGER_LOCK_MAX_ATTEMPTS) throw new Error(`research ledger lock is held too long: ${lockDir}`);
      try {
        const stats = await stat(lockDir);
        if (Date.now() - stats.mtimeMs > LEDGER_LOCK_STALE_MS) {
          // Stealing is safe against the holder recovering: its fenced
          // release below will refuse to delete our successor lock.
          await rm(lockDir, { force: true, recursive: true });
          continue;
        }
      } catch { /* the holder released between attempts — loop back and retry */ }
      await new Promise((resolveWait) => setTimeout(resolveWait, LEDGER_LOCK_RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    // Fenced release: only the owner may remove the lock. A token mismatch
    // means the lock was stolen and re-acquired — leave it alone.
    try {
      const owner = await readFile(tokenPath, "utf8");
      if (owner === token) await rm(lockDir, { force: true, recursive: true });
    } catch { /* the lock is already gone or stolen — nothing safe to do */ }
  }
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

/** True when a state read from disk carries real content (not the never-written empty placeholder). */
function ledgerHasContent(state: ResearchStateFile): boolean {
  return state.lastUpdated !== new Date(0).toISOString()
    && (state.goal !== undefined || state.plan.length + state.openQuestions.length + state.ruledOut.length > 0);
}

/** Compact digest shared by the session summary and the project-ledger view. */
function buildResearchSummary(state: ResearchStateFile, corrupt: boolean): ResearchSummary {
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
    evidence?: string;
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
  /** Full raw state dump (audit/debug; prefer summary for context injection). */
  get(input: { workspaceRoot: string }): Promise<{ state: ResearchStateFile; corrupt: boolean }>;
  /** Compact digest — the anti-drift view designed for context injection. */
  summary(input: { workspaceRoot: string }): Promise<ResearchSummary>;
  clear(input: { workspaceRoot: string }): Promise<{ cleared: boolean }>;
  /**
   * Project ledger (V2-C2): promote the session's durable findings into the
   * project's shared ledger — goal (the NEWER goalSetAt wins), open and
   * answered questions (answered upgrades an open ledger entry in place with
   * its evidence pointer; a session-dropped question closes the ledger's
   * open entry so it cannot resurrect), and ruled-out paths, merged by text
   * dedup under a cross-process lock. Pending plan items and triedActions
   * stay session-local (they are trajectory detail, not world model);
   * dropped-before-promoted questions are never pushed (noise).
   */
  promote(input: { projectRoot: string; workspaceRoot: string }): Promise<{
    promoted: { planItems: number; questions: number; ruledOut: number; goal: boolean };
    ledgerPath: string;
  }>;
  /**
   * Merge the project ledger INTO the session state, filling only what the
   * session lacks (goal when unset; questions/ruledOut/plan items not
   * already present by text). Returns whether a ledger existed.
   */
  hydrate(input: { projectRoot: string; workspaceRoot: string }): Promise<{
    hydrated: { planItems: number; questions: number; ruledOut: number; goal: boolean };
    had: boolean;
  }>;
  /** The project ledger's compact digest (same shape as summary). */
  projectSummary(input: { projectRoot: string }): Promise<ResearchSummary & { had: boolean }>;
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
        if (input.evidence?.trim()) question.evidence = clip(input.evidence.trim(), RESEARCH_STATE_MAX_REASON_CHARS, "evidence", truncated);
      } else {
        // dropped: clear any previously recorded answer — a dropped question has none.
        delete question.answer;
        delete question.evidence;
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

    async get(input) {
      return readState(researchStatePath(input.workspaceRoot));
    },

    async summary(input) {
      const { state, corrupt } = await readState(researchStatePath(input.workspaceRoot));
      return buildResearchSummary(state, corrupt);
    },

    async clear(input) {
      try {
        await unlink(researchStatePath(input.workspaceRoot));
      } catch {
        // Already gone — fine.
      }
      return { cleared: true };
    },

    async promote(input) {
      const sessionPath = researchStatePath(input.workspaceRoot);
      const ledgerPath = researchLedgerPath(input.projectRoot);
      const { state: session } = await readState(sessionPath);
      return withLedgerLock(ledgerPath, async () => {
        const { state: ledger } = await readState(ledgerPath);
        const promoted = { goal: false, planItems: 0, questions: 0, ruledOut: 0 };
        // Goal: recency wins — an older session must not roll the project
        // goal back to a stale value (review P2).
        if (
          session.goal !== undefined
          && session.goal !== ledger.goal
          && (ledger.goalSetAt === undefined || (session.goalSetAt ?? "") > ledger.goalSetAt)
        ) {
          ledger.goal = session.goal;
          ledger.goalSetAt = session.goalSetAt ?? now();
          promoted.goal = true;
        }
        // Plan history: done/dropped items are findings (what was completed
        // or abandoned); pending/in_progress stay session-local trajectory.
        const ledgerPlanTexts = new Set(ledger.plan.map((item) => item.text));
        for (const item of session.plan) {
          if (item.status === "pending" || item.status === "in_progress") continue;
          if (ledgerPlanTexts.has(item.text)) continue;
          ledgerPlanTexts.add(item.text);
          ledger.plan.push({ ...item, id: nextId(ledger.plan, "p"), originId: item.id });
          promoted.planItems += 1;
        }
        // Questions merge by text: answered upgrades an open ledger entry in
        // place; dropped closes it too — a killed question must not resurrect
        // in future sessions (review P2). New pushes skip dropped (noise).
        for (const question of session.openQuestions) {
          const existing = ledger.openQuestions.find((candidate) => candidate.text === question.text);
          if (!existing) {
            if (question.status === "dropped") continue;
            ledger.openQuestions.push({ ...question, id: nextId(ledger.openQuestions, "q"), originId: question.id });
            promoted.questions += 1;
            continue;
          }
          if (question.status === "answered" && existing.status !== "answered") {
            existing.status = "answered";
            existing.answer = question.answer;
            if (question.evidence !== undefined) existing.evidence = question.evidence;
            existing.resolvedAt = question.resolvedAt ?? now();
            promoted.questions += 1;
          } else if (question.status === "dropped" && existing.status === "open") {
            existing.status = "dropped";
            existing.resolvedAt = question.resolvedAt ?? now();
            promoted.questions += 1;
          }
        }
        // Ruled-out paths merge by `what` — the anti-resurrection archive is
        // exactly what must survive across trajectories.
        const ledgerRuledOut = new Set(ledger.ruledOut.map((entry) => entry.what));
        for (const entry of session.ruledOut) {
          if (ledgerRuledOut.has(entry.what)) continue;
          ledgerRuledOut.add(entry.what);
          ledger.ruledOut.push({ ...entry, id: nextId(ledger.ruledOut, "r"), originId: entry.id });
          promoted.ruledOut += 1;
        }
        // Ledger caps mirror the session eviction policy (oldest first) so
        // the shared world model stays bounded (review P2).
        if (ledger.plan.length > RESEARCH_STATE_MAX_PLAN_ITEMS * 2) {
          ledger.plan = ledger.plan.filter((item) => item.status === "pending" || item.status === "in_progress")
            .concat(ledger.plan.filter((item) => item.status !== "pending" && item.status !== "in_progress").slice(-RESEARCH_STATE_MAX_PLAN_ITEMS * 2));
        }
        if (ledger.openQuestions.length > RESEARCH_STATE_MAX_OPEN_QUESTIONS * 2) {
          ledger.openQuestions = ledger.openQuestions.slice(-RESEARCH_STATE_MAX_OPEN_QUESTIONS * 2);
        }
        if (ledger.ruledOut.length > RESEARCH_STATE_MAX_RULED_OUT) {
          ledger.ruledOut = ledger.ruledOut.slice(-RESEARCH_STATE_MAX_RULED_OUT);
        }
        ledger.lastUpdated = now();
        await writeState(ledgerPath, ledger);
        return { ledgerPath, promoted };
      });
    },

    async hydrate(input) {
      const sessionPath = researchStatePath(input.workspaceRoot);
      const ledgerPath = researchLedgerPath(input.projectRoot);
      const { state: session, corrupt: sessionCorrupt } = await readState(sessionPath);
      // The ledger read needs no lock: tmp+rename keeps every read consistent,
      // and this method only writes the SESSION file (already same-turn
      // serialized) — a project lock here would serialize unrelated sessions
      // against each other for nothing (review P2).
      const { state: ledger } = await readState(ledgerPath);
      const had = ledgerHasContent(ledger);
      const hydrated = { goal: false, planItems: 0, questions: 0, ruledOut: 0 };
      if (!had) return { had, hydrated };
      if (session.goal === undefined && ledger.goal !== undefined) {
        session.goal = ledger.goal;
        session.goalSetAt = ledger.goalSetAt;
        hydrated.goal = true;
      }
      const sessionPlanTexts = new Set(session.plan.map((item) => item.text));
      for (const item of ledger.plan) {
        if (sessionPlanTexts.has(item.text)) continue;
        sessionPlanTexts.add(item.text);
        session.plan.push({ ...item, id: nextId(session.plan, "p"), originId: item.id });
        hydrated.planItems += 1;
      }
      for (const question of ledger.openQuestions) {
        if (session.openQuestions.some((candidate) => candidate.text === question.text)) continue;
        session.openQuestions.push({ ...question, id: nextId(session.openQuestions, "q"), originId: question.id });
        hydrated.questions += 1;
      }
      const sessionRuledOut = new Set(session.ruledOut.map((entry) => entry.what));
      for (const entry of ledger.ruledOut) {
        if (sessionRuledOut.has(entry.what)) continue;
        sessionRuledOut.add(entry.what);
        session.ruledOut.push({ ...entry, id: nextId(session.ruledOut, "r"), originId: entry.id });
        hydrated.ruledOut += 1;
      }
      // Only write when something actually merged — a no-op hydrate must
      // not create the session file as a side effect of a read path.
      if (hydrated.goal || hydrated.planItems + hydrated.questions + hydrated.ruledOut > 0 || sessionCorrupt) {
        session.lastUpdated = now();
        await writeState(sessionPath, session);
      }
      return { had, hydrated };
    },

    async projectSummary(input) {
      const { state, corrupt } = await readState(researchLedgerPath(input.projectRoot));
      return { ...buildResearchSummary(state, corrupt), had: ledgerHasContent(state) };
    },
  };
}
