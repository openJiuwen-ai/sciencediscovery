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
 * The `/evolve` run lifecycle: start a search, persist what it emits, fan it
 * out to browsers, and make sure every run reaches a terminal state.
 *
 * ```
 * sidecar NDJSON ─▶ store.appendEvents (events.ndjson, watermarked)
 *                └▶ subscribers (SSE)
 *                └▶ run aggregates (candidates / tokens / best / status)
 * ```
 *
 * Two invariants the rest of the feature leans on:
 *
 * * **The log is the source of truth.** Subscribers are a live convenience; a
 *   browser that reconnects replays from disk and misses nothing. The graph
 *   mirror (a later commit) is a projection of the same records.
 * * **Every run ends.** A sidecar that dies mid-stream, an API restart, or a
 *   client that walks away must all leave the run in a terminal status —
 *   otherwise the workspace card shows a spinner forever and `--resume` cannot
 *   tell "interrupted" from "in flight".
 * * **Sequence numbers belong to the producer.** The API never injects an event
 *   of its own into the stream: the sidecar assigns the numbers, and a locally
 *   minted `lastSeq + 1` would be dropped as a replay when the sidecar's own
 *   next event arrived with that number. Anything the control plane needs to
 *   say about a run (which budget gate tripped, why it failed) goes on the run
 *   record, not into the log.
 */

import { randomUUID } from "node:crypto";
import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";

import type { EvolveBudget, EvolveEvent, EvolveEventRecord, EvolveGoal, EvolveRun } from "@sciencediscovery/schema";
import { isEvolveRunActive } from "@sciencediscovery/schema";

import { apiLog } from "../logging.js";
import type { MemoryGraphSink } from "@sciencediscovery/memory";

import { DatasetStagingError, casHash, needsData, stageDataset, type DatasetSource } from "./dataset.js";
import type { RunTokenRegistry } from "./llm-proxy.js";
import { probeEvolveSandbox, toSidecarCapability, type EvolveSandboxCapability } from "./sandbox.js";
import { EvolveSidecarError, type EvolveSidecarClient } from "./sidecar.js";
import type { EvolutionStore } from "./store.js";

export type EvolveRunSubscriber = (record: EvolveEventRecord) => void;

/**
 * Told that a run is over, without an event to say so.
 *
 * A run can settle before the sidecar ever answers — staging failed, the
 * sidecar refused, the process could not reach it — and then no
 * `search_finished` exists to close a stream on. The control plane cannot
 * invent one: sequence numbers belong to the producer, and a locally minted
 * `lastSeq + 1` is dropped by the watermark as a replay.
 *
 * So this is a second channel that carries no sequence, is never persisted and
 * never reaches `events.ndjson`. A subscriber learns the run is over; the log
 * still holds exactly what the sidecar produced.
 */
export type EvolveRunSettled = (status: EvolveRun["status"]) => void;

/** Whether this goal is scored by running the project's tests. */
function gatedByTests(goal: EvolveGoal): boolean {
  return (goal.scorecard.criteria ?? []).some(
    (criterion) => criterion.measure.kind === "test_gate",
  );
}

/** The evaluator a scripted scorecard scores with, by hash, or `undefined`.
 *
 *  Its own function rather than a branch inside `judgeSetup`: what the two
 *  modes share is only that some text has to come out of the store, and
 *  merging them would put a judge model into a mode that has none. */
function scriptCas(goal: EvolveGoal): string | undefined {
  for (const criterion of goal.scorecard.criteria ?? []) {
    if (criterion.measure.kind === "custom_script") return criterion.measure.scriptCas;
  }
  return undefined;
}

/** The judge model and rubric a scorecard needs, or `undefined` when it grades
 *  by measuring something instead. */
function judgeSetup(goal: EvolveGoal): { judgeModelId: string; rubricCas: string } | undefined {
  for (const criterion of goal.scorecard.criteria ?? []) {
    if (criterion.measure.kind !== "llm_judge") continue;
    return {
      judgeModelId: criterion.measure.judgeModelId,
      rubricCas: criterion.measure.rubricCas,
    };
  }
  return undefined;
}

/** The engine that measures nothing. See `stage`. */
/**
 * `goal.search` in the shape the sidecar's engines read: an `options` bag.
 *
 * Renamed on the way across on purpose. `options` is the sidecar's own
 * catch-all — `c_puct`, `islands`, `async_ratio`, whatever an engine happens to
 * want, snake_cased and untyped — while this side keeps a typed field that
 * names only what a proposal may set. Omitted entirely when the goal says
 * nothing, so an unset tuning is upstream's defaults rather than this side's
 * opinion about what they should be.
 */
function searchOptions(goal: EvolveGoal): { options?: Record<string, unknown> } {
  const options: Record<string, unknown> = {};
  if (goal.search?.cPuct !== undefined) options.c_puct = goal.search.cPuct;
  if (goal.search?.priorExponent !== undefined) {
    options.prior_exponent = goal.search.priorExponent;
  }
  return Object.keys(options).length ? { options } : {};
}

const STUB_ENGINE = "stub";

export interface EvolveOrchestratorOptions {
  /** Absolute origin the sidecar reaches this process at, for the model proxy.
   *  Sent rather than guessed: the sidecar cannot know how this server was
   *  bound, and a wrong guess turns every expansion into a failed candidate. */
  apiOrigin?: string;
  /** Where datasets and baselines are read from. Without it a run cannot be
   *  staged, which is what a test that only exercises the stub wants. */
  cas?: DatasetSource;
  /** Where a session's project files live. Only a test-gated search needs it,
   *  and only to take one snapshot per run. */
  workspacePath?: (sessionId: string) => string;
  /** Pin an engine for every run, overriding the goal. For reproductions. */
  engine?: string;
  /**
   * Save a finished run's result: the seed and the winner, as two versions of
   * one artifact.
   *
   * A candidate is not an artifact — most are refused, and copying every one
   * into content-addressed storage would fill it with programs nobody keeps
   * (see `handleGetCandidate`). The **winner** is the exception, because it is
   * the thing the run exists to produce, and without this it never leaves the
   * evolve subsystem: watched an agent finish a search at 0.83, find the
   * workspace still holding the seed, and set out to reconstruct the winner
   * from its one-line change summary — which yields a different program that
   * has never been scored.
   *
   * Given the winner's hash rather than its source: the orchestrator is the
   * only side that knows which node won, and the candidate store is the only
   * side that can read it.
   */
  publishResult?: (input: { run: EvolveRun; winnerCodeHash: string }) => Promise<void>;
}

export interface StartEvolveRunInput {
  goal: EvolveGoal;
  projectId?: string;
  resumedFromRunId?: string;
  sessionId: string;
}

/** Live searches this process is driving, keyed by run id. */
interface InFlight {
  abort: AbortController;
  /** Which budget gate tripped, when one did. Turns the sidecar's ordinary
   *  "stopped" terminal event into `budget_exhausted`, so the dashboard can say
   *  "you ran out of tokens" rather than "someone pressed stop". */
  budgetGate?: string;
  /** Set once a stop has been requested so a second stop is a no-op. */
  stopping: boolean;
  /** Cleared when the run settles; a wall-clock gate that fires after the run
   *  is over would stop an unrelated search with the same id. */
  wallClockTimer?: NodeJS.Timeout;
}

export class EvolveOrchestrator {
  private readonly store: EvolutionStore;
  private readonly sidecar: EvolveSidecarClient;
  /** Optional: the graph is a projection, so a run works identically with the
   *  feature switched off and no sink handed in. */
  private readonly graph: MemoryGraphSink | null;
  private readonly probeSandbox: () => Promise<EvolveSandboxCapability>;
  /** Optional: without it a run gets no model access, which is what the stub
   *  engine needs and what a test wants by default. */
  private readonly runTokens: RunTokenRegistry | null;
  private readonly options: EvolveOrchestratorOptions;
  private readonly subscribers = new Map<string, Set<EvolveRunSubscriber>>();
  private readonly settleListeners = new Map<string, Set<EvolveRunSettled>>();
  private readonly inFlight = new Map<string, InFlight>();

  constructor(
    store: EvolutionStore,
    sidecar: EvolveSidecarClient,
    graph: MemoryGraphSink | null = null,
    probeSandbox: () => Promise<EvolveSandboxCapability> = () => probeEvolveSandbox(
      process.env.SCIENCE_AGENT_BWRAP_PATH?.trim() || "bwrap",
    ),
    runTokens: RunTokenRegistry | null = null,
    options: EvolveOrchestratorOptions = {},
  ) {
    this.store = store;
    this.sidecar = sidecar;
    this.graph = graph;
    this.probeSandbox = probeSandbox;
    this.runTokens = runTokens;
    this.options = options;
  }

  /**
   * Take the discrimination probe for a goal that has not been started.
   *
   * Stages exactly what a run would stage and asks the sidecar to score two
   * candidates, so the number the probe produces is the number the search will
   * see. Measuring something else would make the check meaningless.
   */
  async probe(goal: EvolveGoal, sessionId: string): Promise<{
    baseline: number;
    flat: boolean;
    label: string;
    worsened: number | null;
  }> {
    const probeId = `probe-${randomUUID()}`;
    const run = {
      goal, id: probeId, sessionId,
    } as unknown as EvolveRun;
    const engine = this.options.engine ?? goal.engine ?? goal.algorithm;

    const directory = resolve(this.store.runDirectory(probeId), "dataset");
    let staged: { baselineCode?: string; directory?: string; workspaceDir?: string };
    try {
      staged = await this.stage(run, engine, directory);
    } catch (error) {
      throw new DatasetStagingError(error instanceof Error ? error.message : String(error));
    }

    const judged = judgeSetup(goal);
    const scripted = scriptCas(goal);
    // A judged probe needs a grader, and the grader needs a token — the same
    // one-model-per-token rule the run follows. Revoked in `finally`, because a
    // probe that leaked a token would leave one alive with no run to end it.
    const judgeToken = judged
      ? this.runTokens?.issue(probeId, sessionId, judged.judgeModelId)
      : undefined;
    try {
      return await this.sidecar.probe({
        algorithm: goal.algorithm,
        ...(staged.baselineCode ? { baselineCode: staged.baselineCode } : {}),
        candidateTimeoutSeconds: goal.budget.candidateTimeoutSeconds,
        ...(staged.directory ? { datasetDir: staged.directory } : {}),
        ...(staged.workspaceDir ? { workspaceDir: staged.workspaceDir } : {}),
        engine,
        expansions: goal.budget.expansions,
        ...(judgeToken
          ? {
            judge: {
              token: judgeToken,
              url: `${this.options.apiOrigin ?? ""}/internal/evolve-llm/${probeId}/v1/chat/completions`,
            },
          }
          : {}),
        maxTokensPerCall: goal.budget.maxTokensPerCall,
        // The probe runs the starting point, and the starting point is what
        // uses these — without them here it fails as "the starting point does not run".
        ...(goal.packages?.length ? { packages: goal.packages } : {}),
        ...(judged ? { rubric: await this.readRubric(judged.rubricCas) } : {}),
        sandbox: toSidecarCapability(await this.sandboxCapability()),
        scorecard: goal.scorecard,
        scorecardHash: goal.scorecard.hash,
        ...(scripted ? { script: await this.readRubric(scripted) } : {}),
        searchId: probeId,
        statement: goal.statement,
        ...(goal.thinking ? { thinking: goal.thinking } : {}),
      });
    } finally {
      this.runTokens?.revoke(probeId);
      // The staged shards were for one question, already answered.
      await rm(this.store.runDirectory(probeId), { force: true, recursive: true })
        .catch(() => undefined);
    }
  }

  /**
   * Materialise this run's dataset and baseline program.
   *
   * Nothing is staged when the goal has no dataset-backed criterion (a
   * stub-engine placeholder), so a run that measures nothing still starts.
   * A staging failure is raised: `drive` turns it into a failed run with the
   * message on the record, which is the only place a user will look.
   */
  private async stage(
    run: EvolveRun,
    engine: string,
    into?: string,
  ): Promise<{ baselineCode?: string; directory?: string; workspaceDir?: string }> {
    const cas = this.options.cas;
    // The one engine this side knows by name, because it is this side's own
    // diagnostic mode: the stub executes nothing and measures nothing, so
    // reading a dataset out of the store and writing a dozen shard directories
    // for it would be waste plus one more thing that can fail.
    if (engine === STUB_ENGINE) return {};

    // The starting point is read whichever mode this is. A judged search has no
    // dataset and needs none, but it still starts *from* something — the draft
    // being rewritten — and skipping it would hand the search a blank page.
    const baselineCode = cas && run.goal.baselineProgramCas
      ? await this.readBaseline(cas, run)
      : undefined;

    // A test-gated search is measured against the project as it was when the
    // run started. Snapshotted rather than pointed at the live workspace: the
    // user editing a file mid-run would silently change what the candidates are
    // being judged by, and every score before and after would be incomparable.
    const workspaceDir = gatedByTests(run.goal)
      ? await this.snapshotWorkspace(run)
      : undefined;

    const needed = (run.goal.scorecard.criteria ?? []).some(needsData);
    if (!needed) {
      return {
        ...(baselineCode ? { baselineCode } : {}),
        ...(workspaceDir ? { workspaceDir } : {}),
      };
    }
    if (!cas) {
      throw new DatasetStagingError(
        "this control plane has no content store configured, so it cannot stage a dataset for this search",
      );
    }

    const directory = into ?? resolve(this.store.runDirectory(run.id), "dataset");
    const staged = await stageDataset({ cas, directory, scorecard: run.goal.scorecard });
    apiLog.info("evolve_dataset_staged", {
      runId: run.id,
      shards: staged.staged.reduce((total, entry) => total + entry.shards, 0),
    });

    return {
      ...(baselineCode ? { baselineCode } : {}),
      ...(workspaceDir ? { workspaceDir } : {}),
      directory,
    };
  }

  /** Freeze the project as it is now, under the run's own directory. */
  private async snapshotWorkspace(run: EvolveRun): Promise<string> {
    const source = this.options.workspacePath?.(run.sessionId);
    if (!source) {
      throw new DatasetStagingError(
        "test-gated scoring needs the project files, and this control plane cannot reach "
        + "the session's workspace",
      );
    }
    const destination = resolve(this.store.runDirectory(run.id), "workspace");
    await cp(source, destination, { recursive: true });
    apiLog.info("evolve_workspace_snapshot", { runId: run.id });
    return destination;
  }

  /** The program or draft the search starts from. Missing is a warning, not a
   *  fault: a measured search falls back to the engine's own seed, and saying
   *  so beats a run that silently evolved something the user did not name. */
  private async readBaseline(cas: DatasetSource, run: EvolveRun): Promise<string | undefined> {
    try {
      return (await cas.read(casHash(run.goal.baselineProgramCas))).toString("utf-8");
    } catch {
      apiLog.warn("evolve_baseline_missing", { cas: run.goal.baselineProgramCas, runId: run.id });
      return undefined;
    }
  }

  /** The rubric a judged scorecard grades against, from the store.
   *
   *  Read here rather than sent by reference: the sidecar has no CAS access,
   *  and a rubric is a page of text — smaller than one candidate. */
  private async readRubric(cas: string): Promise<string> {
    const source = this.options.cas;
    if (!source) {
      throw new DatasetStagingError(
        "this control plane has no content store configured, so it cannot fetch the rubric",
      );
    }
    try {
      return (await source.read(casHash(cas))).toString("utf-8");
    } catch {
      throw new DatasetStagingError(`the rubric ${cas} is not in the content store`);
    }
  }

  /** Probed once per process: the answer cannot change without a restart, and
   *  the probe launches a real bubblewrap. */
  private sandboxPromise?: Promise<EvolveSandboxCapability>;

  sandboxCapability(): Promise<EvolveSandboxCapability> {
    this.sandboxPromise ??= this.probeSandbox();
    return this.sandboxPromise;
  }

  /**
   * Mark runs left non-terminal by a previous process as failed.
   *
   * The sidecar's stream died with the old connection, so nothing is going to
   * finish them. Doing this at boot rather than lazily means the workspace card
   * never shows a run that has been "running" since last Tuesday.
   */
  async adoptOrphanedRuns(): Promise<number> {
    const runs = await this.store.listRuns();
    let adopted = 0;
    for (const run of runs) {
      if (!isEvolveRunActive(run.status)) continue;
      // What is actually recoverable, per algorithm. PUCT refuses a resume
      // outright — its tree would have to be rebuilt from the event log first,
      // and without that a new node reuses an index the graph already spent.
      // The banner used to promise "it can be resumed" to every run regardless, so a
      // user who lost fifteen candidates to a restart went looking for a resume
      // that does not exist.
      await this.store.finishRun(run.id, "failed", run.algorithm === "puct"
        ? "the control plane restarted and this search was interrupted. PUCT cannot be "
          + "resumed (the tree cannot be rebuilt from the event log); the candidates it "
          + "already produced can be read, but continuing means starting again with the "
          + "same design"
        : "the control plane restarted and this search was interrupted; it can be resumed");
      adopted += 1;
    }
    if (adopted) apiLog.info("evolve_runs_adopted", { count: adopted });
    return adopted;
  }

  subscribe(runId: string, subscriber: EvolveRunSubscriber, onSettled?: EvolveRunSettled): () => void {
    const existing = this.subscribers.get(runId) ?? new Set<EvolveRunSubscriber>();
    existing.add(subscriber);
    this.subscribers.set(runId, existing);

    const settlers = this.settleListeners.get(runId) ?? new Set<EvolveRunSettled>();
    if (onSettled) {
      settlers.add(onSettled);
      this.settleListeners.set(runId, settlers);
    }
    return () => {
      existing.delete(subscriber);
      if (!existing.size) this.subscribers.delete(runId);
      if (onSettled) settlers.delete(onSettled);
      if (!settlers.size) this.settleListeners.delete(runId);
    };
  }

  isRunning(runId: string): boolean {
    return this.inFlight.has(runId);
  }

  /**
   * Create the run, then drive it in the background.
   *
   * Returns as soon as the record exists so the caller can answer the HTTP
   * request; the browser follows the event stream from there. A failure to even
   * reach the sidecar therefore surfaces as a failed run with a readable error
   * rather than as a 500 on the create call — the run is already a thing the
   * user can see, and hiding its failure inside a status code would lose it.
   */
  async start(input: StartEvolveRunInput): Promise<EvolveRun> {
    const run = await this.store.createRun(input);
    void this.drive(run);
    return run;
  }

  /** Ask the sidecar to stop; the terminal event still comes over the stream. */
  async stop(runId: string): Promise<boolean> {
    const entry = this.inFlight.get(runId);
    if (!entry) return false;
    if (entry.stopping) return true;
    entry.stopping = true;
    const stopped = await this.sidecar.stop(runId);
    if (!stopped) {
      // The sidecar does not know this search (it may have just finished, or
      // the process restarted). Abort the stream so the run cannot hang.
      apiLog.warn("evolve_stop_not_accepted", { runId });
      entry.abort.abort();
    }
    return true;
  }

  private async drive(run: EvolveRun): Promise<void> {
    const abort = new AbortController();
    const entry: InFlight = { abort, stopping: false };
    this.inFlight.set(run.id, entry);
    let sawTerminal = false;
    try {
      await this.store.patchRun(run.id, { startedAt: new Date().toISOString(), status: "running" });
      this.armWallClock(run, entry);
      // Issued here and revoked in `finally`: the token's lifetime is the
      // search's, so a leaked one cannot outlive the thing it was for. The
      // provider key stays in this process and is never part of the spec.
      const llmToken = this.runTokens?.issue(run.id, run.sessionId, run.goal.modelId ?? "");
      // Staged before the stream opens: a search whose dataset cannot be built
      // has nothing to measure, and finding that out at the first expansion
      // costs a model call and tells the user their candidate failed.
      const engine = this.options.engine ?? run.goal.engine ?? run.goal.algorithm;
      const staged = await this.stage(run, engine);
      // A judged scorecard needs its own model, and the proxy pins one model
      // per token — so the grader gets a token of its own, issued for the same
      // run and revoked with it.
      const judged = judgeSetup(run.goal);
      const judgeToken = judged
        ? this.runTokens?.issue(run.id, run.sessionId, judged.judgeModelId)
        : undefined;
      const rubric = judged ? await this.readRubric(judged.rubricCas) : "";
      const scripted = scriptCas(run.goal);
      const script = scripted ? await this.readRubric(scripted) : "";
      const spec = {
        algorithm: run.goal.algorithm,
        ...(staged.baselineCode ? { baselineCode: staged.baselineCode } : {}),
        candidateTimeoutSeconds: run.goal.budget.candidateTimeoutSeconds,
        ...(staged.directory ? { datasetDir: staged.directory } : {}),
        ...(staged.workspaceDir ? { workspaceDir: staged.workspaceDir } : {}),
        engine,
        expansions: run.goal.budget.expansions,
        ...(llmToken
          ? {
            llm: {
              token: llmToken,
              url: `${this.options.apiOrigin ?? ""}/internal/evolve-llm/${run.id}/v1/chat/completions`,
            },
          }
          : {}),
        ...(judgeToken
          ? {
            judge: {
              token: judgeToken,
              url: `${this.options.apiOrigin ?? ""}/internal/evolve-llm/${run.id}/v1/chat/completions`,
            },
          }
          : {}),
        maxTokensPerCall: run.goal.budget.maxTokensPerCall,
        ...searchOptions(run.goal),
        ...(run.goal.packages?.length ? { packages: run.goal.packages } : {}),
        ...(rubric ? { rubric } : {}),
        resumeFromSequence: run.lastSeq,
        ...(script ? { script } : {}),
        sandbox: toSidecarCapability(await this.sandboxCapability()),
        // The body, not only the hash: the sidecar is where grading happens, so
        // it is the side that needs the formulas.
        scorecard: run.goal.scorecard,
        scorecardHash: run.goal.scorecard.hash,
        searchId: run.id,
        statement: run.goal.statement,
        ...(run.goal.thinking ? { thinking: run.goal.thinking } : {}),
        workers: run.goal.budget.workers,
      };
      for await (const record of this.sidecar.stream(spec, abort.signal, (message) => {
        apiLog.warn("evolve_stream_line_skipped", { reason: message, runId: run.id });
      })) {
        const applied = await this.store.appendEvents(run.id, [record]);
        // A record at or below the watermark was already applied; replaying it
        // to subscribers would double-count in every consumer downstream.
        if (!applied.applied.length) continue;
        // Fold into the run record *before* publishing: a client that sees the
        // terminal event and immediately reads the run must not find it still
        // "running". The stream closing is the signal the run has settled.
        const terminal = await this.applyEvent(run.id, record.event);
        this.publish(run.id, record);
        // Only records that got past the watermark are mirrored, so the graph
        // sees exactly what the log holds. Fire-and-forget by construction: the
        // sink buffers, batches and swallows its own failures.
        this.graph?.observeSearchProgress({
          records: [record],
          searchId: run.id,
          sessionId: run.sessionId,
          taskId: searchSubTaskId(run.id),
        });
        if (terminal) sawTerminal = true;
      }
      if (!sawTerminal) {
        // The stream ended without a terminal event: the sidecar died, or was
        // killed mid-run. Either way the run is over and must say so.
        const gate = entry.budgetGate;
        if (gate) await this.finish(run.id, "budget_exhausted", gate);
        else await this.finish(run.id, "failed", "the search sidecar disconnected before finishing; no terminal event arrived");
      }
    } catch (error) {
      const message = error instanceof EvolveSidecarError || error instanceof Error
        ? error.message
        : String(error);
      apiLog.warn("evolve_run_failed", { reason: message, runId: run.id });
      await this.finish(run.id, "failed", message).catch(() => undefined);
    } finally {
      // Revoked before anyone is told the run is over, not after. "Settled"
      // has to mean the tokens are already dead: a subscriber that reacts to
      // the settle — the graph mirror, an HTTP stream closing, a test — would
      // otherwise be looking at a run that is finished and a token that still
      // spends money, and the window is small enough that nothing would ever
      // reproduce the one time it mattered.
      this.runTokens?.revoke(run.id);
      // Always, and only here: a run that died before the sidecar answered has
      // no `search_finished` to close a stream on, and one that finished
      // normally has already published it.
      this.notifySettled(run.id, (await this.store.readRun(run.id))?.status ?? "failed");
      if (entry.wallClockTimer) clearTimeout(entry.wallClockTimer);
      // A run that died without a terminal event still has buffered records.
      this.graph?.flushSearchProgress(run.id);
      this.inFlight.delete(run.id);
    }
  }

  /**
   * Trip the run when it has been going for longer than the budget allows.
   *
   * A timer rather than a check per event: a search that hangs emits nothing,
   * and the gate that matters most is exactly the one for a run that stopped
   * producing evidence it is alive.
   */
  private armWallClock(run: EvolveRun, entry: InFlight): void {
    const seconds = run.goal.budget.maxSeconds;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    entry.wallClockTimer = setTimeout(() => {
      void this.tripBudget(run.id, `wall-clock budget reached (${seconds}s)`);
    }, seconds * 1000);
  }

  /** Ask the search to wind down and remember why, so the terminal status can
   *  say "budget" rather than "stopped". */
  private async tripBudget(runId: string, gate: string): Promise<void> {
    const entry = this.inFlight.get(runId);
    if (!entry || entry.budgetGate) return;
    entry.budgetGate = gate;
    apiLog.info("evolve_budget_exhausted", { gate, runId });
    await this.stop(runId);
  }

  /** Check the spend gates after a cost event. */
  private async checkSpendBudget(runId: string, budget: EvolveBudget, tokens: number, cents: number): Promise<void> {
    if (budget.maxTokens > 0 && tokens >= budget.maxTokens) {
      await this.tripBudget(runId, `token budget reached (${budget.maxTokens})`);
      return;
    }
    if (budget.maxCostCents > 0 && cents >= budget.maxCostCents) {
      await this.tripBudget(runId, `cost budget reached (${budget.maxCostCents} cents)`);
    }
  }

  /** Fold one event into the run's aggregates. Returns whether it was terminal. */
  private async applyEvent(runId: string, event: EvolveEvent): Promise<boolean> {
    switch (event.type) {
      case "expanded": {
        const run = await this.store.readRun(runId);
        if (run) await this.store.patchRun(runId, { candidates: run.candidates + 1 });
        return false;
      }
      case "cost": {
        await this.store.patchRun(runId, { costCents: event.cents, tokens: event.tokens });
        const run = await this.store.readRun(runId);
        if (run) await this.checkSpendBudget(runId, run.goal.budget, event.tokens, event.cents);
        return false;
      }
      case "search_finished": {
        const gate = this.inFlight.get(runId)?.budgetGate;
        const reported = event.status === "running" || event.status === "pending" ? "failed" : event.status;
        // A budget-tripped run reaches the sidecar as an ordinary stop; the
        // control plane is the only side that knows why it was asked to stop.
        const status = gate && reported === "stopped" ? "budget_exhausted" : reported;
        await this.finish(runId, status, gate, event.bestNodeIndex ?? undefined);
        return true;
      }
      default:
        return false;
    }
  }

  private async finish(
    runId: string,
    status: EvolveRun["status"],
    error?: string,
    bestNodeIndex?: number,
  ): Promise<void> {
    const current = await this.store.readRun(runId);
    if (current && !isEvolveRunActive(current.status)) return; // already terminal
    if (bestNodeIndex !== undefined) await this.store.patchRun(runId, { bestNodeIndex });
    await this.store.finishRun(runId, status, error);
    if (status === "succeeded" && bestNodeIndex !== undefined) {
      await this.publishWinner(runId, bestNodeIndex);
    }
  }

  /**
   * Hand the winner to whatever saves results, after the run is terminal.
   *
   * Runs last and swallows its own failures: a run that searched, scored and
   * settled did happen, and reporting it as failed because the artifact store
   * was busy would lose the far more valuable fact.
   */
  private async publishWinner(runId: string, bestNodeIndex: number): Promise<void> {
    if (!this.options.publishResult) return;
    try {
      const run = await this.store.readRun(runId);
      if (!run) return;
      const records = await this.store.readEvents(runId);
      // The winning node's own source. `seeded` carries one too, and node 0
      // winning means nothing beat the seed — there is no result to save.
      let winnerCodeHash: string | undefined;
      for (const { event } of records) {
        const candidate = event as { codeHash?: string; nodeIndex?: number; type?: string };
        if (candidate.type !== "expanded" || candidate.nodeIndex !== bestNodeIndex) continue;
        winnerCodeHash = candidate.codeHash;
      }
      if (!winnerCodeHash) return;
      await this.options.publishResult({ run, winnerCodeHash });
    } catch (error) {
      apiLog.warn("evolve_publish_result_failed", { reason: String(error), runId });
    }
  }

  /**
   * Tell subscribers the run is over, after the last record has been published.
   *
   * Not folded into `finish`: on the ordinary path `finish` runs *before* the
   * terminal record is published (a client that sees it and immediately reads
   * the run must not find it still "running"), so notifying there would close
   * the socket one event early. Here, in `drive`'s `finally`, everything that
   * was going to be published has been.
   */
  private notifySettled(runId: string, status: EvolveRun["status"]): void {
    for (const listener of this.settleListeners.get(runId) ?? []) {
      try {
        listener(status);
      } catch (error) {
        apiLog.warn("evolve_settle_listener_failed", { reason: String(error), runId });
      }
    }
  }

  private publish(runId: string, record: EvolveEventRecord): void {
    const listeners = this.subscribers.get(runId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(record);
      } catch (error) {
        // A broken subscriber (a closed socket, usually) must not take the run
        // down with it.
        apiLog.warn("evolve_subscriber_threw", { reason: error instanceof Error ? error.message : String(error), runId });
      }
    }
  }
}

/**
 * The graph task id this search is mirrored under (a `:ToolCall` node since
 * upstream's Task/ToolCall split; the `subtask:` prefix is the business key).
 *
 * The `subtask:` prefix is not decoration: the sidecar's temporal-chain rebuild
 * selects auto-mirrored task nodes by exactly that prefix, and an id without it
 * would leave the search out of the session's task chain — which is what
 * `trace_provenance` walks when it asks whether the winning artifact can be
 * traced back to the research goal.
 *
 * The algorithm is deliberately not encoded here: it lives on the SearchRun, and
 * putting it in the id would make "resume with a different algorithm" look like
 * a legal state.
 */
export function searchSubTaskId(runId: string): string {
  return `subtask:evolve:${runId}`;
}
