// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { runnerAsset } from "./build-runner.mjs";
import { packRunnerBundle } from "../../packages/executor/dist/runner-bundle.js";
import { RunnerClient } from "../../packages/executor/dist/runner-client.js";
import { RUNNER_VERSION } from "../../services/runner/dist/version.js";

test("SEA asset preserves the ESM tree and excludes embedded binaries and tests", async () => {
  const files = JSON.parse(gunzipSync(runnerAsset((await packRunnerBundle()).archive)));
  assert.ok(files.some(file => file.path === "services/runner/dist/server.js"));
  const metadata = files.find(file => file.path === "services/runner/dist/build-info.json");
  assert.ok(metadata, "the SEA must carry the compiled Runner's build identity");
  assert.equal(JSON.parse(Buffer.from(metadata.content, "base64")).version, RUNNER_VERSION);
  assert.ok(files.every(file => !file.path.includes("/sea/") && !file.path.endsWith(".test.js")));
});

test("standalone Runner SEA starts and authenticates with no Node in PATH", {
  skip: process.env.RUNNER_SEA_SMOKE !== "1", timeout: 30_000,
}, async () => {
  const root = resolve(".tmp/runner-sea-smoke");
  await mkdir(root, { recursive: true });
  const data = await mkdtemp(join(root, "run-"));
  const portServer = createServer();
  await new Promise(done => portServer.listen(0, "127.0.0.1", done));
  const port = portServer.address().port;
  await new Promise(done => portServer.close(done));
  const token = randomBytes(24).toString("hex");
  const binary = resolve(`services/runner/dist/sea/linux-${process.arch}/sciencediscovery-runner`);
  const child = spawn(binary, [], { env: {
    PATH: data, SCIENCE_AGENT_DATA_DIR: data, SCIENTIFIC_ENVS: "0",
    SCIENCE_AGENT_RUNNER_PORT: String(port), SCIENCE_AGENT_RUNNER_TOKEN: token,
    SCIENCE_AGENT_BWRAP_PATH: "/usr/bin/bwrap", SCIENCE_AGENT_PYTHON_PATH: "/usr/bin/python3", SCIENCE_AGENT_SHELL_PATH: "/usr/bin/bash",
  }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  try {
    let health;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) assert.fail(output.replaceAll(token, "[redacted]"));
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) { health = await r.json(); break; } } catch {}
      await new Promise(done => setTimeout(done, 100));
    }
    assert.equal(health?.status, "ok", output.replaceAll(token, "[redacted]"));
    assert.equal(health.sandbox, "bubblewrap");
    assert.equal(health.runnerVersion, RUNNER_VERSION);
    assert.equal((await fetch(`http://127.0.0.1:${port}/status`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    const client = new RunnerClient(`http://127.0.0.1:${port}`, token);
    const result = await client.executeShell({
      agentId: "main", code: "printf SEA_SANDBOX_OK", executionId: "sea-smoke",
      workspaceRoot: "/control/workspace/not-on-this-runner", runnerWorkspaceKey: "sea/remote-smoke",
      permissionEpoch: { createdAt: new Date().toISOString(), environmentRevisionId: "system-shell", id: "sea-epoch",
        mounts: [{ mode: "read-write", source: "workspace" }], networkPolicy: "none", reason: "isolated SEA smoke", secretRefs: [], sessionId: "sea-session" },
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /SEA_SANDBOX_OK/);
    assert.equal(result.sandbox, "bubblewrap");
    assert.equal(result.runnerVersion, RUNNER_VERSION);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    await rm(data, { recursive: true, force: true });
  }
});
