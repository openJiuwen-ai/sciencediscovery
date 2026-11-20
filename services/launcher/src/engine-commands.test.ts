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
 * `evolve` / `idea` against a real HTTP server that speaks the control plane's
 * routes and SSE framing, including connections that drop mid-stream.
 */
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { after, describe, test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseInvocation, USAGE, type EngineSettings } from "./cli-options.js";
import { engineCommand } from "./engine-commands.js";
import type { ServeSettings } from "./serve.js";

const cwd = "/opt/sciencediscovery";
const TOKEN = "engine-test-token";

// ---------------------------------------------------------------------------
// option parsing

describe("evolve and idea option parsing", () => {
  test("reads the action, the id and the engine options", () => {
    assert.deepEqual(parseInvocation(["evolve", "list"], {}, cwd).engineSettings, { engine: "evolve", action: "list" });
    assert.deepEqual(
      parseInvocation(["evolve", "get", "run-1", "--candidate", "sha256:ab", "--output", "jsonl", "--token", "t"], {}, cwd).engineSettings,
      { engine: "evolve", action: "get", id: "run-1", candidate: "sha256:ab", output: "jsonl", token: "t" },
    );
    assert.equal(parseInvocation(["evolve", "watch", "run-1", "--after", "42"], {}, cwd).engineSettings?.after, 42);
    assert.equal(parseInvocation(["evolve", "list", "--session", "s1"], {}, cwd).engineSettings?.sessionId, "s1");
    for (const action of ["list", "get", "watch", "pause", "continue", "stop"]) {
      const id = action === "list" ? [] : ["research-1"];
      const parsed = parseInvocation(["idea", action, ...id, "--session", "s1"], {}, cwd);
      assert.equal(parsed.command, "idea");
      assert.equal(parsed.engineSettings?.action, action);
      assert.equal(parsed.engineSettings?.sessionId, "s1");
    }
  });

  test("shares --data-dir, --host and --port with serve and run", () => {
    const parsed = parseInvocation(["idea", "watch", "r1", "--session", "s1", "--data-dir", "state", "--port", "4999"], {}, cwd);
    assert.equal(parsed.settings.dataDir, "/opt/sciencediscovery/state");
    assert.equal(parsed.settings.port, 4999);
  });

  test("refuses what the routes cannot serve", () => {
    const refuses = (argv: string[], pattern: RegExp) => assert.throws(() => parseInvocation(argv, {}, cwd), pattern);
    refuses(["evolve"], /evolve requires an action: list, get, watch, stop/);
    refuses(["evolve", "pause", "run-1"], /Unknown evolve action: pause/);
    refuses(["idea", "delete", "r1", "--session", "s1"], /Unknown idea action: delete/);
    refuses(["evolve", "get"], /evolve get requires a run id/);
    refuses(["evolve", "list", "run-1"], /evolve list takes no run id/);
    refuses(["evolve", "watch", "a", "b"], /Unknown option: b/);
    refuses(["idea", "list"], /idea list requires --session <id>/);
    refuses(["idea", "stop", "r1"], /idea stop requires --session <id>/);
    refuses(["evolve", "stop", "run-1", "--session", "s1"], /--session applies to evolve list only/);
    refuses(["evolve", "watch", "run-1", "--candidate", "x"], /--candidate applies to evolve get only/);
    refuses(["idea", "watch", "r1", "--session", "s1", "--after", "3"], /--after applies to evolve watch only/);
    refuses(["evolve", "watch", "run-1", "--after", "-1"], /non-negative integer/);
    refuses(["evolve", "watch", "run-1", "--after", "1.5"], /non-negative integer/);
    refuses(["serve", "--candidate", "x"], /requires the evolve or idea command/);
    refuses(["serve", "--session", "s1"], /requires the run, evolve or idea command/);
    refuses(["evolve", "list", "--content", "x"], /requires the run command/);
  });

  test("help reaches the usage text from any engine position", () => {
    assert.equal(parseInvocation(["evolve", "--help"], {}, cwd).command, "help");
    assert.equal(parseInvocation(["idea", "watch", "--help"], {}, cwd).command, "help");
  });

  test("USAGE lists every engine command and option", () => {
    for (const text of [
      "evolve <action> [run-id]", "idea <action> [research-id] --session <id>",
      "evolve list [--session <id>]", "evolve get <run-id>", "--candidate <hash>", "evolve watch <run-id>",
      "--after <sequence>", "evolve stop <run-id>", "idea list --session <id>", "idea get <research-id>",
      "idea watch <research-id>", "idea pause <research-id>", "idea continue <research-id>", "idea stop <research-id>",
    ]) {
      assert.ok(USAGE.includes(text), `USAGE is missing ${text}`);
    }
    assert.match(USAGE, /130 when it was stopped, ended or paused/);
  });
});

// ---------------------------------------------------------------------------
// a control plane that speaks the real routes

interface EvolveRun { id: string; status: string; sessionId: string; candidates: number; error?: string; [key: string]: unknown }
interface EventRecord { createdAt: string; event: { type: string; [key: string]: unknown }; sequence: number }
interface ResearchView { research: { id: string; status: string; updatedAt: string; [key: string]: unknown }; graph: { nodes: unknown[] } }

interface FakePlane {
  origin: string;
  port: number;
  requests: Array<{ method: string; url: string; body?: unknown }>;
  runs: EvolveRun[];
  events: Map<string, EventRecord[]>;
  candidates: Map<string, string>;
  research: Map<string, ResearchView>;
  /** Per-connection SSE behavior; called with the connection number (0-based). */
  evolveStream?: (connection: number, after: number, response: ServerResponse, runId: string) => void;
  ideaStream?: (connection: number, response: ServerResponse) => void;
  close: () => Promise<void>;
}

const sse = (response: ServerResponse, payload: unknown, id?: number): void => {
  if (id !== undefined) response.write(`id: ${id}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
};

async function readBody(request: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

async function startPlane(t: { after: (fn: () => unknown) => void }): Promise<FakePlane> {
  let evolveConnections = 0;
  let ideaConnections = 0;
  const plane = {
    requests: [], runs: [], events: new Map(), candidates: new Map(), research: new Map(),
  } as unknown as FakePlane;
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = request.method === "POST" ? await readBody(request) : undefined;
      plane.requests.push({ method: request.method ?? "", url: url.pathname + url.search, ...(body ? { body } : {}) });
      if (url.pathname === "/api/health") return json(response, 200, { ok: true });
      if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(response, 401, { error: "Unauthorized" });

      if (url.pathname === "/api/evolve/runs" && request.method === "GET") {
        const session = url.searchParams.get("sessionId");
        return json(response, 200, plane.runs.filter((run) => !session || run.sessionId === session));
      }
      const evolve = url.pathname.match(/^\/api\/evolve\/runs\/([^/]+)\/(events|stop|candidates\/([^/]+))$/);
      if (evolve) {
        const runId = decodeURIComponent(evolve[1]!);
        const run = plane.runs.find((candidate) => candidate.id === runId);
        if (!run) return json(response, 404, { error: "Evolve run not found" });
        if (evolve[2] === "stop") {
          if (!["pending", "running"].includes(run.status)) return json(response, 200, run);
          run.status = "stopped";
          const log = plane.events.get(runId) ?? [];
          log.push({ createdAt: "t", event: { type: "search_finished", status: "stopped", candidates: run.candidates, bestNodeIndex: null }, sequence: log.length + 1 });
          return json(response, 202, { runId, stopping: true });
        }
        if (evolve[3]) {
          const source = plane.candidates.get(decodeURIComponent(evolve[3]));
          return source === undefined ? json(response, 404, { error: "Candidate source not found" }) : json(response, 200, { hash: decodeURIComponent(evolve[3]), source });
        }
        const after = Number(url.searchParams.get("after") ?? "0");
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        if (plane.evolveStream) return plane.evolveStream(evolveConnections++, after, response, runId);
        for (const record of (plane.events.get(runId) ?? []).filter((r) => r.sequence > after)) sse(response, record, record.sequence);
        return response.end();
      }

      const research = url.pathname.match(/^\/api\/sessions\/([^/]+)\/idea-tree\/research(?:\/([^/]+)\/events)?$/);
      if (research) {
        if (decodeURIComponent(research[1]!) !== "session-1") return json(response, 404, { error: "Session not found" });
        if (research[2]) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.flushHeaders();
          if (plane.ideaStream) return plane.ideaStream(ideaConnections++, response);
          sse(response, plane.research.get(decodeURIComponent(research[2]))!);
          return response.end();
        }
        if (request.method === "GET") return json(response, 200, { items: [...plane.research.values()] });
        const { operation, researchId } = body as { operation: string; researchId: string };
        const view = plane.research.get(researchId);
        if (!view) return json(response, 400, { error: "Research not found" });
        const next = { get: view.research.status, pause: "paused", continue: "running", end: "ended" }[operation];
        if (!next) return json(response, 400, { error: "Unknown research operation" });
        if (operation !== "get") view.research = { ...view.research, status: next, updatedAt: `${view.research.updatedAt}+` };
        return json(response, 200, view);
      }
      return json(response, 404, { error: "Not found" });
    })();
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  plane.port = typeof address === "object" && address ? address.port : 0;
  plane.origin = `http://127.0.0.1:${plane.port}`;
  plane.close = () => new Promise<void>((closed) => {
    server.closeAllConnections();
    server.close(() => closed());
  });
  t.after(() => plane.close());
  return plane;
}

/** A data directory holding the token `serve` stores, so no --token is needed. */
const DATA_DIR = mkdtempSync(join(tmpdir(), "engine-cli-"));
mkdirSync(join(DATA_DIR, "secrets"), { recursive: true });
writeFileSync(join(DATA_DIR, "secrets", "auth-token"), `${TOKEN}\n`);
after(() => rmSync(DATA_DIR, { force: true, recursive: true }));

const settingsFor = (plane: FakePlane, dataDir: string): ServeSettings => ({
  bwrapPath: "bwrap",
  dataDir,
  host: "127.0.0.1",
  jiuwenswarm: false,
  port: plane.port,
  runnerHost: "127.0.0.1",
  runnerPort: 4311,
  scientificEnvironments: false,
  skipSandboxCheck: false,
});

interface Captured { exitCode: number; stdout: string; stderr: string; lines: Array<Record<string, unknown>> }

/**
 * Run one command and capture what it prints. stdout is handed in rather than
 * patched globally: the test runner reports through the real process.stdout,
 * and patching it would swallow the report of every test that ends meanwhile.
 */
async function invoke(
  plane: FakePlane,
  engineSettings: EngineSettings,
  dataDir = DATA_DIR,
): Promise<Captured> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const { exitCode } = await engineCommand(
    { settings: settingsFor(plane, dataDir), engineSettings, baseEnv: {} },
    (message) => { stderr.push(`${message}\n`); },
    { reconnectDelay: () => 5, maxReconnects: 3, stdout: { isTTY: false, write: (chunk) => stdout.push(chunk) } },
  );
  const out = stdout.join("");
  // In JSONL mode every stdout line must be JSON, so `| jq` never chokes.
  const lines = engineSettings.output === "text"
    ? []
    : out.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { exitCode, stdout: out, stderr: stderr.join(""), lines };
}

const run = (id: string, status: string, extra: Partial<EvolveRun> = {}): EvolveRun => ({
  id, status, sessionId: "session-1", candidates: 2, tokens: 900, createdAt: "2026-10-25T08:00:00.000Z",
  algorithm: "puct", goal: { statement: "Push the F1 score up", budget: { expansions: 4 } }, ...extra,
});

const records = (...events: Array<EventRecord["event"]>): EventRecord[] =>
  events.map((event, index) => ({ createdAt: "2026-10-25T08:00:00.000Z", event, sequence: index + 1 }));

const SEARCH = records(
  { type: "search_started", algorithm: "puct", scorecardHash: "sha256:card" },
  { type: "seeded", nodeIndex: 0, baselineScore: 0.5 },
  { type: "expanded", nodeIndex: 1, parentIndex: 0, depth: 1, score: 0.62, valid: true, changeSummary: "tune depth", codeHash: "sha256:aa" },
  { type: "merged", nodeIndex: 1, accepted: true, reason: "the hold-out gate score improved" },
  { type: "search_finished", status: "succeeded", candidates: 1, bestNodeIndex: 1 },
);

// ---------------------------------------------------------------------------
// evolve

describe("evolve commands", () => {
  test("list prints one JSON record per run when piped, filtered as the route filters", async (t) => {
    const plane = await startPlane(t);
    plane.runs.push(run("run-a", "running"), run("run-b", "succeeded", { sessionId: "session-2" }));
    const all = await invoke(plane, { engine: "evolve", action: "list", output: "jsonl" });
    assert.equal(all.exitCode, 0);
    assert.deepEqual(all.lines.map((line) => line.id), ["run-a", "run-b"]);
    const narrowed = await invoke(plane, { engine: "evolve", action: "list", sessionId: "session-2", output: "jsonl" });
    assert.deepEqual(narrowed.lines.map((line) => line.id), ["run-b"]);
    assert.ok(plane.requests.some((request) => request.url === "/api/evolve/runs?sessionId=session-2"));
  });

  test("list and get print readable text on a terminal", async (t) => {
    const plane = await startPlane(t);
    plane.runs.push(run("run-a", "running"));
    const list = await invoke(plane, { engine: "evolve", action: "list", output: "text" });
    assert.match(list.stdout, /^ID\s+STATUS\s+CANDIDATES\s+TOKENS\s+CREATED\s+GOAL\nrun-a\s+running\s+2\/4\s+900\s+2026-10-25T08:00:00.000Z\s+Push the F1 score up\n$/);
    const get = await invoke(plane, { engine: "evolve", action: "get", id: "run-a", output: "text" });
    assert.match(get.stdout, /^Run\s+run-a$/m);
    assert.match(get.stdout, /^Candidates\s+2\/4$/m);
  });

  test("get finds the run by id, reports a missing one, and prints a candidate's source", async (t) => {
    const plane = await startPlane(t);
    plane.runs.push(run("run-a", "succeeded", { bestNodeIndex: 1 }));
    plane.candidates.set("sha256:aa", "def solve():\n    return 42");
    const found = await invoke(plane, { engine: "evolve", action: "get", id: "run-a", output: "jsonl" });
    assert.deepEqual(found.lines, [run("run-a", "succeeded", { bestNodeIndex: 1 })]);

    const missing = await invoke(plane, { engine: "evolve", action: "get", id: "nope", output: "jsonl" });
    assert.equal(missing.exitCode, 1);
    assert.deepEqual(missing.lines, [{ type: "error", message: "Evolve run not found: nope", code: "NOT_FOUND", runId: "nope" }]);

    const source = await invoke(plane, { engine: "evolve", action: "get", id: "run-a", candidate: "sha256:aa", output: "text" });
    assert.equal(source.stdout, "def solve():\n    return 42\n");
    const unknown = await invoke(plane, { engine: "evolve", action: "get", id: "run-a", candidate: "sha256:ff", output: "text" });
    assert.equal(unknown.exitCode, 1);
    assert.match(unknown.stderr, /\[evolve\] Candidate source not found/);
  });

  test("stop posts to the route the dashboard's Stop button posts to", async (t) => {
    const plane = await startPlane(t);
    plane.runs.push(run("run-a", "running"));
    const stopped = await invoke(plane, { engine: "evolve", action: "stop", id: "run-a", output: "jsonl" });
    assert.equal(stopped.exitCode, 0);
    assert.deepEqual(stopped.lines, [{ runId: "run-a", stopping: true }]);
    assert.deepEqual(plane.requests.filter((request) => request.method === "POST").map((request) => request.url), ["/api/evolve/runs/run-a/stop"]);
    const again = await invoke(plane, { engine: "evolve", action: "stop", id: "run-a", output: "text" });
    assert.equal(again.exitCode, 0);
    assert.match(again.stdout, /had already ended: stopped/);
  });

  test("watch resumes after the last sequence when the connection drops, without repeating events", async (t) => {
    const plane = await startPlane(t);
    plane.runs.push(run("run-a", "running"));
    plane.evolveStream = (connection, after, response) => {
      const pending = SEARCH.filter((record) => record.sequence > after);
      if (connection === 0) {
        // Two events, then the socket dies mid-stream.
        for (const record of pending.slice(0, 2)) sse(response, record, record.sequence);
        setTimeout(() => response.socket?.destroy(), 20);
        return;
      }
      // The run record is final before the terminal event is published.
      plane.runs[0]!.status = "succeeded";
      for (const record of pending) sse(response, record, record.sequence);
      response.end();
    };
    const result = await invoke(plane, { engine: "evolve", action: "watch", id: "run-a", output: "jsonl" });
    assert.equal(result.exitCode, 0);
    const streamed = plane.requests.filter((request) => request.url.includes("/events")).map((request) => request.url);
    assert.deepEqual(streamed, ["/api/evolve/runs/run-a/events?after=0", "/api/evolve/runs/run-a/events?after=2"]);
    assert.deepEqual(result.lines.filter((line) => "sequence" in line).map((line) => line.sequence), [1, 2, 3, 4, 5]);
    const reconnect = result.lines.find((line) => line.type === "reconnect");
    assert.equal(reconnect?.after, 2);
    assert.deepEqual(result.lines.at(-1), {
      type: "result", runId: "run-a", sessionId: "session-1", status: "succeeded", candidates: 2,
      bestNodeIndex: null, error: null, lastSequence: 5,
    });
  });

  test("watch --after continues an earlier watch, and text mode renders what a person follows", async (t) => {
    const plane = await startPlane(t);
    plane.runs.push(run("run-a", "succeeded"));
    plane.events.set("run-a", SEARCH);
    const result = await invoke(plane, { engine: "evolve", action: "watch", id: "run-a", after: 2, output: "text" });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, [
      "#3 candidate 1 from node 0: score 0.62 — tune depth [sha256:aa]",
      "#4 candidate 1 accepted: the hold-out gate score improved",
      "#5 search finished: succeeded, 1 candidates, best node 1",
      "",
    ].join("\n"));
    assert.match(result.stderr, /\[evolve\] watching run-a: succeeded, 2\/4 candidates, after sequence 2/);
    assert.match(result.stderr, /\[evolve\] run-a succeeded\n/);
  });

  for (const [status, exitCode] of [["failed", 1], ["budget_exhausted", 1], ["stopped", 130]] as const) {
    test(`watch exits ${exitCode} when the search ends ${status}`, async (t) => {
      const plane = await startPlane(t);
      plane.runs.push(run("run-a", status, status === "stopped" ? {} : { error: `${status} reason` }));
      plane.events.set("run-a", records({ type: "search_finished", status, candidates: 2, bestNodeIndex: null }));
      const result = await invoke(plane, { engine: "evolve", action: "watch", id: "run-a", output: "jsonl" });
      assert.equal(result.exitCode, exitCode);
      assert.equal(result.lines.at(-1)?.status, status);
    });
  }

  test("a search stopped while it is watched ends the watch with the stop status", async (t) => {
    const plane = await startPlane(t);
    plane.runs.push(run("run-a", "running"));
    plane.evolveStream = (connection, after, response, runId) => {
      for (const record of (plane.events.get(runId) ?? []).filter((r) => r.sequence > after)) sse(response, record, record.sequence);
      if (connection === 0) setTimeout(() => response.end(), 30);
      else response.end();
    };
    const watching = invoke(plane, { engine: "evolve", action: "watch", id: "run-a", output: "jsonl" });
    // `stop` lands while the watch is between connections.
    await new Promise((settle) => setTimeout(settle, 10));
    await fetch(`${plane.origin}/api/evolve/runs/run-a/stop`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    const result = await watching;
    assert.equal(result.exitCode, 130);
    assert.equal(result.lines.at(-1)?.status, "stopped");
  });

  test("watch gives up after the reconnection budget and reports it as an error line", async (t) => {
    const plane = await startPlane(t);
    plane.runs.push(run("run-a", "running"));
    plane.evolveStream = (_connection, _after, response) => { response.socket?.destroy(); };
    const result = await invoke(plane, { engine: "evolve", action: "watch", id: "run-a", output: "jsonl" });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.lines.filter((line) => line.type === "reconnect").map((line) => line.attempt), [1, 2, 3]);
    assert.equal(result.lines.at(-1)?.type, "error");
    assert.match(String(result.lines.at(-1)?.message), /Lost the event stream after 3 reconnection attempts/);
  });

  test("Ctrl-C detaches the watch and never stops the search", async (t) => {
    const plane = await startPlane(t);
    plane.runs.push(run("run-a", "running"));
    plane.evolveStream = (_connection, _after, response) => {
      sse(response, SEARCH[0], 1);
      setTimeout(() => process.emit("SIGINT"), 20);
    };
    const result = await invoke(plane, { engine: "evolve", action: "watch", id: "run-a", output: "text" });
    assert.equal(result.exitCode, 130);
    assert.match(result.stderr, /stopped watching run-a after sequence 1; the search keeps running/);
    assert.equal(plane.requests.filter((request) => request.method === "POST").length, 0);
  });

  test("a refused token is a clear failure, and an unreachable serve says how to start one", async (t) => {
    const plane = await startPlane(t);
    const refused = await invoke(plane, { engine: "evolve", action: "list", output: "jsonl", token: "wrong" });
    assert.equal(refused.exitCode, 1);
    assert.equal(refused.lines[0]?.code, "HTTP_401");
    assert.match(String(refused.lines[0]?.message), /access token was refused/);
    await plane.close();
    const unreachable = await invoke(plane, { engine: "evolve", action: "list", output: "jsonl" });
    assert.equal(unreachable.exitCode, 1);
    assert.equal(unreachable.lines[0]?.code, "ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// idea

const view = (id: string, status: string, updatedAt: string, extra: Record<string, unknown> = {}): ResearchView => ({
  research: {
    id, status, updatedAt, objective: "Compare two catalysts", phase: "assess", round: 1, batch: ["N1"], batchCompleted: 0,
    tokens: 120, usageKnown: true, reason: null, settings: { maxRounds: 3 }, activities: [], ...extra,
  },
  graph: { nodes: [{ id: "ROOT", kind: "direction" }, { id: "N1", kind: "candidate", status: "done", score: 8, hypothesis: "Catalyst A" }] },
});

describe("idea commands", () => {
  test("list, get and every control send the card's own requests", async (t) => {
    const plane = await startPlane(t);
    plane.research.set("research-1", view("research-1", "running", "t1"));
    const list = await invoke(plane, { engine: "idea", action: "list", sessionId: "session-1", output: "jsonl" });
    assert.deepEqual(list.lines.map((line) => (line.research as { id: string }).id), ["research-1"]);
    const get = await invoke(plane, { engine: "idea", action: "get", id: "research-1", sessionId: "session-1", output: "text" });
    assert.match(get.stdout, /^Research\s+research-1$/m);
    assert.match(get.stdout, /^ {2}N1 {2}done {2}score 8 {2}Catalyst A$/m);
    for (const action of ["pause", "continue", "stop"] as const) {
      const result = await invoke(plane, { engine: "idea", action, id: "research-1", sessionId: "session-1", output: "jsonl" });
      assert.equal(result.exitCode, 0);
    }
    const ended = await invoke(plane, { engine: "idea", action: "stop", id: "research-1", sessionId: "session-1", output: "text" });
    assert.equal(ended.stdout, "Research research-1 is ended.\n");
    assert.deepEqual(
      plane.requests.filter((request) => request.method === "POST").map((request) => request.body),
      ["get", "pause", "continue", "end", "end"].map((operation) => ({ operation, researchId: "research-1" })),
    );
    assert.equal(plane.research.get("research-1")?.research.status, "ended");
  });

  test("a missing session or research is an error, not an empty answer", async (t) => {
    const plane = await startPlane(t);
    const session = await invoke(plane, { engine: "idea", action: "list", sessionId: "nope", output: "jsonl" });
    assert.equal(session.exitCode, 1);
    assert.deepEqual(session.lines, [{ type: "error", message: "Session not found", code: "HTTP_404", sessionId: "nope" }]);
    const research = await invoke(plane, { engine: "idea", action: "stop", id: "gone", sessionId: "session-1", output: "text" });
    assert.equal(research.exitCode, 1);
    assert.match(research.stderr, /\[idea\] Research not found/);
  });

  test("watch reconnects to the present state and never repeats a view it already showed", async (t) => {
    const plane = await startPlane(t);
    plane.research.set("research-1", view("research-1", "running", "t1"));
    const later = view("research-1", "running", "t2", { phase: "propagate", batchCompleted: 1, activities: [
      { role: "assess", nodeId: "N1", round: 1, status: "completed", startedAt: "s1", finishedAt: "f1", error: null },
    ] });
    const done = view("research-1", "completed", "t3", { phase: "complete", reason: "Exploration round limit reached" });
    plane.ideaStream = (connection, response) => {
      if (connection === 0) {
        sse(response, plane.research.get("research-1"));
        sse(response, later);
        setTimeout(() => response.socket?.destroy(), 20);
        return;
      }
      sse(response, later);
      sse(response, done);
      response.end();
    };
    const result = await invoke(plane, { engine: "idea", action: "watch", id: "research-1", sessionId: "session-1", output: "jsonl" });
    assert.equal(result.exitCode, 0);
    const views = result.lines.filter((line) => "research" in line).map((line) => (line.research as { updatedAt: string }).updatedAt);
    assert.deepEqual(views, ["t1", "t2", "t3"]);
    assert.equal(result.lines.filter((line) => line.type === "reconnect").length, 1);
    assert.deepEqual(result.lines.at(-1), {
      type: "result", researchId: "research-1", sessionId: "session-1", status: "completed",
      reason: "Exploration round limit reached", scored: 1,
    });
  });

  test("watch in text mode prints a line per change and per activity step, not the history", async (t) => {
    const plane = await startPlane(t);
    const history = { role: "ideate", nodeId: null, round: 0, status: "completed", startedAt: "s0", finishedAt: "f0", error: null };
    plane.research.set("research-1", view("research-1", "running", "t1", { activities: [history] }));
    plane.ideaStream = (_connection, response) => {
      sse(response, view("research-1", "running", "t2", { activities: [history,
        { role: "assess", nodeId: "N1", round: 1, status: "running", startedAt: "s1", finishedAt: null, error: null },
      ] }));
      sse(response, view("research-1", "ended", "t3", { reason: "Ended by user", activities: [history,
        { role: "assess", nodeId: "N1", round: 1, status: "stopped", startedAt: "s1", finishedAt: "f1", error: null },
      ] }));
      response.end();
    };
    const result = await invoke(plane, { engine: "idea", action: "watch", id: "research-1", sessionId: "session-1", output: "text" });
    assert.equal(result.exitCode, 130);
    assert.equal(result.stdout, [
      "running · assess · round 1/3 · batch 0/1 · 1 scored · 120 tokens",
      "  assess N1: running",
      "ended · assess · round 1/3 · batch 0/1 · 1 scored · 120 tokens",
      "  assess N1: stopped",
      "",
    ].join("\n"));
    assert.match(result.stderr, /\[idea\] research-1 ended: Ended by user/);
  });

  for (const [status, exitCode] of [["completed", 0], ["ended", 130], ["paused", 130], ["interrupted", 1]] as const) {
    test(`watch on a research already ${status} returns at once with ${exitCode}`, async (t) => {
      const plane = await startPlane(t);
      plane.research.set("research-1", view("research-1", status, "t1"));
      const result = await invoke(plane, { engine: "idea", action: "watch", id: "research-1", sessionId: "session-1", output: "jsonl" });
      assert.equal(result.exitCode, exitCode);
      assert.equal(plane.requests.filter((request) => request.url.endsWith("/events")).length, 0);
      assert.equal(result.lines.at(-1)?.status, status);
    });
  }
});
