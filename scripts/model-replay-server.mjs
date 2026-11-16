#!/usr/bin/env node
// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const captureDir = argument("--capture-dir");
const staticResponse = argument("--static-response");
const token = process.env.E2E_REPLAY_TOKEN || argument("--token", "daily-model-replay-token");
const port = Number(argument("--port", "0"));
if ((!captureDir && !staticResponse) || (captureDir && staticResponse)) {
  throw new Error("Provide exactly one of --capture-dir or --static-response");
}
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid --port");

const records = [];
if (captureDir) {
  const directory = resolve(captureDir);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  for (const name of names) {
    const record = JSON.parse(await readFile(resolve(directory, name), "utf8"));
    if (record?.response?.body === undefined || !Number.isInteger(record.response.status)) {
      throw new Error(`Invalid replay record: ${resolve(directory, name)}`);
    }
    records.push(record);
  }
  if (!records.length) throw new Error(`No replay records found in ${directory}`);
}

let staticBody;
if (staticResponse) staticBody = await readFile(resolve(staticResponse), "utf8");

const state = {
  mode: captureDir ? "capture" : "static",
  total: captureDir ? records.length : null,
  consumed: 0,
  requests: 0,
  failures: [],
};

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/__replay/status") {
    json(response, 200, state);
    return;
  }
  if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
    json(response, 404, { error: { message: "daily model replay only serves chat completions" } });
    return;
  }
  state.requests += 1;
  if (request.headers.authorization !== `Bearer ${token}`) {
    state.failures.push("invalid replay token");
    json(response, 401, { error: { message: "invalid daily model replay token" } });
    return;
  }

  let status = 200;
  let body = staticBody;
  let contentType = "application/json";
  if (captureDir) {
    const record = records[state.consumed];
    if (!record) {
      const message = `replay exhausted after ${state.consumed} recorded calls`;
      state.failures.push(message);
      json(response, 500, { error: { message } });
      return;
    }
    state.consumed += 1;
    status = record.response.status;
    body = record.response.body;
    contentType = record.response.headers?.["content-type"] || "text/event-stream";
  } else {
    state.consumed += 1;
  }
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(body);
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(JSON.stringify({
    ready: true,
    baseUrl: `http://127.0.0.1:${actualPort}/v1`,
    statusUrl: `http://127.0.0.1:${actualPort}/__replay/status`,
    mode: state.mode,
    total: state.total,
  }) + "\n");
});

function stop() {
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
