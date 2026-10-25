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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { describe, test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


import { parseInvocation, USAGE } from "./cli-options.js";
import { runCommand, thinkingChanges, thinkingRefusal } from "./run.js";
import { ControlPlaneClient, type SessionThinkingControls } from "./control-plane-client.js";
import type { ServeSettings } from "./serve.js";

const cwd = "/opt/sciencediscovery";

const baseSettings = (overrides: Partial<ServeSettings> = {}): ServeSettings => ({
  bwrapPath: "bwrap",
  dataDir: join(cwd, ".sciencediscovery-data"),
  host: "127.0.0.1",
  port: 4310,
  runnerHost: "127.0.0.1",
  runnerPort: 4311,
  scientificEnvironments: false,
  skipSandboxCheck: false,
  jiuwenswarm: false,
  ...overrides,
});

describe("run option parsing", () => {
  test("recognizes run and seeds empty run settings", () => {
    const inv = parseInvocation(["run"], {}, cwd);
    assert.equal(inv.command, "run");
    assert.deepEqual(inv.runSettings, { stdin: false, autoApprove: false });
  });

  test("positional argument becomes the problem text", () => {
    const inv = parseInvocation(["run", "什么是相对论"], {}, cwd);
    assert.equal(inv.runSettings?.positional, "什么是相对论");
  });

  test("only the first positional is captured; the rest would be unknown options", () => {
    const inv = parseInvocation(["run", "first"], {}, cwd);
    assert.equal(inv.runSettings?.positional, "first");
    assert.throws(() => parseInvocation(["run", "first", "second"], {}, cwd), /Unknown option/);
  });

  test("--content and --stdin", () => {
    const a = parseInvocation(["run", "--content", "hello"], {}, cwd);
    assert.equal(a.runSettings?.input, "hello");
    const b = parseInvocation(["run", "--stdin"], {}, cwd);
    assert.equal(b.runSettings?.stdin, true);
  });

  test("parses session/project/model/skills/connectors/review/token/output", () => {
    const inv = parseInvocation(
      ["run", "--session", "s1", "--project", "p1", "--model", "m1", "--skills", "a,b", "--connectors", "c,d", "--review", "manual", "--token", "tok", "--output", "jsonl", "问题"],
      {},
      cwd,
    );
    const r = inv.runSettings!;
    assert.equal(r.sessionId, "s1");
    assert.equal(r.projectId, "p1");
    assert.equal(r.modelId, "m1");
    assert.equal(r.skills, "a,b");
    assert.equal(r.connectors, "c,d");
    assert.equal(r.review, "manual");
    assert.equal(r.token, "tok");
    assert.equal(r.output, "jsonl");
    assert.equal(r.positional, "问题");
  });

  test("--auto-approve flag and --approval always_allow", () => {
    assert.equal(parseInvocation(["run", "--auto-approve", "q"], {}, cwd).runSettings?.autoApprove, true);
    assert.equal(parseInvocation(["run", "--approval", "always_allow", "q"], {}, cwd).runSettings?.approval, "always_allow");
  });

  test("--timeout parses a positive number and rejects bad values", () => {
    assert.equal(parseInvocation(["run", "--timeout", "5000", "q"], {}, cwd).runSettings?.timeout, 5000);
    assert.throws(() => parseInvocation(["run", "--timeout", "abc", "q"], {}, cwd), /must be a positive number/);
    assert.throws(() => parseInvocation(["run", "--timeout", "-1", "q"], {}, cwd), /must be a positive number/);
    assert.throws(() => parseInvocation(["run", "--timeout"], {}, cwd), /requires a value/);
  });

  test("rejects bad --approval / --output / --review values", () => {
    assert.throws(() => parseInvocation(["run", "--approval", "yes", "q"], {}, cwd), /must be ask_for_dangerous or always_allow/);
    assert.throws(() => parseInvocation(["run", "--output", "csv", "q"], {}, cwd), /must be jsonl, json or text/);
    assert.throws(() => parseInvocation(["run", "--review", "fast", "q"], {}, cwd), /must be auto or manual/);
  });

  test("input must be exactly one of positional / --content / --stdin", () => {
    assert.throws(() => parseInvocation(["run", "--content", "x", "--stdin"], {}, cwd), /exactly one of/);
    assert.throws(() => parseInvocation(["run", "positional", "--content", "x"], {}, cwd), /exactly one of/);
  });

  test("run still accepts --data-dir / --host / --port (reused from serve)", () => {
    const inv = parseInvocation(["run", "--data-dir", "state", "--host", "127.0.0.1", "--port", "9999", "q"], {}, cwd);
    assert.equal(inv.settings.dataDir, "/opt/sciencediscovery/state");
    assert.equal(inv.settings.host, "127.0.0.1");
    assert.equal(inv.settings.port, 9999);
  });

  test("USAGE advertises the run command and run options", () => {
    assert.match(USAGE, /run \[input\] \[options\]/);
    assert.match(USAGE, /--content <text>/);
    assert.match(USAGE, /--auto-approve/);
    assert.match(USAGE, /--thinking <off\|auto\|on>/);
    assert.match(USAGE, /--effort <level>/);
  });

  test("--effort and --thinking take only the levels and switches the product knows", () => {
    const inv = parseInvocation(["run", "--effort", "xhigh", "--thinking", "on", "q"], {}, cwd);
    assert.equal(inv.runSettings?.effort, "xhigh");
    assert.equal(inv.runSettings?.thinking, "on");
    assert.equal(parseInvocation(["run", "--thinking", "off", "q"], {}, cwd).runSettings?.thinking, "off");
    assert.throws(() => parseInvocation(["run", "--effort", "extreme", "q"], {}, cwd), /--effort must be one of low, medium, high, xhigh, max/);
    assert.throws(() => parseInvocation(["run", "--thinking", "enabled", "q"], {}, cwd), /--thinking must be off, auto or on/);
    assert.throws(() => parseInvocation(["run", "--effort"], {}, cwd), /requires a value/);
    assert.throws(() => parseInvocation(["serve", "--effort", "high"], {}, cwd), /requires the run command/);
  });

  test("an effort with thinking off or auto is a contradiction, not a guess", () => {
    assert.throws(() => parseInvocation(["run", "--effort", "high", "--thinking", "off", "q"], {}, cwd), /needs thinking on/);
    assert.throws(() => parseInvocation(["run", "--thinking", "auto", "--effort", "high", "q"], {}, cwd), /needs thinking on/);
  });
});

describe("thinking against the session's model", () => {
  const deepseek: SessionThinkingControls = {
    efforts: ["high", "max"], modelId: "m1", modelName: "DeepSeek", modes: ["auto", "enabled", "disabled"], supported: true,
  };

  test("accepts exactly the composer's choices for the model", () => {
    assert.equal(thinkingRefusal(deepseek, { effort: "max" }), undefined);
    assert.equal(thinkingRefusal(deepseek, { thinking: "off" }), undefined);
    assert.equal(thinkingRefusal(deepseek, { thinking: "auto" }), undefined);
    assert.equal(thinkingRefusal(deepseek, { effort: "high", thinking: "on" }), undefined);
  });

  test("names the levels the model does accept when it refuses one", () => {
    assert.equal(thinkingRefusal(deepseek, { effort: "low" }), 'Model "DeepSeek" does not accept --effort low; it accepts high, max');
  });

  test("refuses a switch the model lacks, and an effort on a model without levels", () => {
    const kimi = { ...deepseek, efforts: ["low", "high", "max"], modelName: "Kimi K3", modes: ["auto", "enabled"] };
    assert.equal(thinkingRefusal(kimi, { thinking: "off" }), 'Model "Kimi K3" does not accept --thinking off; it accepts auto, on');
    const qwen = { ...deepseek, efforts: [], modelName: "Qwen" };
    assert.equal(thinkingRefusal(qwen, { thinking: "on" }), undefined);
    assert.equal(thinkingRefusal(qwen, { effort: "high" }), 'Model "Qwen" has no effort levels; use --thinking on instead of --effort');
  });

  test("refuses a model with no thinking control, and a session with no model", () => {
    const plain = { efforts: [], modelId: "m2", modelName: "GPT", modes: [], supported: false };
    assert.equal(thinkingRefusal(plain, { thinking: "auto" }), 'Model "GPT" has no thinking control, so --thinking and --effort cannot be applied');
    assert.match(thinkingRefusal({ efforts: [], modes: [], supported: false }, { effort: "high" }) ?? "", /need a model/);
  });

  test("an effort turns thinking on; a switch alone leaves the effort as it was", () => {
    assert.deepEqual(thinkingChanges({ effort: "max" }), { thinkingEffort: "max", thinkingMode: "enabled" });
    assert.deepEqual(thinkingChanges({ thinking: "off" }), { thinkingMode: "disabled" });
    assert.deepEqual(thinkingChanges({ thinking: "on" }), { thinkingMode: "enabled" });
  });
});

describe("run with --effort / --thinking", () => {
  const controls: SessionThinkingControls = {
    efforts: ["high", "max"], modelId: "m1", modelName: "DeepSeek", modes: ["auto", "enabled", "disabled"], supported: true,
  };

  function mockServe(t: import("node:test").TestContext) {
    const stdout: string[] = [];
    const updates: unknown[] = [];
    const runs: unknown[] = [];
    let controlReads = 0;
    t.mock.method(process.stdout, "write", (chunk: unknown) => { stdout.push(String(chunk)); return true; });
    t.mock.method(process.stderr, "write", () => true);
    t.mock.method(ControlPlaneClient.prototype, "health", async () => true);
    t.mock.method(ControlPlaneClient.prototype, "getSessionThinkingControls", async () => { controlReads += 1; return controls; });
    t.mock.method(ControlPlaneClient.prototype, "updateSession", async (_session: string, body: unknown) => { updates.push(body); return {}; });
    t.mock.method(ControlPlaneClient.prototype, "createRun", async (_session: string, body: unknown) => { runs.push(body); return { id: "run", status: "running" }; });
    t.mock.method(ControlPlaneClient.prototype, "getSessionUsage", async () => ({}));
    t.mock.method(ControlPlaneClient.prototype, "subscribeRunEvents", async (
      _session: string, _run: string, _after: number, onEvent: (event: unknown) => void,
    ) => { onEvent({ type: "run.completed", message: { content: "answer" } }); });
    return { controlReads: () => controlReads, runs, stdout, updates };
  }

  const run = (extra: Partial<import("./cli-options.js").RunSettings>) => runCommand({
    settings: baseSettings(), baseEnv: {},
    runSettings: { stdin: false, autoApprove: true, input: "sweep", output: "jsonl", token: "test-token", sessionId: "session", ...extra },
  }, () => {});

  test("an accepted effort is saved on the session before the run starts", async (t) => {
    const serve = mockServe(t);
    assert.equal((await run({ effort: "max" })).exitCode, 0);
    assert.deepEqual(serve.updates, [{ approvalMode: "always_allow" }, { thinkingEffort: "max", thinkingMode: "enabled" }]);
    assert.equal(serve.runs.length, 1);
  });

  test("a refused effort fails the command with an explicit error and starts no run", async (t) => {
    const serve = mockServe(t);
    assert.equal((await run({ effort: "low" })).exitCode, 1);
    const error = serve.stdout.join("").trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "error");
    assert.deepEqual(error, {
      type: "error", code: "THINKING_NOT_ACCEPTED", sessionId: "session",
      message: 'Model "DeepSeek" does not accept --effort low; it accepts high, max',
    });
    assert.deepEqual(serve.updates, [{ approvalMode: "always_allow" }]);
    assert.equal(serve.runs.length, 0);
  });

  test("without either flag the session's thinking is neither read nor written", async (t) => {
    const serve = mockServe(t);
    assert.equal((await run({})).exitCode, 0);
    assert.equal(serve.controlReads(), 0);
    assert.deepEqual(serve.updates, [{ approvalMode: "always_allow" }]);
  });
});

describe("run command against an unreachable serve", () => {
  test("returns exit 1 and emits a valid jsonl error on stdout", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "run-test-"));
    const stdoutChunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalIsTty = process.stdout.isTTY;
    // 伪装成非 TTY,走 jsonl 模式(无 auto-approve 也会因非交互拒启,所以给 auto-approve)
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;

    try {
      const result = await runCommand(
        {
          // port 1 上没有服务,health 必失败
          settings: baseSettings({ dataDir, port: 1 }),
          runSettings: { stdin: false, autoApprove: true, input: "hello", output: "jsonl" },
          baseEnv: {},
        },
        () => {},
      );
      assert.equal(result.exitCode, 1);
    } finally {
      process.stdout.write = originalWrite;
      Object.defineProperty(process.stdout, "isTTY", { value: originalIsTty, configurable: true });
    }

    const lines = stdoutChunks.join("").split("\n").filter(Boolean);
    assert.ok(lines.length >= 1, "expected at least one jsonl line on stdout");
    for (const line of lines) {
      const parsed = JSON.parse(line) as { type?: string };
      assert.equal(typeof parsed.type, "string", `stdout line is not valid jsonl: ${line}`);
    }
    const errorLine = lines.find((l) => (JSON.parse(l) as { type?: string }).type === "error");
    assert.ok(errorLine, "expected an error event line");
    assert.match((JSON.parse(errorLine as string) as { code?: string }).code ?? "", /ECONNREFUSED/);
  });

  test("non-interactive without --auto-approve refuses to start (exit 1)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "run-test-"));
    const stdoutChunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;

    try {
      const result = await runCommand(
        {
          settings: baseSettings({ dataDir, port: 1 }),
          runSettings: { stdin: false, autoApprove: false, input: "hello", output: "jsonl" },
          baseEnv: {},
        },
        () => {},
      );
      assert.equal(result.exitCode, 1);
      const lines = stdoutChunks.join("").split("\n").filter(Boolean);
      const errorLine = lines.find((l) => (JSON.parse(l) as { type?: string }).type === "error");
      assert.ok(errorLine, "expected an error event for the refusal");
      assert.match((JSON.parse(errorLine as string) as { code?: string }).code ?? "", /NON_INTERACTIVE_NO_AUTO_APPROVE/);
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});


describe("tool progress rendering", () => {
  for (const output of ["text", "jsonl"] as const) {
    test(`${output} keeps final output and JSONL preserves progress`, async (t) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      t.mock.method(process.stdout, "write", (chunk: unknown) => { stdout.push(String(chunk)); return true; });
      t.mock.method(process.stderr, "write", (chunk: unknown) => { stderr.push(String(chunk)); return true; });
      t.mock.method(ControlPlaneClient.prototype, "health", async () => true);
      t.mock.method(ControlPlaneClient.prototype, "updateSession", async () => ({}));
      t.mock.method(ControlPlaneClient.prototype, "createRun", async () => ({ id: "run", status: "running" }));
      t.mock.method(ControlPlaneClient.prototype, "getSessionUsage", async () => ({}));
      const events = [
        { type: "tool.output", toolCallId: "shell", chunk: "evidence", progress: true },
        { type: "tool.output", toolCallId: "shell", chunk: '{"stdout":"evidence","exitCode":0}' },
        { type: "tool.output", toolCallId: "silent", chunk: "silent tool result" },
        { type: "run.completed", message: { content: "answer" } },
      ];
      t.mock.method(ControlPlaneClient.prototype, "subscribeRunEvents", async (
        _session: string, _run: string, _after: number, onEvent: (event: unknown) => void,
      ) => { events.forEach(onEvent); });
      const result = await runCommand({
        settings: baseSettings(), baseEnv: {},
        runSettings: { stdin: false, autoApprove: true, input: "inspect evidence", output, token: "test-token", sessionId: "session" },
      }, () => {});
      assert.equal(result.exitCode, 0);
      if (output === "text") {
        assert.equal(stderr.join(""), '{"stdout":"evidence","exitCode":0}silent tool result');
      } else {
        const toolEvents = stdout.join("").trim().split("\n").map(line => JSON.parse(line))
          .filter(event => event.type === "tool.output");
        assert.deepEqual(toolEvents, events.slice(0, 3));
        assert.equal(stderr.join(""), "");
      }
    });
  }
});
