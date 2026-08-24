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
 * The Node half of the graph mirror: batching, and the promise that a run is
 * unaffected by whatever the graph does.
 *
 * The Cypher itself is the sidecar's business and is tested there; what has to
 * hold here is that a search's events reach the sidecar in batches, that the
 * feature being off leaves no trace, and that a graph failure never reaches the
 * run.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";

import { MemoryGraphClient, MemoryGraphSink } from "@sciencediscovery/memory";

import { searchSubTaskId } from "./orchestrator.js";

interface FakeSidecar {
  batches: Array<{ records: unknown[]; search_id: string; session_id: string; task_id: string | null }>;
  close: () => Promise<void>;
  url: string;
}

async function startFakeGraph(options: { status?: number } = {}): Promise<FakeSidecar> {
  const batches: FakeSidecar["batches"] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (options.status && options.status >= 400) {
        response.writeHead(options.status).end("{}");
        return;
      }
      batches.push(JSON.parse(body || "{}"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ applied: 1, skipped: 0 }));
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    batches,
    close: () => new Promise<void>((closed) => { server.close(() => closed()); }),
    url: `http://127.0.0.1:${port}`,
  };
}

function record(sequence: number, type: string): unknown {
  return { createdAt: "2026-08-19T00:00:00.000Z", event: { type }, sequence };
}

async function settle(): Promise<void> {
  await new Promise((done) => setTimeout(done, 60));
}

test("a terminal event flushes the buffer immediately", async () => {
  const graph = await startFakeGraph();
  after(() => graph.close());
  const sink = new MemoryGraphSink(new MemoryGraphClient({ token: "t", url: graph.url }), () => true);

  sink.observeSearchProgress({ records: [record(1, "search_started")], searchId: "run-1", sessionId: "s1", taskId: searchSubTaskId("run-1") });
  sink.observeSearchProgress({ records: [record(2, "expanded")], searchId: "run-1", sessionId: "s1" });
  assert.equal(graph.batches.length, 0, "a partial batch waits for the timer");

  sink.observeSearchProgress({ records: [record(3, "search_finished")], searchId: "run-1", sessionId: "s1" });
  await settle();

  assert.equal(graph.batches.length, 1, "one batch, not three round trips");
  const batch = graph.batches[0]!;
  assert.deepEqual(batch.records.map((item) => (item as { sequence: number }).sequence), [1, 2, 3]);
  assert.equal(batch.search_id, "run-1");
  assert.equal(batch.task_id, "subtask:evolve:run-1", "the SubTask binding rides with the batch");
});

test("a partial batch is flushed by the timer", async () => {
  const graph = await startFakeGraph();
  after(() => graph.close());
  const sink = new MemoryGraphSink(new MemoryGraphClient({ token: "t", url: graph.url }), () => true);

  sink.observeSearchProgress({ records: [record(1, "expanded")], searchId: "run-2", sessionId: "s1" });
  await new Promise((done) => setTimeout(done, 400));

  assert.equal(graph.batches.length, 1);
});

test("a full buffer flushes without waiting for the timer", async () => {
  const graph = await startFakeGraph();
  after(() => graph.close());
  const sink = new MemoryGraphSink(new MemoryGraphClient({ token: "t", url: graph.url }), () => true);

  for (let sequence = 1; sequence <= 50; sequence += 1) {
    sink.observeSearchProgress({ records: [record(sequence, "expanded")], searchId: "run-3", sessionId: "s1" });
  }
  await settle();

  assert.equal(graph.batches.length, 1);
  assert.equal(graph.batches[0]!.records.length, 50);
});

test("the feature being off leaves no trace at all", async () => {
  const graph = await startFakeGraph();
  after(() => graph.close());
  const sink = new MemoryGraphSink(new MemoryGraphClient({ token: "t", url: graph.url }), () => false);

  sink.observeSearchProgress({ records: [record(1, "search_finished")], searchId: "run-4", sessionId: "s1" });
  await settle();

  assert.equal(graph.batches.length, 0, "a default-off feature must not call out");
});

test("a graph that refuses the write never reaches the run", async () => {
  const graph = await startFakeGraph({ status: 500 });
  after(() => graph.close());
  const sink = new MemoryGraphSink(new MemoryGraphClient({ token: "t", url: graph.url }), () => true);

  // The whole point of the sink layer: this is a void method that swallows its
  // own failure, so a broken graph cannot fail a search.
  sink.observeSearchProgress({ records: [record(1, "search_finished")], searchId: "run-5", sessionId: "s1" });
  await settle();
});

test("an unreachable graph never reaches the run either", async () => {
  const sink = new MemoryGraphSink(new MemoryGraphClient({ token: "t", url: "http://127.0.0.1:1" }), () => true);
  sink.observeSearchProgress({ records: [record(1, "search_finished")], searchId: "run-6", sessionId: "s1" });
  await settle();
});

test("flushing a search with nothing buffered is a no-op", async () => {
  const graph = await startFakeGraph();
  after(() => graph.close());
  const sink = new MemoryGraphSink(new MemoryGraphClient({ token: "t", url: graph.url }), () => true);

  sink.flushSearchProgress("never-started");
  await settle();
  assert.equal(graph.batches.length, 0);
});

test("the SubTask id keeps the prefix the temporal chain selects on", () => {
  // The sidecar's chain rebuild picks auto-mirrored SubTasks by this prefix; an
  // id without it would leave the search out of the session's task chain, and
  // `trace_provenance` on the winning artifact would report a broken chain.
  assert.ok(searchSubTaskId("abc").startsWith("subtask:"));
  assert.equal(searchSubTaskId("abc"), "subtask:evolve:abc");
  // The algorithm is not in the id: it lives on the SearchRun, and encoding it
  // here would make "resume with a different algorithm" look like a legal state.
  assert.equal(searchSubTaskId("abc").includes("era"), false);
});
