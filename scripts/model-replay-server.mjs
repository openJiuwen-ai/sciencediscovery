#!/usr/bin/env node
// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
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

function scrub(value) {
  if (typeof value === "string") {
    return value
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
      .replace(/chatcmpl-[A-Za-z0-9_-]+/g, "<completion-id>")
      .replace(/(?:shell|task|execution):[A-Za-z0-9_-]+/g, "<execution-id>")
      .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<datetime>")
      .replace(/\b\d{13}\b/g, "<timestamp>")
      .replace(/\bws_[A-Za-z0-9_-]+\b/g, "<workspace>")
      .replace(/\/home\/zjc\/[^"\\]+/g, "<absolute-path>")
      .replace(/\b[0-9a-f]{64}\b/gi, "<hash>")
      // Handoff/input-snapshot text is workspace plumbing, not task content.
      .replace(/\n+(?:Handoff manifest visible inside your workspace:|Input snapshots visible inside your workspace:|Some parent workspace files were not copied into this private workspace; see handoff\.json for the skipped input list\.|No parent workspace input files were selected for this subagent\.).*$/s, "\n<workspace-context>");
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
  }
  return value;
}

function fingerprint(body) {
  // Tool results and generated system/tool catalogs can change between capture and replay.
  // Match the stable user/assistant transcript while omitting runtime plumbing.
  const canonical = scrub(body ?? {});
  if (Array.isArray(canonical?.messages)) {
    canonical.messages = canonical.messages.filter((message) =>
      message?.role !== "tool" && message?.role !== "system");
  }
  delete canonical.tools;
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const fingerprints = new Map();
if (captureDir) {
  records.forEach((record, index) => {
    const key = fingerprint(record.request?.body);
    const list = fingerprints.get(key) || [];
    list.push(index);
    fingerprints.set(key, list);
  });
}

function taskClass(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const text = messages.filter((message) => message?.role === "user")
    .map((message) => typeof message.content === "string" ? message.content : "")
    .at(-1) || "";
  for (const marker of ["Evidence Extraction Assignment", "### Domain", "### Research Topic", "Output limit recovery", "Scope Research", "Final"]) {
    if (text.includes(marker)) return marker;
  }
  return "";
}

function streamKey(body) {
  const text = JSON.stringify(body ?? {});
  const match = text.match(/(?:agent-workspaces|sessions)\/([^\"\/]+)/);
  return match?.[1];
}

const recordStreams = captureDir ? records.map((record) => streamKey(record.request?.body)) : [];
const recordClasses = captureDir ? records.map((record) => taskClass(record.request?.body)) : [];
const streamAssignments = new Map();
const assignedRecordStreams = new Set();

const used = new Set();
const state = {
  mode: captureDir ? "capture" : "static",
  total: captureDir ? records.length : null,
  consumed: 0,
  requests: 0,
  matched: 0,
  fallback: 0,
  failures: [],
};

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function describe(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages.at(-1) || {};
  const content = typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "");
  const cleaned = scrub(content);
  return { role: last.role, content: cleaned.slice(0, 240), tail: cleaned.slice(-240), contentLength: cleaned.length, contentHash: createHash("sha256").update(cleaned).digest("hex"), messageCount: messages.length };
}

function messageShape(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return { count: messages.length, roles: messages.map((message) => message?.role || "").join(","), lastRole: messages.at(-1)?.role || "" };
}

function nearestRecord(body, predicate) {
  const shape = messageShape(body);
  let best;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let candidate = 0; candidate < records.length; candidate += 1) {
    if (used.has(candidate) || !predicate(candidate)) continue;
    const candidateShape = messageShape(records[candidate].request?.body);
    const score = Math.abs(candidateShape.count - shape.count) * 10
      + (candidateShape.roles === shape.roles ? 0 : 3)
      + (candidateShape.lastRole === shape.lastRole ? 0 : 1);
    if (score < bestScore) { best = candidate; bestScore = score; }
  }
  return best;
}

function chooseRecord(body) {
  const key = fingerprint(body);
  const candidates = fingerprints.get(key) || [];
  const incomingStream = streamKey(body);
  const assignedStream = incomingStream ? streamAssignments.get(incomingStream) : undefined;
  const incomingClass = taskClass(body);
  let index;
  if (assignedStream) {
    index = candidates.find((candidate) => !used.has(candidate) && recordStreams[candidate] === assignedStream);
    if (index === undefined && incomingClass) {
      index = records.findIndex((_, candidate) => !used.has(candidate)
        && recordStreams[candidate] === assignedStream && recordClasses[candidate] === incomingClass);
    }
    if (index === undefined) {
      index = nearestRecord(body, (candidate) => recordStreams[candidate] === assignedStream);
    }
  } else if (incomingStream) {
    index = candidates.find((candidate) => !used.has(candidate) && recordStreams[candidate] && !assignedRecordStreams.has(recordStreams[candidate]));
    if (index === undefined && incomingClass) {
      index = records.findIndex((_, candidate) => !used.has(candidate) && recordClasses[candidate]
        === incomingClass && recordStreams[candidate] && !assignedRecordStreams.has(recordStreams[candidate]));
    }
    if (index === undefined) {
      index = nearestRecord(body, (candidate) => recordStreams[candidate]
        && !assignedRecordStreams.has(recordStreams[candidate]));
    }
    if (index !== undefined) {
      streamAssignments.set(incomingStream, recordStreams[index]);
      assignedRecordStreams.add(recordStreams[index]);
    }
  } else {
    index = candidates.find((candidate) => !used.has(candidate));
    if (index === undefined && incomingClass) {
      index = records.findIndex((_, candidate) => !used.has(candidate) && recordClasses[candidate] === incomingClass);
    }
    if (index === undefined) index = nearestRecord(body, () => true);
  }
  if (index !== undefined) {
    state.matched += 1;
    used.add(index);
    return records[index];
  }
  const fallbackIndex = records.findIndex((_, candidate) => !used.has(candidate));
  if (fallbackIndex >= 0) {
    state.fallback += 1;
    if (state.fallback <= 20) { const incoming = describe(body); const recorded = describe(records[fallbackIndex].request?.body); console.error(JSON.stringify({ replayFallback: state.fallback, incoming, recorded })); }
    used.add(fallbackIndex);
    return records[fallbackIndex];
  }
  return undefined;
}

const server = createServer(async (request, response) => {
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
    let requestJson;
    try { requestJson = JSON.parse(await requestBody(request)); } catch { requestJson = {}; }
    const record = chooseRecord(requestJson);
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
