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
 * `ScienceDiscovery evolve …` and `ScienceDiscovery idea …`: list, inspect,
 * follow and control the two long-running engines of a running `serve`.
 *
 * Every action calls the route the Web card already calls, so stopping from
 * here and stopping from the card are the same request. Address, token and
 * output mode resolve exactly as for `run`.
 *
 * Output:
 *  - text (default on a TTY, or --output text): readable lines on stdout;
 *    connection notes and the final verdict of `watch` on stderr.
 *  - jsonl (default when piped): the endpoint's own objects, one per line, on
 *    stdout. `watch` adds `reconnect` lines and a closing `result` line, and a
 *    failure is an `error` line — so `jq` never sees anything but JSON.
 */
import type { EngineSettings } from "./cli-options.js";
import {
  ApiRequestError,
  ControlPlaneClient,
  type EvolveEventRecord,
  type EvolveRunRecord,
  type IdeaResearchView,
} from "./control-plane-client.js";
import { resolveControlPlane } from "./run.js";
import type { ServeSettings } from "./serve.js";

export interface EngineContext {
  settings: ServeSettings;
  engineSettings: EngineSettings;
  baseEnv: NodeJS.ProcessEnv;
}

/** Test seams; the defaults are what the CLI uses. */
export interface EngineDependencies {
  /** Where results go; its `isTTY` picks the default output mode. */
  stdout?: { isTTY?: boolean; write: (chunk: string) => unknown };
  /** Milliseconds to wait before reconnection attempt `attempt` (1-based). */
  reconnectDelay?: (attempt: number) => number;
  /** Consecutive failed reconnections before `watch` gives up. */
  maxReconnects?: number;
}

/** Exit codes shared with `run`: 0 completed, 1 failed, 130 cancelled. */
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_STOPPED = 130;

const EVOLVE_TERMINAL = new Set(["budget_exhausted", "failed", "stopped", "succeeded"]);
const IDEA_ACTIVE = new Set(["running", "pausing"]);

/** Backoff 1 s, 2 s, 4 s … capped at 30 s: ten attempts span about three minutes. */
const defaultReconnectDelay = (attempt: number): number => Math.min(1000 * 2 ** (attempt - 1), 30_000);
const DEFAULT_MAX_RECONNECTS = 10;

class Output {
  constructor(
    readonly mode: "jsonl" | "text",
    private readonly stdout: { write: (chunk: string) => unknown },
    private readonly log: (message: string) => void,
  ) {}

  get text(): boolean {
    return this.mode === "text";
  }

  json(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  line(text: string): void {
    this.stdout.write(`${text}\n`);
  }

  /** Verbatim, for content a script saves (a candidate's source). */
  raw(text: string): void {
    this.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  /** Status for a person; only text mode has a place for it. */
  note(text: string): void {
    if (this.text) this.log(text);
  }

  error(prefix: string, message: string, code: string | undefined, extra: Record<string, unknown> = {}): void {
    if (this.text) this.log(`[${prefix}] ${message}`);
    else this.json({ type: "error", message, ...(code ? { code } : {}), ...extra });
  }
}

export async function engineCommand(
  context: EngineContext,
  log: (message: string) => void,
  dependencies: EngineDependencies = {},
): Promise<{ exitCode: number }> {
  const { settings, engineSettings: options, baseEnv } = context;
  const { baseUrl, token } = resolveControlPlane(settings, options.token, baseEnv);
  const stdout = dependencies.stdout ?? process.stdout;
  const requested = options.output ?? (stdout.isTTY ? "text" : "jsonl");
  const out = new Output(requested === "text" ? "text" : "jsonl", stdout, log);
  const client = new ControlPlaneClient({ baseUrl, token });

  if (!(await client.health())) {
    out.error(options.engine, `Could not reach ScienceDiscovery serve at ${baseUrl}. Start it with: ScienceDiscovery serve`, "ECONNREFUSED");
    return { exitCode: EXIT_FAILED };
  }
  try {
    const exitCode = options.engine === "evolve"
      ? await evolveAction(client, options, out, dependencies)
      : await ideaAction(client, options, out, dependencies);
    return { exitCode };
  } catch (error) {
    const subject = options.engine === "evolve"
      ? { ...(options.id ? { runId: options.id } : {}) }
      : { ...(options.id ? { researchId: options.id } : {}), sessionId: options.sessionId };
    out.error(options.engine, describeError(error), errorCode(error), subject);
    return { exitCode: EXIT_FAILED };
  }
}

// ---------------------------------------------------------------------------
// evolve

async function evolveAction(
  client: ControlPlaneClient,
  options: EngineSettings,
  out: Output,
  dependencies: EngineDependencies,
): Promise<number> {
  const id = options.id as string;
  switch (options.action) {
    case "list": {
      const runs = await client.listEvolveRuns(options.sessionId);
      if (!out.text) {
        for (const run of runs) out.json(run);
      } else if (!runs.length) {
        out.note("No evolve searches.");
      } else {
        out.line(table([
          ["ID", "STATUS", "CANDIDATES", "TOKENS", "CREATED", "GOAL"],
          ...runs.map((run) => [
            run.id,
            run.status,
            candidateCount(run),
            String(run.tokens ?? 0),
            run.createdAt ?? "",
            truncate(run.goal?.statement ?? "", 60),
          ]),
        ]));
      }
      return EXIT_OK;
    }
    case "get": {
      if (options.candidate) {
        const candidate = await client.getEvolveCandidate(id, options.candidate);
        if (out.text) out.raw(candidate.source);
        else out.json(candidate);
        return EXIT_OK;
      }
      const run = await findEvolveRun(client, id);
      if (out.text) out.line(describeEvolveRun(run));
      else out.json(run);
      return EXIT_OK;
    }
    case "stop": {
      const result = await client.stopEvolveRun(id);
      if (!out.text) {
        out.json(result);
      } else if ("stopping" in result) {
        out.line(`Stopping evolve run ${id}. Follow it to the end with: ScienceDiscovery evolve watch ${id}`);
      } else {
        out.line(`Evolve run ${id} had already ended: ${String(result.status)}.`);
      }
      return EXIT_OK;
    }
    case "watch":
      return await watchEvolve(client, id, options.after ?? 0, out, dependencies);
    default:
      throw new Error(`evolve does not support ${options.action}`);
  }
}

async function watchEvolve(
  client: ControlPlaneClient,
  id: string,
  after: number,
  out: Output,
  dependencies: EngineDependencies,
): Promise<number> {
  let run = await findEvolveRun(client, id);
  // The resume cursor: the last sequence printed. A reconnect asks only for
  // what came after it, and anything at or below it is never printed twice.
  let cursor = after;
  out.note(`[evolve] watching ${id}: ${run.status}, ${candidateCount(run)} candidates${cursor ? `, after sequence ${cursor}` : ""}`);

  const detached = await followStream({
    connect: (progressed, signal) => client.subscribeEvolveEvents(id, cursor, (record) => {
      if (record.sequence <= cursor) return;
      cursor = record.sequence;
      progressed();
      if (!out.text) {
        out.json(record);
        return;
      }
      const text = describeEvolveEvent(record);
      if (text) out.line(`#${record.sequence} ${text}`);
    }, signal),
    // The server closes the stream once the run settles, and folds the final
    // status into the run record before it publishes the terminal event — so
    // the record, not the stream, says how it ended.
    finished: async () => {
      run = await findEvolveRun(client, id);
      return EVOLVE_TERMINAL.has(run.status);
    },
    onReconnect: (attempt, max, reason) => {
      if (out.text) out.note(`[evolve] connection lost (${reason}); reconnecting after sequence ${cursor} (attempt ${attempt}/${max})`);
      else out.json({ type: "reconnect", runId: id, after: cursor, attempt, maxAttempts: max, reason });
    },
  }, dependencies);

  if (detached) {
    out.note(`[evolve] stopped watching ${id} after sequence ${cursor}; the search keeps running. Stop it with: ScienceDiscovery evolve stop ${id}`);
    return EXIT_STOPPED;
  }
  const exitCode = run.status === "succeeded" ? EXIT_OK : run.status === "stopped" ? EXIT_STOPPED : EXIT_FAILED;
  if (out.text) {
    out.note(`[evolve] ${id} ${run.status}${run.error ? `: ${run.error}` : ""}`);
  } else {
    out.json({
      type: "result",
      runId: id,
      sessionId: run.sessionId,
      status: run.status,
      candidates: run.candidates ?? 0,
      bestNodeIndex: run.bestNodeIndex ?? null,
      error: run.error ?? null,
      lastSequence: cursor,
    });
  }
  return exitCode;
}

/** There is no single-run route; the list the dashboard reads is the source. */
async function findEvolveRun(client: ControlPlaneClient, id: string): Promise<EvolveRunRecord> {
  const run = (await client.listEvolveRuns()).find((candidate) => candidate.id === id);
  if (!run) throw new ApiRequestError(`Evolve run not found: ${id}`, 404, "NOT_FOUND");
  return run;
}

function candidateCount(run: EvolveRunRecord): string {
  const planned = run.goal?.budget?.expansions;
  return planned ? `${run.candidates ?? 0}/${planned}` : String(run.candidates ?? 0);
}

function describeEvolveRun(run: EvolveRunRecord): string {
  return fields([
    ["Run", run.id],
    ["Status", run.status],
    ["Goal", run.goal?.statement],
    ["Algorithm", run.algorithm],
    ["Candidates", candidateCount(run)],
    ["Best node", run.bestNodeIndex],
    ["Tokens", run.tokens],
    ["Cost (cents)", run.costCents],
    ["Session", run.sessionId],
    ["Project", run.projectId],
    ["Created", run.createdAt],
    ["Started", run.startedAt],
    ["Finished", run.finishedAt],
    ["Error", run.error],
  ]);
}

/** One line per event a person follows; the bookkeeping ones are JSONL-only. */
function describeEvolveEvent(record: EvolveEventRecord): string | undefined {
  const event = record.event;
  switch (event.type) {
    case "search_started":
      return `search started (${String(event.algorithm)})`;
    case "seeded":
      return `seeded node ${String(event.nodeIndex)}: baseline ${score(event.baselineScore)}`;
    case "expanded": {
      const head = `candidate ${String(event.nodeIndex)} from node ${String(event.parentIndex ?? "-")}`;
      if (!event.valid) return `${head}: failed${event.error ? ` — ${String(event.error)}` : ""}`;
      const hash = typeof event.codeHash === "string" ? ` [${event.codeHash}]` : "";
      return `${head}: score ${score(event.score)}${event.changeSummary ? ` — ${String(event.changeSummary)}` : ""}${hash}`;
    }
    case "merged":
      return `candidate ${String(event.nodeIndex)} ${event.accepted ? "accepted" : "refused"}: ${String(event.reason)}`;
    case "search_finished":
      return `search finished: ${String(event.status)}, ${String(event.candidates)} candidates`
        + `${event.bestNodeIndex !== null && event.bestNodeIndex !== undefined ? `, best node ${String(event.bestNodeIndex)}` : ""}`
        + `${event.stopReason ? ` (${String(event.stopReason)})` : ""}`;
    case "log":
      return `${String(event.level)}: ${String(event.message)}`;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// idea

const IDEA_OPERATIONS: Partial<Record<EngineSettings["action"], string>> = {
  continue: "continue",
  pause: "pause",
  // The card's End button: final, unlike pause.
  stop: "end",
};

async function ideaAction(
  client: ControlPlaneClient,
  options: EngineSettings,
  out: Output,
  dependencies: EngineDependencies,
): Promise<number> {
  const sessionId = options.sessionId as string;
  const id = options.id as string;
  switch (options.action) {
    case "list": {
      const { items } = await client.listIdeaResearch(sessionId);
      if (!out.text) {
        for (const view of items) out.json(view);
      } else if (!items.length) {
        out.note("No Idea Tree research in this session.");
      } else {
        out.line(table([
          ["ID", "STATUS", "ROUND", "SCORED", "TOKENS", "OBJECTIVE"],
          ...items.map((view) => [
            view.research.id,
            view.research.status,
            `${view.research.round ?? 0}/${view.research.settings?.maxRounds ?? "?"}`,
            String(scoredCandidates(view)),
            String(view.research.tokens ?? 0),
            truncate(view.research.objective ?? "", 60),
          ]),
        ]));
      }
      return EXIT_OK;
    }
    case "get": {
      const view = await client.ideaResearchCommand(sessionId, { operation: "get", researchId: id });
      if (out.text) out.line(describeResearch(view));
      else out.json(view);
      return EXIT_OK;
    }
    case "watch":
      return await watchIdea(client, sessionId, id, out, dependencies);
    default: {
      const operation = IDEA_OPERATIONS[options.action];
      if (!operation) throw new Error(`idea does not support ${options.action}`);
      const view = await client.ideaResearchCommand(sessionId, { operation, researchId: id });
      if (!out.text) {
        out.json(view);
        return EXIT_OK;
      }
      const { status, reason } = view.research;
      // `pausing` is the engine's word for winding down after either pause or
      // stop; say which one is coming rather than echo it.
      out.line(status === "pausing"
        ? `Research ${id} will ${options.action === "stop" ? "end" : "pause"} after the step in progress.`
        : `Research ${id} is ${status}${reason ? ` (${reason})` : ""}.`);
      if (IDEA_ACTIVE.has(status)) {
        out.note(`[idea] follow it with: ScienceDiscovery idea watch ${id} --session ${sessionId}`);
      }
      return EXIT_OK;
    }
  }
}

async function watchIdea(
  client: ControlPlaneClient,
  sessionId: string,
  id: string,
  out: Output,
  dependencies: EngineDependencies,
): Promise<number> {
  let view = await client.ideaResearchCommand(sessionId, { operation: "get", researchId: id });
  // Each frame is the whole current view, so there is no backlog to replay: a
  // reconnect continues from the present, and a frame identical to the last one
  // shown (the first frame after every connect) is not shown again.
  let lastStamp = stamp(view);
  const renderer = new ResearchRenderer();
  const show = (next: IdeaResearchView): void => {
    if (out.text) for (const line of renderer.render(next)) out.line(line);
    else out.json(next);
  };
  out.note(`[idea] watching ${id} in session ${sessionId}`);
  show(view);

  let detached = false;
  if (IDEA_ACTIVE.has(view.research.status)) {
    detached = await followStream({
      connect: (progressed, signal) => client.subscribeIdeaResearch(sessionId, id, (incoming) => {
        const incomingStamp = stamp(incoming);
        if (incomingStamp === lastStamp) return;
        lastStamp = incomingStamp;
        view = incoming;
        progressed();
        show(incoming);
      }, signal),
      finished: async () => !IDEA_ACTIVE.has(view.research.status),
      onReconnect: (attempt, max, reason) => {
        if (out.text) out.note(`[idea] connection lost (${reason}); reconnecting (attempt ${attempt}/${max})`);
        else out.json({ type: "reconnect", researchId: id, sessionId, attempt, maxAttempts: max, reason });
      },
    }, dependencies);
  }

  if (detached) {
    out.note(`[idea] stopped watching ${id}; the research keeps running. Stop it with: ScienceDiscovery idea stop ${id} --session ${sessionId}`);
    return EXIT_STOPPED;
  }
  const { status, reason } = view.research;
  if (out.text) {
    out.note(`[idea] ${id} ${status}${reason ? `: ${reason}` : ""}`);
  } else {
    out.json({ type: "result", researchId: id, sessionId, status, reason: reason ?? null, scored: scoredCandidates(view) });
  }
  // `paused` lands with `ended`: the engine stopped on a request and the card
  // can continue it. `interrupted` is the engine failing or the service dying.
  return status === "completed" ? EXIT_OK : status === "ended" || status === "paused" ? EXIT_STOPPED : EXIT_FAILED;
}

function stamp(view: IdeaResearchView): string {
  return view.research.updatedAt ?? JSON.stringify(view.research);
}

function scoredCandidates(view: IdeaResearchView): number {
  return (view.graph.nodes ?? []).filter((node) => node.kind === "candidate" && node.status === "done").length;
}

function describeResearch(view: IdeaResearchView): string {
  const r = view.research;
  const candidates = (view.graph.nodes ?? []).filter((node) => node.kind === "candidate");
  return [
    fields([
      ["Research", r.id],
      ["Status", r.status],
      ["Objective", r.objective],
      ["Phase", r.phase],
      ["Round", `${r.round ?? 0}/${r.settings?.maxRounds ?? "?"}`],
      ["Batch", `${r.batchCompleted ?? 0}/${r.batch?.length ?? 0}`],
      ["Tokens", `${r.tokens ?? 0}${r.usageKnown === false ? " (partly unreported)" : ""}`],
      ["Model", r.modelId as string | undefined],
      ["Reason", r.reason ?? undefined],
    ]),
    ...(candidates.length
      ? ["Candidates:", ...candidates.map((node) => `  ${node.id}  ${node.status ?? ""}  score ${score(node.score)}  ${truncate(node.hypothesis ?? "", 80)}`)]
      : []),
  ].join("\n");
}

/** Text for a stream of whole views: print only what changed since the last one. */
class ResearchRenderer {
  private lastSummary = "";
  private readonly activities = new Map<string, string>();
  private first = true;

  render(view: IdeaResearchView): string[] {
    // The first view carries the research's whole history; only the steps
    // still running are news. Finished ones are recorded as already seen.
    if (this.first) {
      this.first = false;
      for (const activity of view.research.activities ?? []) {
        if (activity.status !== "running") this.activities.set(activityKey(activity), activity.status);
      }
    }
    const r = view.research;
    const lines: string[] = [];
    const summary = [
      r.status,
      r.phase,
      `round ${r.round ?? 0}/${r.settings?.maxRounds ?? "?"}`,
      `batch ${r.batchCompleted ?? 0}/${r.batch?.length ?? 0}`,
      `${scoredCandidates(view)} scored`,
      `${r.tokens ?? 0} tokens`,
    ].filter(Boolean).join(" · ");
    if (summary !== this.lastSummary) {
      this.lastSummary = summary;
      lines.push(summary);
    }
    for (const activity of r.activities ?? []) {
      const key = activityKey(activity);
      if (this.activities.get(key) === activity.status) continue;
      this.activities.set(key, activity.status);
      lines.push(`  ${activity.role}${activity.nodeId ? ` ${activity.nodeId}` : ""}: ${activity.status}${activity.error ? ` — ${activity.error}` : ""}`);
    }
    return lines;
  }
}

type ResearchActivity = NonNullable<IdeaResearchView["research"]["activities"]>[number];

function activityKey(activity: ResearchActivity): string {
  return `${activity.startedAt}|${activity.role}|${activity.nodeId ?? ""}`;
}

// ---------------------------------------------------------------------------
// shared

interface FollowOptions {
  /** One connection. Resolves when the server ends the stream; `progressed`
   *  marks that new data arrived, which resets the reconnection budget. */
  connect: (progressed: () => void, signal: AbortSignal) => Promise<void>;
  /** After a connection ends or fails: has the engine stopped running? */
  finished: () => Promise<boolean>;
  onReconnect: (attempt: number, maxAttempts: number, reason: string) => void;
}

/**
 * Keep a stream open until the engine stops running, reconnecting after a
 * dropped connection. Ctrl-C detaches — it never stops the engine; that is
 * what `stop` is for. Resolves `true` when the user detached.
 */
async function followStream(options: FollowOptions, dependencies: EngineDependencies): Promise<boolean> {
  const delay = dependencies.reconnectDelay ?? defaultReconnectDelay;
  const maxAttempts = dependencies.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
  const abort = new AbortController();
  const onSigInt = (): void => abort.abort();
  process.on("SIGINT", onSigInt);
  try {
    let attempt = 0;
    for (;;) {
      let reason = "the stream closed while the engine was still running";
      try {
        await options.connect(() => { attempt = 0; }, abort.signal);
      } catch (error) {
        if (abort.signal.aborted) return true;
        if (!retryable(error)) throw error;
        reason = describeError(error);
      }
      if (abort.signal.aborted) return true;
      try {
        if (await options.finished()) return false;
      } catch (error) {
        if (!retryable(error)) throw error;
        reason = describeError(error);
      }
      attempt += 1;
      if (attempt > maxAttempts) {
        throw new Error(`Lost the event stream after ${maxAttempts} reconnection attempts: ${reason}`);
      }
      options.onReconnect(attempt, maxAttempts, reason);
      await sleep(delay(attempt), abort.signal);
      if (abort.signal.aborted) return true;
    }
  } finally {
    process.off("SIGINT", onSigInt);
  }
}

/** A refused request (4xx) will be refused again; anything else may be transient. */
function retryable(error: unknown): boolean {
  return !(error instanceof ApiRequestError) || error.status >= 500;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      done();
    }
  });
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 401) {
    return `${error.message} (the access token was refused; use the --data-dir serve uses, or pass --token)`;
  }
  if (error instanceof Error) {
    // fetch reports a refused or reset socket as "fetch failed" with the reason in `cause`.
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause instanceof Error && cause.message ? `${error.message}: ${cause.message}` : error.message;
  }
  return String(error);
}

function errorCode(error: unknown): string {
  if (error instanceof ApiRequestError) return error.code ?? `HTTP_${error.status}`;
  return "STREAM_ERROR";
}

function score(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Number(value.toFixed(4))) : "n/a";
}

function truncate(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

function fields(rows: Array<[string, unknown]>): string {
  const present = rows.filter(([, value]) => value !== undefined && value !== null && value !== "");
  const width = Math.max(...present.map(([label]) => label.length));
  return present.map(([label, value]) => `${label.padEnd(width)}  ${String(value)}`).join("\n");
}

/** Left-aligned columns; the last one is left ragged. */
function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
  return rows
    .map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!))).join("  "))
    .join("\n");
}
