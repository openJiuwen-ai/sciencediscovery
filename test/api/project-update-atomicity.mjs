// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: a rejected Project rename cannot change Runner allocation or persist it on a later save.
 * Steps: create owned Projects; reject duplicate names combined with unified or legacy allocation changes;
 * reread formal state, perform an unrelated successful save and reread again.
 * Environment: committed built Native product with a new isolated data directory and loopback port.
 * Type: credential-free; LLM/Runner execution/Paper/WebSearch/OtherExternal: none.
 * Credentials: isolated E2E_API_TOKEN only, never stored in reports.
 * CostSideEffects: create and delete only this driver's Projects; no host connections or execution.
 * Run: E2E_PROJECT_UPDATE_ISOLATED=1 E2E_BASE_URL=http://127.0.0.1:<owned-port>
 * E2E_API_TOKEN=<owned-token> E2E_STARTUP_COMMAND='<actual startup>' node test/api/project-update-atomicity.mjs
 * Browser and real-LLM behavior are not exercised.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
const marker = `project-atomicity-${randomUUID()}`, directory = `.tmp/${marker}`;
await mkdir(directory, { recursive: true });
const origin = process.env.E2E_BASE_URL, token = process.env.E2E_API_TOKEN;
const steps = [], owned = [];
let outcome = "BLOCKED", sha;
class Blocked extends Error {}
async function api(path, body, method = body === undefined ? "GET" : "POST", expected = body === undefined ? 200 : 201) {
  const response = await fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.equal(response.status, expected, `${method} ${path}: ${value.code ?? response.status}`); return value;
}
async function step(name, action) { try { await action(); steps.push({ name, status: "PASS" }); } catch (error) { steps.push({ name, status: error instanceof Blocked ? "BLOCKED" : "FAIL", error: String(error) }); throw error; } }
const project = async id => (await api("/api/projects")).find(item => item.id === id);
try {
  await step("1. Verify isolation and create owned duplicate-name targets", async () => {
    if (!origin || !token || process.env.E2E_PROJECT_UPDATE_ISOLATED !== "1" || !process.env.E2E_STARTUP_COMMAND) throw new Blocked("Owned isolated startup metadata is required");
    const url = new URL(origin);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || ["4310", "4420", "4421"].includes(url.port)) throw new Blocked("An owned loopback instance is required");
    const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim(); sha = git("rev-parse", "HEAD");
    if (git("status", "--porcelain", "--untracked-files=no")) throw new Blocked("Commit the candidate before running");
    await api("/health"); owned.push(await api("/api/projects", { name: marker }));
  });
  outcome = "FAIL";
  for (const [label, initial, patch] of [["unified", ["local"], { runnerIds: [] }], ["legacy", [], { remoteRunnerHostIds: [] }]]) {
    await step(`2. Reject the ${label} allocation change without modifying formal state`, async () => {
      const target = await api("/api/projects", { name: `${marker}-${label}`, runnerIds: initial }); owned.push(target);
      const before = await project(target.id);
      const rejected = await api(`/api/projects/${target.id}`, { name: marker, ...patch }, "PATCH", 409);
      assert.match(JSON.stringify(rejected), /already exists/);
      assert.deepEqual(await project(target.id), before);
      await api(`/api/projects/${target.id}`, { description: "owned subsequent valid save" }, "PATCH", 200);
      assert.deepEqual(await project(target.id), { ...before, description: "owned subsequent valid save" });
    });
  }
  outcome = "PASS";
} catch (error) { outcome = error instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  try { for (const item of owned.toReversed()) await api(`/api/projects/${item.id}`, { confirmationId: item.id }, "DELETE", 200); }
  catch { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Delete only the owned Projects", status: "FAIL" }); }
  await writeFile(`${directory}/report.json`, JSON.stringify({ outcome, sha, startup: process.env.E2E_STARTUP_COMMAND, steps, realLLM: false }, null, 2));
  await writeFile(`${directory}/report.md`, `# Project update atomicity: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(item => `- ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`);
  console.log(JSON.stringify({ outcome, sha, report: `${directory}/report.md` }));
}
