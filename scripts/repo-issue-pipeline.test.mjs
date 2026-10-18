// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy at https://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTest } from "../test/support/tagged/compat.mjs";
import { runRequest } from "../.agents/skills/repo-issue-pipeline/scripts/sdk-runner.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
const host = new URL("../.agents/skills/repo-issue-pipeline/scripts/sdk-runner.mjs", import.meta.url);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "repo-pipeline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = {
    role: "worker", fullAccess: true, workingDirectory: root,
    promptFile: join(root, "prompt.md"), sessionFile: join(root, "session.json"),
    logDirectory: join(root, "logs"),
  };
  const path = join(root, "request.json");
  await writeFile(request.promptFile, "Complete the assigned issue.");
  await writeFile(path, JSON.stringify(request));
  return { root, request, path };
}

function sdk(events, calls = []) {
  return async (options) => {
    calls.push(["constructor", options]);
    const thread = {
      async runStreamed(prompt, settings) {
        calls.push(["run", prompt, settings]);
        return { events: (async function* () { yield* events; })() };
      },
    };
    return {
      startThread(options) { calls.push(["start", options]); return thread; },
      resumeThread(id, options) { calls.push(["resume", id, options]); return thread; },
    };
  };
}

const success = [
  { type: "thread.started", thread_id: "saved-thread" },
  { type: "item.completed", item: { type: "command_execution", command: "test" } },
  { type: "item.completed", item: { type: "agent_message", text: "Ready for review" } },
  { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } },
];

test("SDK host persists start, final response, usage and private event evidence", async (t) => {
  const { path, request } = await fixture(t);
  const calls = [];
  const notices = [];
  const status = await runRequest(path, { createCodex: sdk(success, calls), notify: (event) => notices.push(event) });
  assert.equal(status.state, "completed");
  assert.equal(status.threadId, "saved-thread");
  assert.equal(status.usage.input_tokens, 10);
  assert.equal(calls[1][0], "start");
  assert.equal(calls[1][1].sandboxMode, "danger-full-access");
  assert.equal(calls[1][1].approvalPolicy, "never");
  assert.equal(calls[1][1].networkAccessEnabled, true);
  assert.equal(calls[0][1].config.features.multi_agent, false);
  assert.equal(await readFile(join(status.runDirectory, "final.md"), "utf8"), "Ready for review\n");
  assert.equal((await readFile(join(status.runDirectory, "events.jsonl"), "utf8")).trim().split("\n").length, 4);
  assert.deepEqual(JSON.parse(await readFile(request.sessionFile, "utf8")), status);
  assert.equal((await stat(request.sessionFile)).mode & 0o777, 0o600);
  assert.equal((await stat(status.runDirectory)).mode & 0o777, 0o700);
  assert.equal(notices.length, 1);
});

test("continuations resume the original thread with only the new prompt", async (t) => {
  const { path, request } = await fixture(t);
  await writeFile(request.sessionFile, JSON.stringify({ threadId: "original", workingDirectory: request.workingDirectory }));
  await writeFile(request.promptFile, "Repair the newly reported CI failure.");
  const calls = [];
  await runRequest(path, { createCodex: sdk(success, calls) });
  assert.equal(calls[1][0], "resume");
  assert.equal(calls[1][1], "original");
  assert.equal(calls[2][1], "Repair the newly reported CI failure.");
});

for (const events of [[], [{ type: "turn.failed", error: { message: "failure" } }], [{ type: "error", message: "failure" }, ...success]]) {
  test(`incomplete or failed SDK streams cannot report success: ${events[0]?.type ?? "empty"}`, async (t) => {
    const { path } = await fixture(t);
    const status = await runRequest(path, { createCodex: sdk(events) });
    assert.equal(status.state, "failed");
    assert.match(await readFile(join(status.runDirectory, "error.txt"), "utf8"), /failed|completion/);
  });
}

test("SDK exceptions persist failure, release the lock, and permit same-thread recovery", async (t) => {
  const { path, request } = await fixture(t);
  const mask = process.umask();
  const status = await runRequest(path, { createCodex: async () => { throw new Error("private SDK detail"); } });
  assert.equal(status.state, "failed");
  assert.match(await readFile(join(status.runDirectory, "error.txt"), "utf8"), /private SDK detail/);
  await assert.rejects(stat(`${request.sessionFile}.lock`), { code: "ENOENT" });
  assert.equal(process.umask(), mask);
  const recovered = await runRequest(path, { createCodex: sdk(success) });
  assert.equal(recovered.state, "completed");
});

test("aborted streams record interrupted rather than completed", async (t) => {
  const { path } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await runRequest(path, { createCodex: sdk(success), signal: controller.signal })).state, "interrupted");
});

for (const key of ["workingDirectory", "promptFile", "sessionFile", "logDirectory"]) {
  test(`relative ${key} is rejected before execution`, async (t) => {
    const { path, request } = await fixture(t);
    request[key] = "relative";
    await writeFile(path, JSON.stringify(request));
    await assert.rejects(runRequest(path), new RegExp(key));
  });
}

test("full access and role require explicit valid configuration", async (t) => {
  const { path, request } = await fixture(t);
  await writeFile(path, JSON.stringify({ ...request, fullAccess: false }));
  await assert.rejects(runRequest(path), /fullAccess/);
  await writeFile(path, JSON.stringify({ ...request, role: "unknown" }));
  await assert.rejects(runRequest(path), /Role/);
});

test("corrupt and cross-worktree sessions are rejected without replacing history", async (t) => {
  const { path, request } = await fixture(t);
  await writeFile(request.sessionFile, "not json");
  await assert.rejects(runRequest(path), SyntaxError);
  const saved = JSON.stringify({ threadId: "original", workingDirectory: "/different" });
  await writeFile(request.sessionFile, saved);
  await assert.rejects(runRequest(path), /different working directory/);
  assert.equal(await readFile(request.sessionFile, "utf8"), saved);
});

test("a concurrent host cannot acquire the same session", async (t) => {
  const { path, request } = await fixture(t);
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const first = runRequest(path, { createCodex: async () => {
    entered();
    await gate;
    return (await sdk(success)()) ;
  } });
  await ready;
  try { await assert.rejects(runRequest(path), { code: "EEXIST" }); }
  finally { release(); }
  assert.equal((await first).state, "completed");
  await assert.rejects(stat(`${request.sessionFile}.lock`), { code: "ENOENT" });
});

test("an optional executable override is forwarded without changing model configuration", async (t) => {
  const { path } = await fixture(t);
  const prior = process.env.CODEX_EXECUTABLE;
  process.env.CODEX_EXECUTABLE = "/operator/codex";
  t.after(() => { if (prior === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = prior; });
  const calls = [];
  await runRequest(path, { createCodex: sdk(success, calls) });
  assert.equal(calls[0][1].codexPathOverride, "/operator/codex");
  assert.equal(calls[1][1].model, undefined);
});

test("CLI errors are nonzero and do not print private request contents", () => {
  for (const args of [[], ["/nonexistent-private-request"]]) {
    const result = spawnSync(process.execPath, [host.pathname, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /SDK host failed/);
    assert.doesNotMatch(result.stderr, /ENOENT|nonexistent-private-request/);
  }
});
