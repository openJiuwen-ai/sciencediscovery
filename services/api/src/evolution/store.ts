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
 * File-backed store for `/evolve` runs.
 *
 * ```
 * data/evolution/
 *   programs/<programId>/   baseline + candidate sources (CAS-addressed)
 *   runs/<runId>/run.json   run metadata (atomically replaced)
 *   runs/<runId>/events.ndjson   append-only event log
 *   ledger/<runId>/         AgentDescent's git-backed ledger
 *   results/<runId>/        EvolutionResult.save() landing spot; resume reads it
 * ```
 *
 * **The event log is the source of truth, not the graph.** Science Memory is an
 * optional, default-off feature that must degrade silently, so anything a run
 * needs in order to be replayed, resumed or audited lives here; the Neo4j
 * mirror is a queryable projection of these same events.
 *
 * Sequence numbers are assigned by the producer (the evolve sidecar), not here.
 * `appendEvents` drops any record at or below the run's watermark, which is what
 * makes a reconnect-and-replay safe: the two non-idempotent quantities in the
 * system (PUCT visit counts, MAP-Elites cell occupancy) travel as absolute values
 * precisely so that replaying a prefix cannot double-count them.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  EvolveEvent,
  EvolveEventRecord,
  EvolveGoal,
  EvolveRun,
  EvolveRunStatus,
} from "@sciencediscovery/schema";
import { evolveAlgorithm, isEvolveRunActive } from "@sciencediscovery/schema";

/** Subdirectories created by `initialize`. Listed rather than derived so a new
 * one is a visible edit and not a silent side effect of the first write. */
const RUN_DIRECTORIES = ["programs", "runs", "ledger", "results"] as const;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface CreateEvolveRunInput {
  goal: EvolveGoal;
  /** Optional explicit id; generated when absent. */
  id?: string;
  projectId?: string;
  /** Set when this run continues another run's search. */
  resumedFromRunId?: string;
  sessionId: string;
}

export interface AppendEventsResult {
  /** Records written, in order. */
  applied: EvolveEventRecord[];
  /** Watermark after the append. */
  lastSeq: number;
  /** Records dropped because they were at or below the watermark. */
  skipped: number;
}

export class EvolutionStoreError extends Error {}

/** Serialises writes per run id. One API process owns the directory, but a run
 * receives batched events and status patches concurrently, and a read-modify-
 * write of `run.json` interleaved with another one loses a field. */
class RunLocks {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(runId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(runId) ?? Promise.resolve();
    const next = previous.then(task, task);
    // Keep the chain alive on failure; a rejected tail must not poison the run.
    this.tails.set(runId, next.catch(() => undefined));
    return next;
  }
}

export function assertValidRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new EvolutionStoreError(`Invalid evolve run id: ${runId}`);
}

/**
 * Parse an NDJSON event log, skipping anything unreadable.
 *
 * A crash mid-append leaves a torn last line; dropping it is right, because the
 * alternative — refusing to read the log at all — loses every event before it.
 */
export function parseEventLines(content: string): EvolveEventRecord[] {
  const records: EvolveEventRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    let parsed: EvolveEventRecord;
    try {
      parsed = JSON.parse(line) as EvolveEventRecord;
    } catch {
      continue;
    }
    if (typeof parsed.sequence !== "number" || typeof parsed.createdAt !== "string") continue;
    if (!parsed.event || typeof (parsed.event as EvolveEvent).type !== "string") continue;
    records.push(parsed);
  }
  return records;
}

/** Wrap bare events in records with consecutive sequence numbers. */
export function makeEventRecords(
  events: EvolveEvent[],
  startSequence: number,
  createdAt = new Date().toISOString(),
): EvolveEventRecord[] {
  return events.map((event, index) => ({ createdAt, event, sequence: startSequence + index }));
}

export class EvolutionStore {
  readonly root: string;
  private readonly locks = new RunLocks();

  constructor(dataDir: string) {
    this.root = resolve(dataDir, "evolution");
  }

  /** Idempotent: safe on every boot. */
  async initialize(): Promise<void> {
    for (const directory of RUN_DIRECTORIES) {
      await mkdir(resolve(this.root, directory), { recursive: true });
    }
  }

  runDirectory(runId: string): string {
    assertValidRunId(runId);
    return resolve(this.root, "runs", runId);
  }

  ledgerDirectory(runId: string): string {
    assertValidRunId(runId);
    return resolve(this.root, "ledger", runId);
  }

  resultsDirectory(runId: string): string {
    assertValidRunId(runId);
    return resolve(this.root, "results", runId);
  }

  eventLogPath(runId: string): string {
    return resolve(this.runDirectory(runId), "events.ndjson");
  }

  private runFilePath(runId: string): string {
    return resolve(this.runDirectory(runId), "run.json");
  }

  async createRun(input: CreateEvolveRunInput): Promise<EvolveRun> {
    const id = input.id ?? randomUUID();
    assertValidRunId(id);
    const run: EvolveRun = {
      algorithm: input.goal.algorithm,
      candidates: 0,
      costCents: 0,
      createdAt: new Date().toISOString(),
      goal: input.goal,
      id,
      lastSeq: 0,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.resumedFromRunId ? { resumedFromRunId: input.resumedFromRunId } : {}),
      sessionId: input.sessionId,
      status: "pending",
      tokens: 0,
    };
    await mkdir(this.runDirectory(id), { recursive: true });
    await mkdir(this.ledgerDirectory(id), { recursive: true });
    await mkdir(this.resultsDirectory(id), { recursive: true });
    await this.writeRunFile(run);
    return run;
  }

  async readRun(runId: string): Promise<EvolveRun | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.runFilePath(runId), "utf8");
    } catch {
      return undefined;
    }
    let run: EvolveRun;
    try {
      run = JSON.parse(raw) as EvolveRun;
    } catch {
      throw new EvolutionStoreError(`Corrupt evolve run record: ${runId}`);
    }
    // Runs written before `"era"` was renamed to `"puct"` are normalised here
    // rather than rewritten on disk, so this is the only place downstream code
    // can meet the old name. See `evolveAlgorithm`.
    return {
      ...run,
      algorithm: evolveAlgorithm(run.algorithm),
      goal: { ...run.goal, algorithm: evolveAlgorithm(run.goal?.algorithm) },
    };
  }

  /** Newest first. `sessionId` narrows to one session's runs. */
  async listRuns(sessionId?: string): Promise<EvolveRun[]> {
    let entries: string[];
    try {
      entries = await readdir(resolve(this.root, "runs"));
    } catch {
      return [];
    }
    const runs: EvolveRun[] = [];
    for (const entry of entries) {
      if (!RUN_ID_PATTERN.test(entry)) continue;
      const run = await this.readRun(entry);
      if (!run) continue;
      if (sessionId && run.sessionId !== sessionId) continue;
      runs.push(run);
    }
    return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /**
   * Read-modify-write of one run record under its lock.
   *
   * `lastSeq` is not patchable here — it moves only through `appendEvents`, so
   * the watermark can never disagree with the log it describes.
   */
  async patchRun(
    runId: string,
    patch: Partial<Omit<EvolveRun, "createdAt" | "goal" | "id" | "lastSeq" | "sessionId">>,
  ): Promise<EvolveRun> {
    return this.locks.run(runId, async () => {
      const current = await this.readRun(runId);
      if (!current) throw new EvolutionStoreError(`Unknown evolve run: ${runId}`);
      const next: EvolveRun = { ...current, ...patch };
      await this.writeRunFile(next);
      return next;
    });
  }

  /**
   * Append events past the run's watermark and advance it.
   *
   * Records are expected in ascending sequence order; anything at or below the
   * watermark is dropped rather than rejected, so a producer that reconnects and
   * replays its buffer is a no-op instead of an error.
   */
  async appendEvents(runId: string, records: EvolveEventRecord[]): Promise<AppendEventsResult> {
    return this.locks.run(runId, async () => {
      const run = await this.readRun(runId);
      if (!run) throw new EvolutionStoreError(`Unknown evolve run: ${runId}`);
      const fresh = records
        .filter((record) => record.sequence > run.lastSeq)
        .sort((left, right) => left.sequence - right.sequence);
      if (!fresh.length) return { applied: [], lastSeq: run.lastSeq, skipped: records.length };
      const payload = `${fresh.map((record) => JSON.stringify(record)).join("\n")}\n`;
      await appendFile(this.eventLogPath(runId), payload, "utf8");
      const lastSeq = fresh[fresh.length - 1]!.sequence;
      await this.writeRunFile({ ...run, lastSeq });
      return { applied: fresh, lastSeq, skipped: records.length - fresh.length };
    });
  }

  /** Every event after `afterSequence` (default: from the beginning). */
  async readEvents(runId: string, afterSequence = 0): Promise<EvolveEventRecord[]> {
    let content: string;
    try {
      content = await readFile(this.eventLogPath(runId), "utf8");
    } catch {
      return [];
    }
    return parseEventLines(content).filter((record) => record.sequence > afterSequence);
  }

  /** Terminal transition helper: stamps `finishedAt` exactly once. */
  async finishRun(runId: string, status: EvolveRunStatus, error?: string): Promise<EvolveRun> {
    if (isEvolveRunActive(status)) throw new EvolutionStoreError(`Not a terminal status: ${status}`);
    return this.patchRun(runId, {
      finishedAt: new Date().toISOString(),
      status,
      ...(error ? { error } : {}),
    });
  }

  /** Removes a run's metadata, event log, ledger and results. */
  async deleteRun(runId: string): Promise<void> {
    await this.locks.run(runId, async () => {
      await rm(this.runDirectory(runId), { force: true, recursive: true });
      await rm(this.ledgerDirectory(runId), { force: true, recursive: true });
      await rm(this.resultsDirectory(runId), { force: true, recursive: true });
    });
  }

  /** Write-to-temp-then-rename: a crash leaves either the old record or the new
   * one, never a half-written file. */
  private async writeRunFile(run: EvolveRun): Promise<void> {
    const directory = this.runDirectory(run.id);
    const temporary = resolve(directory, `.run-${process.pid}-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    try {
      await rename(temporary, this.runFilePath(run.id));
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
