// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * E2E-META: A Runner operator recovers a failed four-unit CPU workload through
 * production HTTP endpoints. No API Agent, LLM, browser, NPU, managed environment
 * provisioning, real service, package installation, or external network is used.
 * Requires Linux, working bubblewrap, Python 3, pnpm, and an already committed,
 * built checkout. Starts the documented production entry `pnpm runner` on its
 * own loopback port/data directory; only journey-owned processes are restarted.
 *
 * From the repository root, after `pnpm build` and committing the candidate:
 *   node test/recovery-runner-journey.mjs
 * Optional E2E_REPORT_DIR selects an otherwise-new directory for numbered
 * report.md, redacted runner.log, and state.json. Default: a temporary directory.
 *
 * An already running isolated Runner is also supported, without owning its PID:
 *   E2E_BASE_URL=http://127.0.0.1:PORT E2E_API_TOKEN=TOKEN E2E_PHASE=prepare \
 *     E2E_REPORT_DIR=/tmp/recovery-run node test/recovery-runner-journey.mjs
 * Restart that Runner yourself, keeping its data; then repeat with E2E_PHASE=resume.
 * The prepare report says PREPARED, not PASS. Resume requires a changed Runner
 * boot identity and retained evidence. Never put tokens in reports or state.
 * This driver is separate from, and not implicitly included in, pnpm ci:e2e.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

class Blocked extends Error {}
const external = Boolean(process.env.E2E_BASE_URL);
const phase = process.env.E2E_PHASE ?? "all";
const root = process.env.E2E_REPORT_DIR ? resolve(process.env.E2E_REPORT_DIR) : await mkdtemp(resolve(tmpdir(), "sd-recovery-journey-"));
await mkdir(root, { recursive: true });
const dataDir = resolve(root, "data");
const token = external ? process.env.E2E_API_TOKEN ?? "" : randomUUID();
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const redact = value => String(value).replaceAll(token || "<empty-token>", "[redacted]").replaceAll(process.cwd(), "<worktree>");
const delay = ms => new Promise(done => setTimeout(done, ms));
let steps = [];
let state;
let child;
let client;
let RunnerClient;
let origin = process.env.E2E_BASE_URL;
let log = "";
let outcome = "FAIL";
let ownsData = false;
let validatedState = false;
// The client has methods without a signal parameter; bound every real HTTP call.
const fetchWithDefaultTimeout = globalThis.fetch;
globalThis.fetch = (input, init = {}) => fetchWithDefaultTimeout(input, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000) });

async function step(name, expected, action) {
  try {
    const actual = await action();
    steps.push({ name, expected, actual: actual ?? "As expected", result: "PASS" });
  } catch (error) {
    steps.push({ name, expected, actual: redact(error.stack ?? error), result: error instanceof Blocked ? "BLOCKED" : "FAIL" });
    throw error;
  }
}

async function until(check, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await delay(30);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for the documented Runner outcome");
}

async function start() {
  if (!external) {
    if (!ownsData) {
      try { await mkdir(dataDir); }
      catch (error) { throw new Blocked(`Refusing to reuse an existing or inaccessible data directory: ${error.code}`); }
      ownsData = true;
    }
    origin = undefined;
    let spawnError;
    child = spawn("pnpm", ["runner"], {
      detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root,
        // The candidate is already installed and built. A journey must not mutate
        // node_modules when its isolated HOME selects a different package store.
        pnpm_config_verify_deps_before_run: "false",
        SCIENCE_AGENT_DATA_DIR: dataDir, SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1", SCIENCE_AGENT_RUNNER_PORT: "0",
        SCIENCE_AGENT_RUNNER_TOKEN: token, SCIENTIFIC_ENVS: "0", SCIENCE_AGENT_NPU_BROKER: "0",
        SCIENCE_AGENT_MAX_OUTPUT_BYTES: "1000000", SCIENCE_AGENT_MAX_WORKSPACE_BYTES: "10000000" },
    });
    child.once("error", error => { spawnError = error; });
    let launchOutput = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
      const text = chunk.toString(); log += redact(text); launchOutput += text;
      origin ??= launchOutput.match(/runner listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    });
    await until(() => {
      if (spawnError) throw new Blocked(`Unable to start pnpm runner: ${spawnError.message}`);
      if (child.exitCode !== null) throw new Blocked(`Production Runner exited before readiness: ${log.slice(-4000)}`);
      return origin;
    });
  }
  client = new RunnerClient(origin, token);
  let health;
  try { health = await client.health(AbortSignal.timeout(10_000)); }
  catch (error) { throw new Blocked(`Runner health is unavailable: ${error.message}`); }
  if (health.sandbox !== "bubblewrap" || !health.execution?.ready) {
    throw new Blocked(`A usable bubblewrap Runner is required: ${JSON.stringify(health.execution)}`);
  }
  return health;
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(done => child.once("exit", done));
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  const timeout = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 5000);
  try { await exited; } finally { clearTimeout(timeout); }
}

const ownerQuery = () => state.owner;
function execution(id, mode, workspace = state.workspace) {
  return { executionId: id, agentId: state.owner.agentId, code: `python3 recovery-fixture.py ${mode}`,
    runnerWorkspaceKey: workspace, workspaceRoot: "unused-control-plane-path", recoveryMetadataPath: "recovery.json",
    permissionEpoch: { id: `${state.runId}-epoch`, sessionId: state.owner.sessionId,
      createdAt: new Date().toISOString(), environmentRevisionId: "audit-only", reason: "offline recovery journey",
      mounts: [{ source: "workspace", mode: "read-write" }], networkPolicy: "none", secretRefs: [] } };
}
async function finished(id) {
  return until(async () => {
    const record = await client.getShellExecution(id, ownerQuery(), AbortSignal.timeout(10_000));
    return record.finishedAt && !["queued", "running"].includes(record.state) ? record : false;
  });
}
async function upload(workspace) {
  await client.writeRemoteWorkspaceFile(workspace, "recovery-fixture.py", await readFile(new URL("../services/runner/workloads/recovery-fixture.py", import.meta.url)));
  await client.writeRemoteWorkspaceFile(workspace, "input.json", Buffer.from("[3,5,7,11]\n"));
  await client.writeRemoteWorkspaceFile(workspace, "config.json", Buffer.from('{"multiplier":2}\n'));
}
function resumeRequest(id) {
  return { ...execution(id, "resume"), recoveryContext: { parentExecutionId: state.original.id,
    recoveryPointId: "continue-units", manifestDigest: state.original.recovery.manifestRef.objectId, attemptToken: id } };
}

try {
  await step("Verify the committed product and isolated target", "Built, clean checkout; explicit local Runner target; no paid or external capabilities.", async () => {
    if (process.platform !== "linux") throw new Blocked("This journey requires Linux bubblewrap");
    if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()) {
      throw new Blocked("Commit the candidate before running this journey");
    }
    if (external) {
      if (!token || !process.env.E2E_REPORT_DIR || !["prepare", "resume"].includes(phase)) {
        throw new Blocked("External mode requires E2E_API_TOKEN, E2E_REPORT_DIR, and E2E_PHASE=prepare or resume");
      }
      const url = new URL(origin);
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Blocked("E2E_BASE_URL must name an isolated loopback HTTP Runner without embedded credentials");
      }
      origin = url.origin;
    } else if (phase !== "all") throw new Blocked("Owned-runner mode uses E2E_PHASE=all");
    try { ({ RunnerClient } = await import("../packages/executor/dist/runner-client.js")); }
    catch (error) { throw new Blocked(`Built Runner client unavailable; run pnpm build first: ${error.message}`); }
    return `SHA ${sha}; production entry: pnpm runner; target: ${external ? origin : "owned ephemeral loopback Runner"}`;
  });

  if (phase === "resume") {
    state = JSON.parse(await readFile(resolve(root, "state.json"), "utf8"));
    assert.equal(state.sha, sha, "resume must use the same committed candidate");
    assert.equal(state.origin, origin, "resume must target the original isolated Runner");
    assert.ok(/^recovery-journey-[a-f0-9-]{36}$/.test(state.runId));
    assert.equal(state.workspace, `${state.runId}/main`);
    assert.equal(state.cleanWorkspace, `${state.runId}/clean`);
    validatedState = true;
    steps = [...state.steps, ...steps];
  } else {
    const runId = `recovery-journey-${randomUUID()}`;
    state = { sha, runId, owner: { sessionId: runId, agentId: "main" }, workspace: `${runId}/main`, cleanWorkspace: `${runId}/clean` };
    validatedState = true;
  }
  await step("Observe production Runner readiness", "The production process reports a usable bubblewrap sandbox.", async () => {
    const value = await start();
    return { status: value.status, sandbox: value.sandbox, bootId: value.execution.instanceId };
  });
  const bootId = (await client.health(AbortSignal.timeout(10_000))).execution.instanceId;

  if (phase !== "resume") {
    state.bootId = bootId;
    await step("Submit the representative workload through signed HTTP", "Two units complete; a real sandboxed Python process fails with a checkpoint and partial diagnostic.", async () => {
      await upload(state.workspace);
      const input = execution(`${state.runId}-initial`, "initial");
      await client.startShellExecution(input, AbortSignal.timeout(10_000));
      state.original = await finished(input.executionId);
      assert.equal(state.original.state, "failed", state.original.error ?? "");
      assert.equal(state.original.result.exitCode, 7);
      assert.equal(state.original.result.sandbox, "bubblewrap");
      assert.equal(state.original.recovery.capability, "supported");
      assert.ok(state.original.recovery.manifestRef);
      assert.equal(state.original.recovery.manifest.objects.find(item => item.id === "partial-unit").integrity, "unverified");
      return { id: state.original.id, state: state.original.state, manifest: state.original.recovery.manifestRef.objectId };
    });
    await step("Inspect evidence without executing or crossing owner scope", "Repeated status reads preserve failure and work count; a different Agent cannot read the execution.", async () => {
      const before = await client.readRemoteWorkspaceFile(state.workspace, "executed-units.jsonl");
      for (let index = 0; index < 3; index++) assert.equal((await client.getShellExecution(state.original.id, ownerQuery())).state, "failed");
      await assert.rejects(client.getShellExecution(state.original.id, { ...ownerQuery(), agentId: "other" }), {
        statusCode: 404, message: "Runner request failed (404)",
      }); // The client preserves status while never exposing the remote error body.
      assert.deepEqual(await client.readRemoteWorkspaceFile(state.workspace, "executed-units.jsonl"), before);
      return "Status is read-only and owner scoped";
    });
    if (external) {
      state.origin = origin; state.steps = steps;
      await writeFile(resolve(root, "state.json"), JSON.stringify(state, null, 2), { mode: 0o600 });
      outcome = "PREPARED";
    } else await step("Restart the owned production Runner", "Restart uses the same isolated data and a new process, never resubmits the original command.", async () => {
      await stop(); await start();
      assert.notEqual((await client.health()).execution.instanceId, state.bootId);
      return "Owned pnpm runner process restarted";
    });
  }

  if (outcome !== "PREPARED") {
    await step("Read the original evidence after restart", "The boot changed but the failed execution and manifest identities are unchanged.", async () => {
      assert.notEqual((await client.health()).execution.instanceId, state.bootId, "restart the external Runner before the resume phase");
      const record = await client.getShellExecution(state.original.id, ownerQuery());
      assert.equal(record.state, "failed");
      assert.deepEqual(record.recovery, state.original.recovery);
      return { id: record.id, manifest: record.recovery.manifestRef.objectId };
    });
    await step("Explicitly continue only the unfinished work", "A new execution completes; prepare and the first two units are not repeated.", async () => {
      const input = resumeRequest(`${state.runId}-resumed`);
      await client.startShellExecution(input);
      const record = await finished(input.executionId);
      assert.equal(record.state, "completed", record.error ?? "");
      assert.equal(record.recoveryContext.parentExecutionId, state.original.id);
      const events = (await client.readRemoteWorkspaceFile(state.workspace, "executed-units.jsonl")).toString().trim().split("\n").map(JSON.parse);
      assert.deepEqual(events, ["prepare", "unit-1", "unit-2", "unit-3", "unit-4"]);
      assert.equal((await client.getShellExecution(state.original.id, ownerQuery())).state, "failed");
      return { child: record.id, parent: state.original.id, events };
    });
    await step("Compare with an independent clean calculation", "Resumed output is byte-for-byte identical to a fresh four-unit result.", async () => {
      await upload(state.cleanWorkspace);
      const input = execution(`${state.runId}-clean`, "clean", state.cleanWorkspace);
      await client.startShellExecution(input);
      assert.equal((await finished(input.executionId)).state, "completed");
      const resumed = await client.readRemoteWorkspaceFile(state.workspace, "result.json");
      assert.deepEqual(resumed, await client.readRemoteWorkspaceFile(state.cleanWorkspace, "result.json"));
      return resumed.toString().trim();
    });
    await step("Reject a changed scientific input before launch", "A fresh continuation request fails without starting Python or repeating any unit.", async () => {
      const before = await client.readRemoteWorkspaceFile(state.workspace, "executed-units.jsonl");
      await client.writeRemoteWorkspaceFile(state.workspace, "input.json", Buffer.from("[3,5,7,12]\n"), "overwrite");
      const input = resumeRequest(`${state.runId}-changed-input`);
      await client.startShellExecution(input);
      const record = await finished(input.executionId);
      assert.equal(record.state, "failed");
      assert.match(record.error, /RECOVERY_PRECONDITION_CHANGED/);
      assert.equal(record.startedAt, undefined);
      assert.deepEqual(await client.readRemoteWorkspaceFile(state.workspace, "executed-units.jsonl"), before);
      return { id: record.id, reason: record.error, launched: false };
    });
    outcome = "PASS";
  }
} catch (error) {
  outcome = error instanceof Blocked ? "BLOCKED" : "FAIL";
  process.exitCode = error instanceof Blocked ? 2 : 1;
  console.error(redact(error.message));
} finally {
  await stop();
  if (ownsData) await rm(dataDir, { recursive: true, force: true });
  else if (external && validatedState && outcome !== "PREPARED" && client) {
    for (const workspace of [state.workspace, state.cleanWorkspace]) await client.deleteRemoteWorkspace(workspace).catch(error => {
      log += `Journey-owned workspace cleanup failed: ${redact(error.message)}\n`;
    });
  }
  const display = value => typeof value === "string" ? value : JSON.stringify(value);
  await writeFile(resolve(root, "report.md"), [
    "# Failed-task recovery: public Runner HTTP journey", "", `Result: ${outcome}`, `Commit: ${sha}`, `Phase: ${phase}`, "",
    "Driver: node test/recovery-runner-journey.mjs", "Startup: pnpm runner (owned mode); operator-managed production Runner (external mode).",
    "Scope: production Runner CLI, real bubblewrap Python execution, authenticated HTTP upload/status/continuation/result retrieval.",
    "Not covered: API Agent permissions/idempotency, browser UI, LLM, real scientific models, NPU, or managed-environment provisioning.",
    "Isolation: journey-owned unique workspaces; no outbound workload network; no external credentials in the report.",
    ...(outcome === "PREPARED" ? ["Restart the external Runner with its data preserved, then rerun with E2E_PHASE=resume and the same report directory. This is not a completed PASS."] : []), "",
    ...steps.flatMap((entry, index) => [`## ${index + 1}. ${entry.name}`, `Expected: ${entry.expected}`, `Actual: ${redact(display(entry.actual))}`, `Result: ${entry.result}`, ""]),
    `Passed: ${steps.filter(entry => entry.result === "PASS").length}; failed: ${steps.filter(entry => entry.result === "FAIL").length}; blocked: ${steps.filter(entry => entry.result === "BLOCKED").length}; skipped: 0.`,
    "Service output: runner.log (owned mode).", "",
  ].join("\n"));
  await writeFile(resolve(root, "runner.log"), log);
  console.log(`${outcome}: report=${resolve(root, "report.md")}`);
}
