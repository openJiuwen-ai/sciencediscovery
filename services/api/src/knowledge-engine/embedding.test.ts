// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { EmbeddingClient } from "./embedding.js";

interface FakeServer {
  readonly baseUrl: string;
  readonly requests: Array<{ model: string; input: string[] }>;
  close: () => Promise<void>;
  failNext: (status: number) => void;
}

async function fakeEmbeddingServer(dimensions = 3): Promise<FakeServer> {
  const requests: Array<{ model: string; input: string[] }> = [];
  let failStatus: number | undefined;
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { model: string; input: string[] };
      requests.push(parsed);
      if (failStatus !== undefined) {
        const status = failStatus;
        failStatus = undefined;
        response.writeHead(status, { "content-type": "text/plain" });
        response.end("temporary failure");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: parsed.input.map((_, index) => ({
            embedding: Array.from({ length: dimensions }, (_value, dimension) => index + dimension / 10),
          })),
        }),
      );
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
    failNext: (status: number) => {
      failStatus = status;
    },
  };
}

test("embed returns one vector per input in order and batches", async () => {
  const server = await fakeEmbeddingServer();
  try {
    const client = new EmbeddingClient({
      baseUrl: server.baseUrl,
      apiKey: "k",
      model: "m",
      batchSize: 2,
    });
    const result = await client.embed(["a", "b", "c"]);
    assert.equal(result.length, 3);
    const closeTo = (actual: Float32Array, expected: number[]) => {
      assert.equal(actual.length, expected.length);
      for (let index = 0; index < expected.length; index += 1) {
        assert.ok(Math.abs(actual[index]! - expected[index]!) < 1e-6, `index ${index}: ${actual[index]} vs ${expected[index]}`);
      }
    };
    closeTo(result[0]!, [0, 0.1, 0.2]);
    closeTo(result[1]!, [1, 1.1, 1.2]);
    // Second batch restarts the per-request index: ["c"] is index 0 there.
    closeTo(result[2]!, [0, 0.1, 0.2]);
    assert.equal(server.requests.length, 2); // 2 + 1 batched
    assert.deepEqual(server.requests[0]?.input, ["a", "b"]);
  } finally {
    await server.close();
  }
});

test("embed retries a 429 once and succeeds", async () => {
  const server = await fakeEmbeddingServer();
  try {
    server.failNext(429);
    const client = new EmbeddingClient({ baseUrl: server.baseUrl, apiKey: "k", model: "m" });
    const result = await client.embedOne("hello");
    assert.equal(result.length, 3);
    assert.equal(server.requests.length, 2);
  } finally {
    await server.close();
  }
});

test("embed surfaces a permanent client error without retry", async () => {
  const server = await fakeEmbeddingServer();
  try {
    server.failNext(400);
    const client = new EmbeddingClient({ baseUrl: server.baseUrl, apiKey: "k", model: "m" });
    await assert.rejects(() => client.embedOne("hello"), /HTTP 400/);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("embed does not retry contract violations (200 with broken body)", async () => {
  // A 200 whose vector count mismatches the input is a contract violation:
  // retrying can never fix it, so exactly one request must be made.
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [] })); // zero vectors for N inputs
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no address");
  }
  let requests = 0;
  server.on("request", () => {
    requests += 1;
  });
  try {
    const client = new EmbeddingClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "k",
      model: "m",
    });
    await assert.rejects(() => client.embed(["a", "b"]), /0 vectors for 2 inputs/);
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
});
