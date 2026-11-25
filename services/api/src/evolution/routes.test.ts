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
 * Route tests over real HTTP, against a fake sidecar.
 *
 * This is the acceptance probe for the commit: a browser-shaped client creates
 * a run, follows the SSE stream and sees the whole event sequence.
 *
 * The handlers are mounted on a bare server rather than through
 * `createApiServer`, because importing that pulls in `environment.ts`, which
 * probes `/usr/bin/bash` at module load and therefore cannot be imported on a
 * macOS dev box. A probe that only ever runs in CI is a probe nobody runs while
 * writing the code, so the URL table is left to typecheck and the handlers —
 * where the behaviour is — are tested everywhere.
 */

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { after, test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
// Hooks are frozen once collection ends, so a helper a test body calls cannot
// register one while it runs. It hands its teardown to this list instead, and
// the one hook declared here — at collection time — drains it, which is the
// order the module-level `after` calls used to run in.
const cleanups: Array<() => unknown> = [];
const cleanup = (fn: () => unknown) => { cleanups.push(fn); };
after(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";


import type { EvolveEvent, EvolveGoal, EvolveRun } from "@sciencediscovery/schema";
import { isEvolveRunActive } from "@sciencediscovery/schema";

import { EvolveOrchestrator } from "./orchestrator.js";
import {
  handleGetCandidate,
  handleListRuns,
  handleRetryRun,
  handleRunEvents,
  handleStopRun,
} from "./routes.js";
import { EvolveSidecarClient } from "./sidecar.js";
import { CandidateSources } from "./candidates.js";
import { EvolutionStore } from "./store.js";
import { SessionStoreHttpError, type SessionStore } from "../store.js";

function goal(expansions = 2): EvolveGoal {
  return {
    algorithm: "puct",
    baselineProgramCas: "sha256:baseline",
    budget: { candidateTimeoutSeconds: 60, expansions, maxCostCents: 500, maxSeconds: 1800, maxTokens: 200_000 , maxTokensPerCall: 16_000, workers: 1 },
    // These tests are about HTTP, not about search: the stub needs no dataset.
    engine: "stub",
    thinking: "disabled",
    frozen: [],
    modelId: "model-1",
    scorecard: {
      aggregate: "weighted_sum",
      confirmedAt: "2026-08-19T00:00:00.000Z",
      confirmedBy: "tester",
      constraints: [],
      criteria: [{
        direction: "maximize",
        id: "f1",
        measure: {
          datasetCas: ["sha256:data"],
          kind: "dataset_metric",
          metric: { direction: "maximize", name: "f1" },
          split: { gateShards: 4, rolloutShards: 4, seed: 0, shardRows: 10, testShards: 4, trainRows: null },
          target: "y",
        },
        name: "f1",
        normalize: { kind: "identity" },
        weight: 1,
      }],
      derivedFrom: { draftRunId: "draft", statement: "s" },
      hash: "sha256:card",
      schemaVersion: 1,
      solvedThreshold: 0.999,
    },
    schemaVersion: 2,
    statement: "Push the score up",
    target: { entrypoint: "main.py", kind: "program", programId: "p" },
  };
}

const SEQUENCE: EvolveEvent[] = [
  { algorithm: "puct", scorecardHash: "sha256:card", type: "search_started" },
  { baselineScore: 0.5, nodeIndex: 0, type: "seeded" },
  { depth: 1, nodeIndex: 1, parentIndex: 0, score: 0.62, type: "expanded", valid: true },
  { criteria: { f1: 0.62 }, nodeIndex: 1, reward: 0.62, type: "evaluated" },
  { accepted: true, nodeIndex: 1, reason: "the hold-out gate score improved", type: "merged" },
  { bestNodeIndex: 1, candidates: 2, status: "succeeded", type: "search_finished" },
];

async function startFakeSidecar(
  options: { delayMs?: number } = {},
): Promise<{ close: () => Promise<void>; url: string }> {
  const server: Server = createServer(async (request, response) => {
    if (request.url?.endsWith("/stop")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ stopped: true }));
      return;
    }
    if (options.delayMs) await new Promise((done) => setTimeout(done, options.delayMs));
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    SEQUENCE.forEach((event, index) => {
      response.write(`${JSON.stringify({ createdAt: new Date().toISOString(), event, sequence: index + 1 })}\n`);
    });
    response.end();
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    close: () => new Promise<void>((closed) => { server.close(() => closed()); }),
    url: `http://127.0.0.1:${port}`,
  };
}

interface ApiOptions {
  sidecarDelayMs?: number;
  /** Stand-in for the application store's Session write guard. */
  sessions?: Pick<SessionStore, "assertSessionWritable">;
}

/** The same URL shapes `http/index.ts` matches, mounted on a bare server. */
async function startApi(
  options: ApiOptions = {},
): Promise<{ orchestrator: EvolveOrchestrator; origin: string; store: EvolutionStore }> {
  const sidecar = await startFakeSidecar({ delayMs: options.sidecarDelayMs });
  const dataDir = resolve(process.cwd(), ".tmp", `evolve-routes-${Date.now()}-${process.pid}-${counter++}`);
  const store = new EvolutionStore(dataDir);
  await store.initialize();
  const orchestrator = new EvolveOrchestrator(
    store,
    new EvolveSidecarClient({ internalToken: "test", url: sidecar.url }),
    null,
    // These tests are about the HTTP layer; a fixed capability keeps the retry
    // isolation check independent of whether this host has bubblewrap.
    async () => ({ backend: "bwrap", bwrapPath: "bwrap", disableUserns: false, procMode: "proc" }),
  );

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/evolve/runs" && request.method === "GET") {
        return handleListRuns(response, store, url.searchParams.get("sessionId"));
      }
      const events = url.pathname.match(/^\/api\/evolve\/runs\/([^/]+)\/events$/);
      if (events && request.method === "GET") {
        const after = Number(url.searchParams.get("after") ?? "0");
        return handleRunEvents(request, response, store, orchestrator, decodeURIComponent(events[1]!), after);
      }
      const stop = url.pathname.match(/^\/api\/evolve\/runs\/([^/]+)\/stop$/);
      if (stop && request.method === "POST") {
        return handleStopRun(response, store, orchestrator, decodeURIComponent(stop[1]!));
      }
      const retry = url.pathname.match(/^\/api\/evolve\/runs\/([^/]+)\/retry$/);
      if (retry && request.method === "POST") {
        return handleRetryRun(
          response, store, orchestrator, decodeURIComponent(retry[1]!), options.sessions,
        );
      }
      const candidate = url.pathname.match(/^\/api\/evolve\/runs\/([^/]+)\/candidates\/([^/]+)$/);
      if (candidate && request.method === "GET") {
        return handleGetCandidate(
          response, store, new CandidateSources(dataDir),
          decodeURIComponent(candidate[1]!), decodeURIComponent(candidate[2]!),
        );
      }
      response.writeHead(404).end();
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  cleanup(async () => {
    // Let any run this test started settle before the directory goes away: a
    // background `drive()` still writing into a directory being removed is a
    // flake, and one that only shows up when the suite runs as a whole.
    await waitForQuiet(store);
    await new Promise<void>((closed) => { server.close(() => closed()); });
    await sidecar.close();
    await rm(dataDir, { force: true, recursive: true });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { orchestrator, origin: `http://127.0.0.1:${port}`, store };
}

let counter = 0;

/** Runs are started the way the product now starts them — through the
 *  orchestrator the `create_evolve_run` tool calls — not over a route that no
 *  longer exists. */
async function startRun(orchestrator: EvolveOrchestrator, sessionId: string): Promise<EvolveRun> {
  return await orchestrator.start({ goal: goal(), sessionId });
}


async function waitForQuiet(store: EvolutionStore): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const runs = await store.listRuns();
    if (runs.every((run) => !isEvolveRunActive(run.status))) return;
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** The handlers sit behind the global `/api/` auth gate; these tests mount
 * them directly, so the header is only here to keep the calls browser-shaped. */
const auth = { authorization: "Bearer test-token" };

test("a run created over HTTP streams its whole sequence as SSE", async () => {
  const { orchestrator, origin } = await startApi();
  const run = await startRun(orchestrator, "s1");

  const stream = await fetch(`${origin}/api/evolve/runs/${run.id}/events`, {
    headers: { ...auth, accept: "text/event-stream" },
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);

  const body = await stream.text();  // the stream closes on the terminal event
  const frames = body.split("\n\n").filter((frame) => frame.trim());
  const records = frames.map((frame) => JSON.parse(
    frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6),
  ) as { event: EvolveEvent; sequence: number });

  assert.deepEqual(records.map((record) => record.event.type), SEQUENCE.map((event) => event.type));
  assert.deepEqual(records.map((record) => record.sequence), [1, 2, 3, 4, 5, 6]);
  assert.ok(frames.every((frame) => frame.startsWith("id: ")), "every frame carries its sequence as the SSE id");

  // The stream closing is the signal the run has settled: a client that reads
  // the run the moment the socket closes must not find it still "running".
  const listed = await (await fetch(`${origin}/api/evolve/runs?sessionId=s1`, { headers: auth })).json() as EvolveRun[];
  assert.equal(listed[0]?.status, "succeeded");
  assert.ok(listed[0]?.finishedAt);
});

test("the same events are readable as JSON, and resumable with ?after=", async () => {
  const { orchestrator, origin } = await startApi();
  const run = await startRun(orchestrator, "s1");
  // Drain the stream so the run is finished before reading it back.
  await (await fetch(`${origin}/api/evolve/runs/${run.id}/events`, {
    headers: { ...auth, accept: "text/event-stream" },
  })).text();

  const all = await (await fetch(`${origin}/api/evolve/runs/${run.id}/events`, { headers: auth })).json() as unknown[];
  assert.equal(all.length, SEQUENCE.length);

  const tail = await (await fetch(`${origin}/api/evolve/runs/${run.id}/events?after=4`, { headers: auth })).json() as Array<{ sequence: number }>;
  assert.deepEqual(tail.map((record) => record.sequence), [5, 6]);
});

test("a run is listable by the session it belongs to", async () => {
  const { orchestrator, origin } = await startApi();
  const run = await startRun(orchestrator, "s-list");

  const mine = await (await fetch(`${origin}/api/evolve/runs?sessionId=s-list`, { headers: auth })).json() as EvolveRun[];
  assert.deepEqual(mine.map((item) => item.id), [run.id]);
  const others = await (await fetch(`${origin}/api/evolve/runs?sessionId=other`, { headers: auth })).json() as EvolveRun[];
  assert.equal(others.length, 0);
});

test("an unknown run 404s, and an id that could escape the data dir does too", async () => {
  const { origin } = await startApi();
  assert.equal((await fetch(`${origin}/api/evolve/runs/missing/events`, { headers: auth })).status, 404);
  // `/api/` auth is a global gate in http/index.ts, ahead of every handler, so
  // it is not re-tested here.
  assert.equal((await fetch(`${origin}/api/evolve/runs/%2E%2E%2Fescape/events`, { headers: auth })).status, 404);
});

test("a candidate's source is served by hash, and anything else is a 404", async () => {
  const { orchestrator, origin } = await startApi();
  const run = await startRun(orchestrator, "s1");

  // The fake sidecar writes no sources, so every lookup misses — which is the
  // case worth pinning: a miss is a 404, not an empty body that would render as
  // "the candidate changed nothing".
  const missing = await fetch(
    `${origin}/api/evolve/runs/${encodeURIComponent(run.id)}/candidates/${"a".repeat(64)}`,
    { headers: auth },
  );
  assert.equal(missing.status, 404);

  // The hash reaches a path join, and it comes off the wire.
  const traversal = await fetch(
    `${origin}/api/evolve/runs/${encodeURIComponent(run.id)}/candidates/${encodeURIComponent("../../../etc/passwd")}`,
    { headers: auth },
  );
  assert.equal(traversal.status, 404);

  // A run that does not exist is a 404 before the filesystem is touched at all.
  const unknown = await fetch(
    `${origin}/api/evolve/runs/nope/candidates/${"a".repeat(64)}`, { headers: auth },
  );
  assert.equal(unknown.status, 404);
});


test("retrying a failed run re-creates it from the persisted goal", async () => {
  const { origin, store } = await startApi();
  const original = await store.createRun({ goal: goal(7), projectId: "p1", sessionId: "s-retry" });
  await store.finishRun(original.id, "failed", {
    code: "service_restart",
    message: "the control plane restarted",
  });

  const response = await fetch(`${origin}/api/evolve/runs/${original.id}/retry`, {
    headers: auth,
    method: "POST",
  });
  assert.equal(response.status, 201);
  const created = await response.json() as EvolveRun;

  assert.notEqual(created.id, original.id, "retry starts a new record");
  assert.deepEqual(created.goal, original.goal, "the frozen goal, budget and scorecard are reused");
  assert.equal(created.sessionId, original.sessionId);
  assert.equal(created.projectId, "p1");
  assert.equal(created.retryOfRunId, original.id);

  // Let the replacement settle so the harness's cleanup is not racing a live
  // run, and prove it really ran instead of only being created.
  await (await fetch(`${origin}/api/evolve/runs/${created.id}/events`, {
    headers: { ...auth, accept: "text/event-stream" },
  })).text();
  assert.equal((await store.readRun(created.id))?.status, "succeeded");
});

test("retry refuses a run that did not fail, or a session that is already busy", async () => {
  const { origin, store } = await startApi();
  const finished = await store.createRun({ goal: goal(), sessionId: "s-finished" });
  await store.finishRun(finished.id, "succeeded");

  const notFailed = await fetch(`${origin}/api/evolve/runs/${finished.id}/retry`, {
    headers: auth,
    method: "POST",
  });
  assert.equal(notFailed.status, 409);
  assert.match(await notFailed.text(), /Only a failed search/);

  const failed = await store.createRun({ goal: goal(), sessionId: "s-busy" });
  await store.finishRun(failed.id, "failed", { code: "search_failed", message: "broken evaluator" });
  const live = await store.createRun({ goal: goal(), sessionId: "s-busy" });
  await store.patchRun(live.id, { status: "running" });

  const busy = await fetch(`${origin}/api/evolve/runs/${failed.id}/retry`, {
    headers: auth,
    method: "POST",
  });
  assert.equal(busy.status, 409);
  assert.match(await busy.text(), /already has a search running/);

  // Quiet the synthetic live run before the cleanup removes the directory.
  await store.finishRun(live.id, "stopped");
});

test("retry of an unknown run is a 404", async () => {
  const { origin } = await startApi();
  const response = await fetch(`${origin}/api/evolve/runs/missing/retry`, {
    headers: auth,
    method: "POST",
  });
  assert.equal(response.status, 404);
});


test("retry refuses an archived or evidence-locked session before creating a run", async () => {
  const { origin, store } = await startApi({
    sessions: {
      assertSessionWritable(sessionId: string) {
        if (sessionId === "s-archived") throw new Error("Session is archived and read-only");
        throw new SessionStoreHttpError("导入证据快照为只读，请创建新会话继续研究。", 409, "SESSION_EVIDENCE_LOCKED");
      },
    },
  });
  for (const [sessionId, expected] of [
    ["s-archived", /archived and read-only/],
    ["s-evidence", /只读/],
  ] as const) {
    const failed = await store.createRun({ goal: goal(), sessionId });
    await store.finishRun(failed.id, "failed", { code: "service_restart", message: "interrupted" });

    const response = await fetch(`${origin}/api/evolve/runs/${failed.id}/retry`, {
      headers: auth,
      method: "POST",
    });
    assert.equal(response.status, 409, sessionId);
    assert.match(await response.text(), expected, sessionId);
    assert.equal((await store.listRuns(sessionId)).length, 1, `${sessionId}: no run was created`);
  }
});

test("two concurrent retries create only one new run", async () => {
  const { origin, store } = await startApi({ sidecarDelayMs: 150 });
  const failed = await store.createRun({ goal: goal(), sessionId: "s-concurrent" });
  await store.finishRun(failed.id, "failed", { code: "search_failed", message: "broken" });

  const retry = () => fetch(`${origin}/api/evolve/runs/${failed.id}/retry`, {
    headers: auth,
    method: "POST",
  });
  const responses = await Promise.all([retry(), retry()]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);

  const runs = await store.listRuns("s-concurrent");
  assert.equal(runs.length, 2, "the failed record plus exactly one replacement");
  assert.equal(runs.filter((run) => run.id !== failed.id).length, 1);
});
