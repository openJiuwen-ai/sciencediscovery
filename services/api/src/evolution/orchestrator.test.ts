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
 * Lifecycle tests against a fake sidecar over real HTTP.
 *
 * The fake speaks the same NDJSON contract as `services/evolve` (the stub
 * engine's shape), so these exercise the real client, the real store and the
 * real orchestrator together — the seams where this commit's bugs would live.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { after, test } from "node:test";

import type { EvolveEvent, EvolveEventRecord, EvolveGoal, EvolveRun } from "@sciencediscovery/schema";

import { RunTokenRegistry } from "./llm-proxy.js";
import { EvolveOrchestrator } from "./orchestrator.js";
import { EvolveSidecarClient } from "./sidecar.js";
import { EvolutionStore } from "./store.js";

function temporaryDataDir(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

function goal(expansions = 2, budget: Partial<EvolveGoal["budget"]> = {}): EvolveGoal {
  return {
    algorithm: "era",
    baselineProgramCas: "sha256:baseline",
    budget: {
      candidateTimeoutSeconds: 60, expansions,
      maxCostCents: 500, maxSeconds: 1800, maxTokens: 200_000,
      maxTokensPerCall: 16_000, workers: 1,
      ...budget,
    },
    // As the workspace placeholder does: this goal names a dataset that no
    // store has, so a measuring engine would rightly refuse it at staging.
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
    statement: "把分数做上去",
    target: { entrypoint: "main.py", kind: "program", programId: "p" },
  };
}

const EXPANDED: EvolveEvent = {
  depth: 1, nodeIndex: 1, parentIndex: 0, score: 0.6, type: "expanded", valid: true,
};
const FINISHED = (status: string, best: number | null): EvolveEvent => ({
  bestNodeIndex: best, candidates: 2, status: status as EvolveEvent extends { status: infer S } ? S : never, type: "search_finished",
});

interface FakeSidecar {
  close: () => Promise<void>;
  /** Run requests as they arrived, so a test can assert what was sent. */
  requests: () => Array<Record<string, unknown>>;
  stopped: () => boolean;
  url: string;
}

/** `plan` yields the events to write; `holdUntilStop` keeps the stream open
 *  until `/stop` arrives, which is how the stop path is exercised. */
async function startFakeSidecar(options: {
  events?: EvolveEvent[];
  holdUntilStop?: boolean;
  raw?: string[];
  status?: number;
}): Promise<FakeSidecar> {
  let stopped = false;
  const requests: Array<Record<string, unknown>> = [];
  const server: Server = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/runs") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>);
      } catch { /* the malformed-body tests do not send one */ }
    }
    if (request.url?.endsWith("/stop")) {
      stopped = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ stopped: true }));
      return;
    }
    if (options.status && options.status >= 400) {
      response.writeHead(options.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: { code: "unknown_algorithm" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    if (options.raw) {
      for (const line of options.raw) response.write(line);
      response.end();
      return;
    }
    let sequence = 0;
    for (const event of options.events ?? []) {
      sequence += 1;
      response.write(`${JSON.stringify({ createdAt: new Date().toISOString(), event, sequence })}\n`);
    }
    if (options.holdUntilStop) {
      // Wait for the stop, then close with a terminal event — exactly what the
      // real sidecar does when its engine sees the flag between expansions.
      const timer = setInterval(() => {
        if (!stopped) return;
        clearInterval(timer);
        sequence += 1;
        response.write(`${JSON.stringify({
          createdAt: new Date().toISOString(), event: FINISHED("stopped", 1), sequence,
        })}\n`);
        response.end();
      }, 5);
      return;
    }
    response.end();
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    close: () => new Promise<void>((closed) => { server.close(() => closed()); }),
    requests: () => requests,
    stopped: () => stopped,
    url: `http://127.0.0.1:${port}`,
  };
}

async function harness(sidecarUrl: string, name: string, options: {
  apiOrigin?: string;
  cas?: { read: (hash: string) => Promise<Buffer> };
  publishResult?: (input: { run: EvolveRun; winnerCodeHash: string }) => Promise<void>;
  runTokens?: RunTokenRegistry;
} = {}) {
  const dataDir = temporaryDataDir(name);
  const store = new EvolutionStore(dataDir);
  await store.initialize();
  const orchestrator = new EvolveOrchestrator(
    store,
    new EvolveSidecarClient({ internalToken: "test", url: sidecarUrl }),
    null,
    undefined,
    options.runTokens ?? null,
    { apiOrigin: options.apiOrigin, cas: options.cas, publishResult: options.publishResult },
  );
  after(() => rm(dataDir, { force: true, recursive: true }));
  return { orchestrator, store };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("a full run is persisted, published and settled", async () => {
  const sidecar = await startFakeSidecar({
    events: [
      { algorithm: "era", scorecardHash: "sha256:card", type: "search_started" },
      { baselineScore: 0.5, nodeIndex: 0, type: "seeded" },
      EXPANDED,
      { cents: 21, tokens: 2100, type: "cost" },
      FINISHED("succeeded", 1),
    ],
  });
  after(() => sidecar.close());
  const { orchestrator, store } = await harness(sidecar.url, "evolve-full");

  const seen: EvolveEventRecord[] = [];
  const run = await orchestrator.start({ goal: goal(), sessionId: "s1" });
  orchestrator.subscribe(run.id, (record) => seen.push(record));

  await waitFor(async () => {
    const current = await store.readRun(run.id);
    return current?.status === "succeeded";
  }, "the run to finish");

  const persisted = await store.readEvents(run.id);
  assert.deepEqual(persisted.map((record) => record.event.type), [
    "search_started", "seeded", "expanded", "cost", "search_finished",
  ]);

  const settled = await store.readRun(run.id);
  assert.equal(settled?.status, "succeeded");
  assert.equal(settled?.lastSeq, 5);
  assert.equal(settled?.candidates, 1, "one expansion was counted");
  assert.equal(settled?.tokens, 2100);
  assert.equal(settled?.costCents, 21);
  assert.equal(settled?.bestNodeIndex, 1);
  assert.ok(settled?.finishedAt);
  assert.ok(seen.length > 0, "a live subscriber saw records too");
});

test("stop is carried through to the sidecar and leaves a resumable watermark", async () => {
  const sidecar = await startFakeSidecar({
    events: [
      { algorithm: "era", scorecardHash: "sha256:card", type: "search_started" },
      { baselineScore: 0.5, nodeIndex: 0, type: "seeded" },
      EXPANDED,
    ],
    holdUntilStop: true,
  });
  after(() => sidecar.close());
  const { orchestrator, store } = await harness(sidecar.url, "evolve-stop");

  const run = await orchestrator.start({ goal: goal(6), sessionId: "s1" });
  await waitFor(async () => (await store.readRun(run.id))?.lastSeq === 3, "the first events to land");

  assert.equal(await orchestrator.stop(run.id), true);
  await waitFor(async () => {
    const current = await store.readRun(run.id);
    return current?.status === "stopped";
  }, "the stopped terminal event");

  assert.ok(sidecar.stopped(), "the sidecar was actually told to stop");
  const settled = await store.readRun(run.id);
  assert.equal(settled?.status, "stopped");
  assert.equal(settled?.lastSeq, 4, "the watermark is the resume point");
  assert.equal((await store.readEvents(run.id)).length, 4, "nothing was lost on the way down");
});

test("a stream that ends without a terminal event fails the run rather than hanging", async () => {
  const sidecar = await startFakeSidecar({
    events: [{ algorithm: "era", scorecardHash: "sha256:card", type: "search_started" }],
  });
  after(() => sidecar.close());
  const { orchestrator, store } = await harness(sidecar.url, "evolve-truncated");

  const run = await orchestrator.start({ goal: goal(), sessionId: "s1" });
  await waitFor(async () => {
    const current = await store.readRun(run.id);
    return current?.status === "failed";
  }, "the run to be failed");

  assert.match((await store.readRun(run.id))?.error ?? "", /未收到终态事件/);
});

test("an unreachable sidecar fails the run with a readable error", async () => {
  const { orchestrator, store } = await harness("http://127.0.0.1:1", "evolve-unreachable");

  const run = await orchestrator.start({ goal: goal(), sessionId: "s1" });
  await waitFor(async () => (await store.readRun(run.id))?.status === "failed", "the run to fail");

  const failed = await store.readRun(run.id);
  assert.ok(failed?.error, "the failure carries a message the UI can show");
  assert.ok(failed?.finishedAt, "a failed run is still terminal");
});

test("a refused run surfaces the sidecar's status", async () => {
  const sidecar = await startFakeSidecar({ status: 400 });
  after(() => sidecar.close());
  const { orchestrator, store } = await harness(sidecar.url, "evolve-refused");

  const run = await orchestrator.start({ goal: goal(), sessionId: "s1" });
  await waitFor(async () => (await store.readRun(run.id))?.status === "failed", "the run to fail");
  assert.match((await store.readRun(run.id))?.error ?? "", /400/);
});

test("a replayed record is neither re-logged nor re-published", async () => {
  const record = (sequence: number, event: EvolveEvent) =>
    `${JSON.stringify({ createdAt: "2026-08-19T00:00:00.000Z", event, sequence })}\n`;
  const sidecar = await startFakeSidecar({
    raw: [
      record(1, { algorithm: "era", scorecardHash: "sha256:card", type: "search_started" }),
      record(2, EXPANDED),
      record(2, EXPANDED),  // the sidecar reconnected and replayed its buffer
      record(3, FINISHED("succeeded", 1)),
    ],
  });
  after(() => sidecar.close());
  const { orchestrator, store } = await harness(sidecar.url, "evolve-replay");

  const published: number[] = [];
  const run = await orchestrator.start({ goal: goal(), sessionId: "s1" });
  orchestrator.subscribe(run.id, (item) => published.push(item.sequence));
  await waitFor(async () => (await store.readRun(run.id))?.status === "succeeded", "the run to finish");

  assert.deepEqual((await store.readEvents(run.id)).map((item) => item.sequence), [1, 2, 3]);
  assert.equal(new Set(published).size, published.length, "no sequence was published twice");
  assert.equal((await store.readRun(run.id))?.candidates, 1, "the replayed expansion was not counted twice");
});

test("runs left running by a previous process are settled at boot", async () => {
  const { orchestrator, store } = await harness("http://127.0.0.1:1", "evolve-orphan");
  const run = await store.createRun({ goal: goal(), sessionId: "s1" });
  await store.patchRun(run.id, { status: "running" });

  assert.equal(await orchestrator.adoptOrphanedRuns(), 1);
  const settled = await store.readRun(run.id);
  assert.equal(settled?.status, "failed");
  assert.match(settled?.error ?? "", /重启/);
  assert.equal(await orchestrator.adoptOrphanedRuns(), 0, "already-terminal runs are left alone");
});

test("a token gate trips the run and says which budget ran out", async () => {
  const sidecar = await startFakeSidecar({
    events: [
      { algorithm: "era", scorecardHash: "sha256:card", type: "search_started" },
      { cents: 1, tokens: 5_000, type: "cost" },
    ],
    holdUntilStop: true,
  });
  after(() => sidecar.close());
  const { orchestrator, store } = await harness(sidecar.url, "evolve-budget-tokens");

  const run = await orchestrator.start({ goal: goal(6, { maxTokens: 4_000 }), sessionId: "s1" });
  await waitFor(async () => (await store.readRun(run.id))?.status === "budget_exhausted", "the token gate");

  assert.ok(sidecar.stopped(), "the search was asked to wind down, not killed");
  const settled = await store.readRun(run.id);
  assert.equal(settled?.status, "budget_exhausted", "not 'stopped' — nobody pressed stop");
  assert.match(settled?.error ?? "", /token 预算触顶/);
  assert.ok(settled?.lastSeq && settled.lastSeq > 0, "the watermark is still a resume point");
});

test("a cost gate trips the run", async () => {
  const sidecar = await startFakeSidecar({
    events: [
      { algorithm: "era", scorecardHash: "sha256:card", type: "search_started" },
      { cents: 900, tokens: 10, type: "cost" },
    ],
    holdUntilStop: true,
  });
  after(() => sidecar.close());
  const { orchestrator, store } = await harness(sidecar.url, "evolve-budget-cost");

  const run = await orchestrator.start({ goal: goal(6, { maxCostCents: 500 }), sessionId: "s1" });
  await waitFor(async () => (await store.readRun(run.id))?.status === "budget_exhausted", "the cost gate");
  assert.match((await store.readRun(run.id))?.error ?? "", /费用预算触顶/);
});

test("a wall-clock gate trips a search that has gone quiet", async () => {
  // No cost events at all: the run emits nothing after the first event, which
  // is exactly the case a per-event check would never catch.
  const sidecar = await startFakeSidecar({
    events: [{ algorithm: "era", scorecardHash: "sha256:card", type: "search_started" }],
    holdUntilStop: true,
  });
  after(() => sidecar.close());
  const { orchestrator, store } = await harness(sidecar.url, "evolve-budget-clock");

  const run = await orchestrator.start({ goal: goal(6, { maxSeconds: 0.15 }), sessionId: "s1" });
  await waitFor(async () => (await store.readRun(run.id))?.status === "budget_exhausted", "the wall-clock gate");
  assert.match((await store.readRun(run.id))?.error ?? "", /墙钟预算触顶/);
});

test("a run inside its budget is untouched", async () => {
  const sidecar = await startFakeSidecar({
    events: [
      { algorithm: "era", scorecardHash: "sha256:card", type: "search_started" },
      { cents: 3, tokens: 300, type: "cost" },
      FINISHED("succeeded", 1),
    ],
  });
  after(() => sidecar.close());
  const { orchestrator, store } = await harness(sidecar.url, "evolve-budget-ok");

  const run = await orchestrator.start({ goal: goal(2, { maxCostCents: 500, maxTokens: 200_000 }), sessionId: "s1" });
  await waitFor(async () => (await store.readRun(run.id))?.status === "succeeded", "the run to finish");
  assert.equal(sidecar.stopped(), false, "no gate fired");
});

test("a user stop is still reported as a stop, not as a budget", async () => {
  const sidecar = await startFakeSidecar({
    events: [{ algorithm: "era", scorecardHash: "sha256:card", type: "search_started" }],
    holdUntilStop: true,
  });
  after(() => sidecar.close());
  const { orchestrator, store } = await harness(sidecar.url, "evolve-stop-vs-budget");

  const run = await orchestrator.start({ goal: goal(6), sessionId: "s1" });
  await waitFor(async () => (await store.readRun(run.id))?.lastSeq === 1, "the first event");
  await orchestrator.stop(run.id);
  await waitFor(async () => (await store.readRun(run.id))?.status === "stopped", "the stopped status");
  assert.equal((await store.readRun(run.id))?.error, undefined);
});


test("the sidecar is told what to grade with, not only what the scorecard is called", async () => {
  const sidecar = await startFakeSidecar({ events: [EXPANDED, FINISHED("succeeded", 1)] });
  after(() => sidecar.close());
  const tokens = new RunTokenRegistry();
  const { orchestrator, store } = await harness(sidecar.url, "evolve-spec", {
    apiOrigin: "http://127.0.0.1:4310",
    runTokens: tokens,
  });

  const run = await orchestrator.start({ goal: goal(), sessionId: "s1" });
  await waitFor(async () => (await store.readRun(run.id))?.status === "succeeded", "the run to settle");

  const sent = sidecar.requests()[0]!;
  // The body, not only the hash: grading happens in the sidecar, so that is the
  // side that needs the formulas.
  assert.equal((sent.scorecard as { hash: string }).hash, goal().scorecard.hash);
  assert.equal(sent.statement, goal().statement);
  assert.equal(sent.max_tokens_per_call, goal().budget.maxTokensPerCall);
  assert.equal(sent.candidate_timeout_seconds, goal().budget.candidateTimeoutSeconds);
  assert.equal(sent.workers, goal().budget.workers);
  // The goal pins an engine here; without a pin the algorithm is the engine.
  assert.equal(sent.engine, "stub");
});

test("the model proxy URL the sidecar is handed is absolute", async () => {
  const sidecar = await startFakeSidecar({ events: [EXPANDED, FINISHED("succeeded", 1)] });
  after(() => sidecar.close());
  const { orchestrator, store } = await harness(sidecar.url, "evolve-origin", {
    apiOrigin: "http://127.0.0.1:4310",
    runTokens: new RunTokenRegistry(),
  });

  const run = await orchestrator.start({ goal: goal(), sessionId: "s1" });
  await waitFor(async () => (await store.readRun(run.id))?.status === "succeeded", "the run to settle");

  // A sidecar that had to guess this process's origin would turn every
  // expansion into a failed candidate for a reason that is not about candidates.
  const llm = sidecar.requests()[0]!.llm as { token: string; url: string };
  assert.equal(llm.url, `http://127.0.0.1:4310/internal/evolve-llm/${run.id}/v1/chat/completions`);
  assert.ok(llm.token.length > 0);
  assert.notEqual(llm.token, "");
});

/** A goal that really is measured on data, and a store that really holds it. */
function measuredGoal(): EvolveGoal {
  const base = goal();
  const { engine: _pinned, ...rest } = base;
  return {
    ...rest,
    scorecard: {
      ...base.scorecard,
      criteria: [{
        ...base.scorecard.criteria[0]!,
        measure: {
          datasetCas: [`sha256:${"b".repeat(64)}`], kind: "dataset_metric",
          metric: { direction: "maximize", name: "accuracy" },
          split: {
            gateShards: 2, rolloutShards: 2, seed: 1, shardRows: 2, testShards: 1, trainRows: null,
          },
          target: "y",
        },
      }],
    },
  };
}

function csvCas(rows: number) {
  const lines = ["x,y"];
  for (let index = 0; index < rows; index += 1) lines.push(`${index},${index}`);
  return {
    read: async (hash: string) => {
      if (hash === "b".repeat(64)) return Buffer.from(lines.join("\n") + "\n", "utf-8");
      if (hash === "c".repeat(64)) return Buffer.from("def train_and_predict(a, b): ...", "utf-8");
      throw new Error("ENOENT");
    },
  };
}

test("a measured run is staged before the sidecar is asked to start", async () => {
  const sidecar = await startFakeSidecar({ events: [EXPANDED, FINISHED("succeeded", 1)] });
  after(() => sidecar.close());
  const { orchestrator, store } = await harness(sidecar.url, "evolve-staged", {
    cas: csvCas(40),
  });

  const run = await orchestrator.start({
    goal: { ...measuredGoal(), baselineProgramCas: `sha256:${"c".repeat(64)}` },
    sessionId: "s1",
  });
  await waitFor(async () => (await store.readRun(run.id))?.status === "succeeded", "the run to settle");

  const sent = sidecar.requests()[0]!;
  assert.ok(String(sent.dataset_dir).endsWith("/dataset"), "the staged directory is handed over");
  assert.equal(sent.baseline_code, "def train_and_predict(a, b): ...");
  // No engine pin on this goal, so the algorithm is the engine.
  assert.equal(sent.engine, "era");

  const manifest = JSON.parse(
    await readFile(resolve(String(sent.dataset_dir), "manifest.json"), "utf-8"),
  ) as { criteria: Record<string, { shards: unknown[] }> };
  assert.equal(manifest.criteria.f1!.shards.length, 5);
});

test("a run whose dataset cannot be staged fails with the reason on the record", async () => {
  const sidecar = await startFakeSidecar({ events: [EXPANDED, FINISHED("succeeded", 1)] });
  after(() => sidecar.close());
  // No CAS: the goal names a dataset this control plane cannot produce.
  const { orchestrator, store } = await harness(sidecar.url, "evolve-unstageable");

  const run = await orchestrator.start({ goal: measuredGoal(), sessionId: "s1" });
  await waitFor(async () => (await store.readRun(run.id))?.status === "failed", "the run to fail");

  assert.match((await store.readRun(run.id))?.error ?? "", /内容库/);
  // The sidecar was never asked to start a search it could not measure.
  assert.equal(sidecar.requests().length, 0);
});

test("a run that dies before the sidecar answers still tells its subscribers", async () => {
  const sidecar = await startFakeSidecar({ events: [] });
  after(() => sidecar.close());
  const { orchestrator, store } = await harness(sidecar.url, "evolve-settle");

  const run = await orchestrator.start({ goal: measuredGoal(), sessionId: "s1" });
  // Without this channel an SSE client waits forever for a `search_finished`
  // that no producer will ever emit — the control plane cannot mint one,
  // because sequence numbers belong to the sidecar.
  const settled = await new Promise<string>((resolve_) => {
    orchestrator.subscribe(run.id, () => undefined, (status) => resolve_(status));
  });

  assert.equal(settled, "failed");
  assert.equal((await store.readRun(run.id))?.status, "failed");
});

/** A goal graded by a model rather than measured on data. */
function judgedGoal(): EvolveGoal {
  const base = goal();
  const { engine: _pinned, ...rest } = base;
  return {
    ...rest,
    baselineProgramCas: `sha256:${"c".repeat(64)}`,
    scorecard: {
      ...base.scorecard,
      criteria: [{
        direction: "maximize",
        id: "quality",
        measure: {
          blind: true,
          judgeModelId: "model-judge",
          kind: "llm_judge",
          rubricCas: `sha256:${"e".repeat(64)}`,
          samplesPerCandidate: 1,
          scale: { max: 9, min: 0 },
          split: { gateShards: 4, rolloutShards: 4, seed: 0, shardRows: 1, testShards: 0, trainRows: null },
          varianceThreshold: 0.2,
        },
        name: "质量",
        normalize: { kind: "identity" },
        weight: 1,
      }],
      solvedThreshold: 0.85,
    },
  };
}

test("a judged run is sent a rubric and its own model token, and no dataset", async () => {
  const sidecar = await startFakeSidecar({ events: [EXPANDED, FINISHED("succeeded", 1)] });
  after(() => sidecar.close());
  const tokens = new RunTokenRegistry();
  const { orchestrator, store } = await harness(sidecar.url, "evolve-judged", {
    apiOrigin: "http://127.0.0.1:4310",
    cas: {
      read: async (hash: string) => {
        if (hash === "e".repeat(64)) return Buffer.from("结论是否在开头。0-9 分。", "utf-8");
        if (hash === "c".repeat(64)) return Buffer.from("这是初稿。", "utf-8");
        throw new Error("ENOENT");
      },
    },
    runTokens: tokens,
  });

  const run = await orchestrator.start({ goal: judgedGoal(), sessionId: "s1" });
  await waitFor(async () => (await store.readRun(run.id))?.status === "succeeded", "the run to settle");

  const sent = sidecar.requests()[0]!;
  // Nothing is staged: this mode exists for searches that have no dataset, and
  // demanding one would refuse exactly them.
  assert.equal(sent.dataset_dir, "");
  // The draft is still read — a judged search starts *from* something, and
  // skipping it would hand the search a blank page.
  assert.equal(sent.baseline_code, "这是初稿。");
  assert.match(String(sent.rubric), /结论是否在开头/);

  // Two tokens, because the proxy pins the model to the token — which is what
  // stops a caller choosing what it is billed for. Which model each one buys is
  // the registry's own test; here it matters that they are not the same token.
  const judge = sent.judge as { token: string; url: string };
  const llm = sent.llm as { token: string };
  assert.ok(judge.token);
  assert.notEqual(judge.token, llm.token);
  assert.equal(judge.url, `http://127.0.0.1:4310/internal/evolve-llm/${run.id}/v1/chat/completions`);
  // Both died with the run: a judge token that outlived its search would be a
  // second way to spend the user's money after they stopped watching.
  assert.equal(tokens.resolve(run.id, judge.token), undefined);
  assert.equal(tokens.resolve(run.id, llm.token), undefined);
});

test("a finished run hands its winner to whatever saves results", async () => {
  // Without this the winner never leaves the evolve subsystem: watched an
  // agent finish a search at 0.83, find the workspace still holding the seed,
  // and set out to rebuild the winner from its one-line change summary — a
  // different program, and one that has never been scored.
  const sidecar = await startFakeSidecar({
    events: [
      { algorithm: "era", scorecardHash: "sha256:card", type: "search_started" },
      { baselineScore: 0.5, codeHash: "sha256:seed", nodeIndex: 0, type: "seeded" },
      { codeHash: "sha256:winner", depth: 1, nodeIndex: 1, parentIndex: 0,
        score: 0.83, type: "expanded", valid: true },
      FINISHED("succeeded", 1),
    ],
  });
  after(() => sidecar.close());

  const published: Array<{ runId: string; winnerCodeHash: string }> = [];
  const { orchestrator, store } = await harness(sidecar.url, "publish-winner", {
    publishResult: async ({ run, winnerCodeHash }) => {
      published.push({ runId: run.id, winnerCodeHash });
    },
  });

  const run = await orchestrator.start({ goal: goal(), sessionId: "s1" });
  await waitFor(async () => (await store.readRun(run.id))?.status === "succeeded", "the run to finish");
  await waitFor(() => published.length > 0, "the winner to be published");

  assert.equal(published.length, 1);
  assert.equal(published[0]!.runId, run.id);
  // The winning node's own source, not the seed's and not the last one tried.
  assert.equal(published[0]!.winnerCodeHash, "sha256:winner");
});

test("nothing is published when the seed won", async () => {
  // Node 0 winning means no candidate beat the starting point. There is no
  // result to save, and saving the seed as its own improvement would be a lie
  // told in version numbers.
  const sidecar = await startFakeSidecar({
    events: [
      { algorithm: "era", scorecardHash: "sha256:card", type: "search_started" },
      { baselineScore: 0.5, codeHash: "sha256:seed", nodeIndex: 0, type: "seeded" },
      { codeHash: "sha256:worse", depth: 1, nodeIndex: 1, parentIndex: 0,
        score: 0.2, type: "expanded", valid: true },
      FINISHED("succeeded", 0),
    ],
  });
  after(() => sidecar.close());

  const published: string[] = [];
  const { orchestrator, store } = await harness(sidecar.url, "publish-seed-won", {
    publishResult: async ({ winnerCodeHash }) => { published.push(winnerCodeHash); },
  });

  const run = await orchestrator.start({ goal: goal(), sessionId: "s1" });
  await waitFor(async () => (await store.readRun(run.id))?.status === "succeeded", "the run to finish");

  assert.deepEqual(published, []);
});

test("a run that settled stays settled when publishing throws", async () => {
  // The run searched, scored and finished. Reporting that as failed because
  // the artifact store was busy would lose the far more valuable fact.
  const sidecar = await startFakeSidecar({
    events: [
      { algorithm: "era", scorecardHash: "sha256:card", type: "search_started" },
      { baselineScore: 0.5, nodeIndex: 0, type: "seeded" },
      { codeHash: "sha256:winner", depth: 1, nodeIndex: 1, parentIndex: 0,
        score: 0.83, type: "expanded", valid: true },
      FINISHED("succeeded", 1),
    ],
  });
  after(() => sidecar.close());

  const { orchestrator, store } = await harness(sidecar.url, "publish-throws", {
    publishResult: async () => { throw new Error("artifact store unavailable"); },
  });

  const run = await orchestrator.start({ goal: goal(), sessionId: "s1" });
  await waitFor(async () => (await store.readRun(run.id))?.status === "succeeded", "the run to finish");

  assert.equal((await store.readRun(run.id))!.status, "succeeded");
});

test("an interrupted ERA run is not told it can resume", async () => {
  // The engine refuses an ERA resume outright: the tree would have to be
  // rebuilt from the event log first, and without that a new node reuses an
  // index the graph already spent. The banner promised one anyway, so a user
  // who lost fifteen candidates to a control-plane restart went looking for a
  // resume that does not exist.
  const sidecar = await startFakeSidecar({ events: [] });
  after(() => sidecar.close());
  const { orchestrator, store } = await harness(sidecar.url, "adopt-era");

  const run = await store.createRun({ goal: goal(), sessionId: "s1" });
  await store.patchRun(run.id, { status: "running" });
  await orchestrator.adoptOrphanedRuns();

  const adopted = await store.readRun(run.id);
  assert.equal(adopted?.status, "failed");
  assert.match(adopted!.error!, /ERA 不支持续跑/);
  assert.doesNotMatch(adopted!.error!, /可从断点续跑/);
});
