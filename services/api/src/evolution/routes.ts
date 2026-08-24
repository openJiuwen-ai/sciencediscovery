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
 * `/api/evolve/*` request handlers.
 *
 * Kept beside the orchestrator rather than inline in `http/index.ts`: the route
 * table there is already 2k lines, and these five handlers share a validator and
 * an SSE writer that have no other callers.
 *
 * The event route mirrors the session-run one: `Accept: text/event-stream` gets
 * a live stream that replays from disk first, anything else gets the JSON list.
 * One shape, two consumers — the dashboard follows live, a reload catches up.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { EvolveEventRecord, EvolveGoal, ModelProfile } from "@sciencediscovery/schema";
import { isEvolveRunActive } from "@sciencediscovery/schema";

import { readJson } from "../http/body.js";
import { sendError, sendJson } from "../http/response.js";

import type { EvolveOrchestrator } from "./orchestrator.js";
import { DatasetIntakeError, ingestDataset } from "./dataset-intake.js";
import { ProbeRegistry } from "./discrimination.js";
import { preflight, type PreflightIssue } from "./preflight.js";
import { EvolutionStoreError, type EvolutionStore } from "./store.js";

interface CreateRunBody {
  goal?: unknown;
  projectId?: string;
  resumedFromRunId?: string;
  sessionId?: string;
}

/**
 * Structural check only — enough that the orchestrator and the sidecar are not
 * handed nonsense.
 *
 * The judgements that actually decide whether a run is worth starting (is the
 * normalisation monotone with the metric's direction, does the baseline already
 * violate a constraint, can the scorecard tell two candidates apart) need to run
 * the baseline and belong to the scorecard validator, not to a request parser.
 */
export function validateGoal(value: unknown): { error: string } | { goal: EvolveGoal } {
  if (!value || typeof value !== "object") return { error: "goal is required" };
  const goal = value as Partial<EvolveGoal>;
  if (goal.schemaVersion !== 2) return { error: "goal.schemaVersion must be 2" };
  if (typeof goal.statement !== "string" || !goal.statement.trim()) return { error: "goal.statement is required" };
  if (goal.algorithm !== "era" && goal.algorithm !== "openevolve") {
    return { error: 'goal.algorithm must be "era" or "openevolve"' };
  }
  if (!goal.target || typeof goal.target !== "object") return { error: "goal.target is required" };
  if (!goal.budget || typeof goal.budget !== "object") return { error: "goal.budget is required" };
  if (!Number.isInteger(goal.budget.expansions) || goal.budget.expansions < 1) {
    return { error: "goal.budget.expansions must be a positive integer" };
  }
  const scorecard = goal.scorecard;
  if (!scorecard || typeof scorecard !== "object") return { error: "goal.scorecard is required" };
  if (typeof scorecard.hash !== "string" || !scorecard.hash) return { error: "goal.scorecard.hash is required" };
  if (!Array.isArray(scorecard.criteria) || !scorecard.criteria.length) {
    return { error: "goal.scorecard.criteria must not be empty" };
  }
  return { goal: goal as EvolveGoal };
}

/**
 * Take the discrimination probe for a goal, before any run exists.
 *
 * Its own endpoint rather than a step inside creation: it costs two
 * evaluations, and hiding that inside "start" makes starting slow and
 * surprising. The wizard runs it, shows both numbers, and only then offers to
 * begin.
 */
export async function handleProbe(
  request: IncomingMessage,
  response: ServerResponse,
  orchestrator: EvolveOrchestrator,
  probes: ProbeRegistry,
): Promise<void> {
  const body = await readJson<{ goal?: EvolveGoal; sessionId?: string }>(request);
  if (!body.sessionId) return sendError(response, 400, "sessionId is required");
  const validated = validateGoal(body.goal);
  if ("error" in validated) return sendError(response, 400, validated.error);

  try {
    const result = await orchestrator.probe(validated.goal, body.sessionId);
    // Only a pass is remembered. A flat scorecard the user then edits gets a
    // new hash and has to be probed again, which is the point: the thing that
    // was measured has to be the thing that runs.
    if (!result.flat) probes.record(validated.goal.scorecard.hash);
    sendJson(response, 200, result);
  } catch (error) {
    sendError(response, 502, error instanceof Error ? error.message : String(error));
  }
}

export async function handleCreateRun(
  request: IncomingMessage,
  response: ServerResponse,
  orchestrator: EvolveOrchestrator,
  deps: {
    casHas?: (hash: string) => Promise<boolean>;
    model?: (id: string) => unknown;
    /** Absent in tests that are not about the probe; present in the server,
     *  where skipping it is what this gate exists to prevent. */
    probes?: ProbeRegistry;
  } = {},
): Promise<void> {
  const body = await readJson<CreateRunBody>(request);
  if (!body.sessionId) return sendError(response, 400, "sessionId is required");
  const validated = validateGoal(body.goal);
  if ("error" in validated) return sendError(response, 400, validated.error);

  // Refused here rather than at the first expansion: every one of these fails
  // silently or expensively, and a user who has watched a progress bar for a
  // minute has already paid for the mistake.
  const issues = await preflight({
    casHas: deps.casHas,
    goal: validated.goal,
    model: deps.model?.(validated.goal.modelId) as never,
    sandbox: await orchestrator.sandboxCapability(),
  });
  if (issues.length) return sendPreflightRefusal(response, issues);

  // The probe is the one check the control plane cannot answer by reading the
  // goal, so it is enforced by a proof rather than re-run here: re-running it
  // would spend the same two evaluations again.
  if (deps.probes && !deps.probes.has(validated.goal.scorecard.hash)) {
    return sendPreflightRefusal(response, [{
      code: "not_probed",
      fix: "先跑一次判别力探针",
      message: "这套评分还没验过判别力。分不出好坏的评分会让搜索在平坦地形上"
        + "随机游走，而看板上什么都不会显示为异常",
    }]);
  }
  const run = await orchestrator.start({
    goal: validated.goal,
    projectId: body.projectId,
    resumedFromRunId: body.resumedFromRunId,
    sessionId: body.sessionId,
  });
  sendJson(response, 201, run);
}

export async function handleListRuns(
  response: ServerResponse,
  store: EvolutionStore,
  sessionId: string | null,
): Promise<void> {
  sendJson(response, 200, await store.listRuns(sessionId ?? undefined));
}

/**
 * Take a workspace file into the CAS and describe it.
 *
 * The wizard needs the hash to build a goal and the columns to ask its next
 * question; doing both in one call is what keeps "which column do you predict"
 * a dropdown rather than a free-text field that fails at staging.
 */
export async function handleIngestDataset(
  request: IncomingMessage,
  response: ServerResponse,
  deps: {
    cas: Pick<import("@sciencediscovery/cas").ContentStore, "put">;
    resolve: (sessionId: string, path: string) => string;
  },
): Promise<void> {
  const body = await readJson<{
    content?: string;
    path?: string;
    raw?: boolean;
    sessionId?: string;
  }>(request);
  if (!body.sessionId) return sendError(response, 400, "sessionId is required");
  if (!body.path && body.content === undefined) {
    return sendError(response, 400, "path or content is required");
  }
  try {
    const summary = await ingestDataset({
      cas: deps.cas,
      ...(body.content === undefined ? {} : { content: body.content }),
      path: body.path ?? "",
      raw: body.raw === true,
      resolve: (path) => deps.resolve(body.sessionId!, path),
    });
    sendJson(response, 200, summary);
  } catch (error) {
    if (error instanceof DatasetIntakeError) return sendError(response, 400, error.message);
    throw error;
  }
}

/**
 * One candidate's source, by the hash the event stream carries.
 *
 * Read off the disk the sidecar wrote it to rather than out of the CAS: a
 * candidate is not an artifact yet. Most of them are refused, and copying every
 * one into content-addressed storage would fill it with programs nobody keeps —
 * the copy happens when a user saves one, which is a decision, not a side
 * effect of having tried it.
 */
export async function handleGetCandidate(
  response: ServerResponse,
  store: EvolutionStore,
  candidates: { read: (runId: string, hash: string) => Promise<string | undefined> },
  runId: string,
  hash: string,
): Promise<void> {
  const run = await readRunOr404(response, store, runId);
  if (!run) return;
  const source = await candidates.read(runId, hash);
  if (source === undefined) {
    // A hash the run never produced, or a source pruned with its run. Either
    // way there is nothing to show, and saying "not found" beats an empty diff
    // that reads as "the candidate changed nothing".
    return sendError(response, 404, "Candidate source not found");
  }
  sendJson(response, 200, { hash, source });
}

export async function handleGetRun(
  response: ServerResponse,
  store: EvolutionStore,
  runId: string,
): Promise<void> {
  const run = await readRunOr404(response, store, runId);
  if (run) sendJson(response, 200, run);
}

export async function handleStopRun(
  response: ServerResponse,
  store: EvolutionStore,
  orchestrator: EvolveOrchestrator,
  runId: string,
): Promise<void> {
  const run = await readRunOr404(response, store, runId);
  if (!run) return;
  if (!isEvolveRunActive(run.status)) {
    // Already finished; report the run rather than an error, because the
    // browser routinely races the terminal event.
    return sendJson(response, 200, run);
  }
  await orchestrator.stop(runId);
  sendJson(response, 202, { runId, stopping: true });
}

/**
 * Events, either as a list or as a live SSE stream.
 *
 * The stream replays from the log first and only then attaches to the live
 * feed, with records buffered in between — attaching after the replay would
 * drop anything that arrived while the file was being read, which on a fast
 * search is most of the interesting part.
 */
export async function handleRunEvents(
  request: IncomingMessage,
  response: ServerResponse,
  store: EvolutionStore,
  orchestrator: EvolveOrchestrator,
  runId: string,
  after: number,
): Promise<void> {
  const run = await readRunOr404(response, store, runId);
  if (!run) return;

  const wantsSse = /\btext\/event-stream\b/.test(request.headers.accept ?? "");
  if (!wantsSse) {
    sendJson(response, 200, await store.readEvents(runId, after));
    return;
  }

  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  });
  response.flushHeaders();

  let lastSequence = after;
  let buffering = true;
  const buffered: EvolveEventRecord[] = [];
  let sawTerminal = !isEvolveRunActive(run.status);

  const deliver = (record: EvolveEventRecord): void => {
    if (record.sequence <= lastSequence) return;
    lastSequence = record.sequence;
    writeSse(response, record);
    if (record.event.type === "search_finished") sawTerminal = true;
  };

  const unsubscribe = orchestrator.subscribe(
    runId,
    (record) => {
      if (buffering) {
        buffered.push(record);
        return;
      }
      deliver(record);
      if (sawTerminal) response.end();
    },
    // A run can settle without a `search_finished` — staging failed, or the
    // sidecar was never reached. Without this the socket waits for an event
    // that is never coming.
    () => { response.end(); },
  );
  response.once("close", unsubscribe);

  for (const record of await store.readEvents(runId, after)) deliver(record);
  buffering = false;
  for (const record of buffered.toSorted((left, right) => left.sequence - right.sequence)) deliver(record);
  if (sawTerminal) response.end();
}

function writeSse(response: ServerResponse, record: EvolveEventRecord): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(`id: ${record.sequence}\n`);
  response.write(`data: ${JSON.stringify(record)}\n\n`);
}

async function readRunOr404(
  response: ServerResponse,
  store: EvolutionStore,
  runId: string,
): Promise<Awaited<ReturnType<EvolutionStore["readRun"]>>> {
  let run;
  try {
    run = await store.readRun(runId);
  } catch (error) {
    // An invalid id (path traversal, empty) reads as "not found" to the caller;
    // the store already refused to touch the filesystem.
    if (error instanceof EvolutionStoreError) {
      sendError(response, 404, "Evolve run not found");
      return undefined;
    }
    throw error;
  }
  if (!run) {
    sendError(response, 404, "Evolve run not found");
    return undefined;
  }
  return run;
}

/** A refusal the user can act on: every issue carries what to change. */
function sendPreflightRefusal(response: ServerResponse, issues: PreflightIssue[]): void {
  sendJson(response, 400, {
    error: issues[0]!.message,
    issues: issues.map((issue) => ({ code: issue.code, fix: issue.fix, message: issue.message })),
  });
}
