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

/** Carrying a session's evolve runs through a research package.
 *
 * A run's result files travel as ordinary artifacts (`evolve/<run>/<entrypoint>`),
 * which is why an imported session used to show the candidate files with no run
 * behind them: the search tree, the scores and the budget lived only in the
 * export's own store (#1019). This module packages the run records and their
 * event log, and restores both on import under the *new* session id.
 *
 * The package is user-supplied input, so every field is validated here rather
 * than trusted: a run id must satisfy the store's own rule, an event must carry
 * an integer sequence, and a status must be one of the known values.
 */

import { isEvolveRunActive, type EvolveEventRecord, type EvolveRun, type EvolveRunStatus } from "@sciencediscovery/schema";

import { EvolutionStore } from "./store.js";

export interface PackageEvolveRun {
  events: EvolveEventRecord[];
  run: EvolveRun;
}

export interface EvolveRestoreResult {
  /** One line per run that could not be restored, in the receipt's own style. */
  omissions: string[];
  restored: number;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const STATUSES: ReadonlySet<string> = new Set(["budget_exhausted", "failed", "pending", "running", "stopped", "succeeded"]);
/** A package cannot ask the importer to create an unbounded number of runs. */
const MAX_RUNS = 200;

/** Every run of the given sessions, with its event log, oldest first so a
 *  reader can replay the search in the order it happened. */
export async function exportEvolveRuns(store: EvolutionStore, sessionIds: readonly string[]): Promise<PackageEvolveRun[]> {
  const wanted = new Set(sessionIds);
  const runs = (await store.listRuns()).filter((run) => wanted.has(run.sessionId));
  const ordered = [...runs].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const packed: PackageEvolveRun[] = [];
  for (const run of ordered.slice(0, MAX_RUNS)) {
    packed.push({ events: await store.readEvents(run.id), run });
  }
  return packed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function optionalString(value: unknown, limit = 4_000): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, limit) : undefined;
}

function validEvents(value: unknown): EvolveEventRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const sequence = record?.sequence;
    const event = asRecord(record?.event);
    if (!Number.isInteger(sequence) || Number(sequence) < 1 || !event || typeof event.type !== "string") return [];
    return [{ ...record, event, sequence } as unknown as EvolveEventRecord];
  });
}

/**
 * Recreate the package's runs under `target.sessionId`.
 *
 * An active run at export time is stored as `stopped`: nothing is executing on
 * the importing machine, and presenting it as `running` would show a search that
 * can never advance. A run id that already exists here is left untouched — two
 * imports of one package must not overwrite each other's runs.
 */
export async function restoreEvolveRuns(
  store: EvolutionStore,
  target: { projectId?: string; sessionId: string },
  payload: unknown,
): Promise<EvolveRestoreResult> {
  const result: EvolveRestoreResult = { omissions: [], restored: 0 };
  if (payload === undefined || payload === null) return result;
  const container = asRecord(payload);
  const entries = Array.isArray(container?.runs) ? container.runs : undefined;
  if (!entries) {
    result.omissions.push("evolve:package carries an evolve record that is not a run list");
    return result;
  }
  for (const entry of entries.slice(0, MAX_RUNS)) {
    const packed = asRecord(entry);
    const run = asRecord(packed?.run);
    const id = typeof run?.id === "string" ? run.id : "";
    if (!RUN_ID.test(id)) {
      result.omissions.push("evolve:package carries a run with an invalid id");
      continue;
    }
    if (await store.readRun(id)) {
      result.omissions.push(`evolve:${id}:already present in this project`);
      continue;
    }
    const goal = asRecord(run?.goal);
    if (!goal || typeof goal.statement !== "string") {
      result.omissions.push(`evolve:${id}:missing the run goal`);
      continue;
    }
    const status = typeof run?.status === "string" && STATUSES.has(run.status) ? run.status as EvolveRunStatus : "failed";
    try {
      await store.createRun({
        goal: goal as EvolveRun["goal"],
        id,
        ...(target.projectId ? { projectId: target.projectId } : {}),
        sessionId: target.sessionId,
      });
      const events = validEvents(packed?.events);
      if (events.length) await store.appendEvents(id, events);
      const startedAt = optionalString(run?.startedAt, 40);
      const finishedAt = optionalString(run?.finishedAt, 40);
      const error = optionalString(run?.error, 2_000);
      await store.patchRun(id, {
        candidates: Number.isInteger(run?.candidates) ? Number(run?.candidates) : 0,
        costCents: Number.isFinite(run?.costCents) ? Number(run?.costCents) : 0,
        ...(startedAt ? { startedAt } : {}),
        ...(finishedAt ? { finishedAt } : {}),
        ...(error ? { error } : {}),
        status: isEvolveRunActive(status) ? "stopped" : status,
        tokens: Number.isInteger(run?.tokens) ? Number(run?.tokens) : 0,
      });
      result.restored += 1;
    } catch (caught) {
      result.omissions.push(`evolve:${id}:${caught instanceof Error ? caught.message : "restore failed"}`);
    }
  }
  return result;
}
