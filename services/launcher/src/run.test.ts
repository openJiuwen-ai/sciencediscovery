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

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { parseInvocation, USAGE } from "./cli-options.js";
import { runCommand } from "./run.js";
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
