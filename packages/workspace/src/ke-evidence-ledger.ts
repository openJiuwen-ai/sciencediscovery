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
 * W9 evidence ledger — a session-workspace file (`.ke/evidence-ledger.json`)
 * where the agent records each claim it intends to assert, with the anchor
 * or quote backing it, and can later verify those quotes against a knowledge
 * base and detect internal contradictions. Deterministic, audit-friendly
 * (the file is plain JSON a human can read), and fail-soft: a corrupt or
 * unreadable ledger degrades to an empty ledger, never a crashed turn.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface EvidenceLedgerEntry {
  readonly id: string;
  readonly claim: string;
  readonly anchorId?: string;
  readonly docId?: string;
  readonly quote?: string;
  readonly kbId?: string;
  readonly addedAt: string;
  /** Set by the verify action; absent until then. */
  verdict?: { state: "verbatim" | "fuzzy" | "not-found"; checkedAt: string };
}

export interface EvidenceLedgerFile {
  readonly entries: EvidenceLedgerEntry[];
}

const NEGATION_WORDS = new Set(["not", "no", "never", "without", "cannot", "neither"]);

function termSet(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => token.length > 1));
}

function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let hit = 0;
  for (const term of left) {
    if (right.has(term)) hit += 1;
  }
  return hit / left.size;
}

function isNegated(terms: Set<string>): boolean {
  for (const term of terms) {
    if (NEGATION_WORDS.has(term)) return true;
  }
  return false;
}

export function ledgerPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, ".ke", "evidence-ledger.json");
}

async function readLedger(path: string): Promise<{ entries: EvidenceLedgerEntry[]; nextId: number }> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<EvidenceLedgerFile>;
    const valid = Array.isArray(raw.entries);
    const entries = (valid ? raw.entries : []).filter(
      (entry): entry is EvidenceLedgerEntry =>
        Boolean(entry) && typeof entry.claim === "string" && typeof entry.id === "string" && /^e\d+$/.test(entry.id),
    );
    const nextId = entries.reduce((max, entry) => {
      const parsed = Number(entry.id.slice(1));
      return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
    }, 0) + 1;
    return { entries, nextId };
  } catch {
    return { entries: [], nextId: 1 };
  }
}

async function writeLedger(path: string, entries: readonly EvidenceLedgerEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Atomic replace: a torn write would otherwise degrade to an empty ledger
  // on the next read (fail-soft) and silently erase the audit trail.
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export interface LedgerConflict {
  readonly ids: readonly string[];
  readonly claims: readonly string[];
  /** same-claim-different-source | negation-flip */
  readonly reason: string;
}

/** Deterministic conflict detection over the recorded entries. */
export function detectLedgerConflicts(entries: readonly EvidenceLedgerEntry[]): LedgerConflict[] {
  const conflicts: LedgerConflict[] = [];
  const seen = new Set<string>(); // canonical id-pair key to avoid duplicates
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const left = entries[i]!;
      const right = entries[j]!;
      const key = [left.id, right.id].sort().join("|");
      if (seen.has(key)) continue;
      const leftTerms = termSet(left.claim);
      const rightTerms = termSet(right.claim);
      const similarity = overlapRatio(leftTerms, rightTerms);
      if (similarity < 0.6) continue;
      // Negation flips outrank source divergence (a flipped claim from two
      // docs is first a contradiction); entries without any source never
      // count as "a different source".
      const leftSourced = left.anchorId !== undefined || left.docId !== undefined;
      const rightSourced = right.anchorId !== undefined || right.docId !== undefined;
      let reason: string | undefined;
      if (isNegated(leftTerms) !== isNegated(rightTerms)) {
        reason = "negation-flip";
      } else if (
        leftSourced && rightSourced
        && left.anchorId !== right.anchorId && left.docId !== right.docId
      ) {
        reason = "same-claim-different-source";
      }
      if (reason) {
        seen.add(key);
        conflicts.push({ ids: [left.id, right.id], claims: [left.claim, right.claim], reason });
      }
    }
  }
  return conflicts.slice(0, 20);
}

export interface EvidenceLedgerPort {
  /** Record a claim (optionally with its backing anchor/doc/quote). */
  add(input: {
    workspaceRoot: string;
    claim: string;
    anchorId?: string;
    docId?: string;
    quote?: string;
    kbId?: string;
  }): Promise<{ entry: EvidenceLedgerEntry; total: number }>;
  /** List entries, optionally filtered by a claim substring. */
  query(input: { workspaceRoot: string; claim?: string }): Promise<{ entries: EvidenceLedgerEntry[] }>;
  /** Re-check recorded quotes against a KB through the verify port. */
  verify(input: {
    workspaceRoot: string;
    kbId: string;
    verifyCitation: (kbId: string, quote: string) => Promise<{ state: string }>;
  }): Promise<{ checked: number; results: Array<{ id: string; state: string }>; skipped: number }>;
  /** Deterministic contradiction detection. */
  conflicts(input: { workspaceRoot: string }): Promise<{ conflicts: LedgerConflict[] }>;
}

export function createEvidenceLedgerPort(clock: () => Date = () => new Date()): EvidenceLedgerPort {
  return {
    async add(input) {
      const path = ledgerPath(input.workspaceRoot);
      const { entries, nextId } = await readLedger(path);
      const entry: EvidenceLedgerEntry = {
        id: `e${nextId}`,
        claim: input.claim,
        addedAt: clock().toISOString(),
        ...(input.anchorId === undefined ? {} : { anchorId: input.anchorId }),
        ...(input.docId === undefined ? {} : { docId: input.docId }),
        ...(input.quote === undefined ? {} : { quote: input.quote }),
        ...(input.kbId === undefined ? {} : { kbId: input.kbId }),
      };
      const next = [...entries, entry];
      if (next.length > 200) next.splice(0, next.length - 200); // bounded audit trail
      await writeLedger(path, next);
      return { entry, total: next.length };
    },

    async query(input) {
      const { entries } = await readLedger(ledgerPath(input.workspaceRoot));
      const needle = input.claim?.toLowerCase();
      return {
        entries: needle === undefined ? entries : entries.filter((entry) => entry.claim.toLowerCase().includes(needle)),
      };
    },

    async verify(input) {
      const path = ledgerPath(input.workspaceRoot);
      const { entries } = await readLedger(path);
      let checked = 0;
      let skipped = 0;
      const results: Array<{ id: string; state: string }> = [];
      const next: EvidenceLedgerEntry[] = [];
      for (const entry of entries) {
        if (entry.kbId !== input.kbId || !entry.quote || entry.quote.length === 0) {
          skipped += 1;
          next.push(entry);
          continue;
        }
        // Sequential awaits keep the ledger write deterministic.
        const verified = await input.verifyCitation(input.kbId, entry.quote);
        const raw = verified.state === "none" ? "not-found" : verified.state;
        const state: "verbatim" | "fuzzy" | "not-found" = raw === "verbatim" || raw === "fuzzy" ? raw : "not-found";
        next.push({ ...entry, verdict: { state, checkedAt: clock().toISOString() } });
        results.push({ id: entry.id, state });
        checked += 1;
      }
      await writeLedger(path, next);
      return { checked, results, skipped };
    },

    async conflicts(input) {
      const { entries } = await readLedger(ledgerPath(input.workspaceRoot));
      return { conflicts: detectLedgerConflicts(entries) };
    },
  };
}
