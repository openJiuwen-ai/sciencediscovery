// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSourceEvolve } from "./source-evolve.js";

test("explicit source runtime uses the same owned socket, private credential and control lifecycle", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "source-evolve-test-"));
  const python = join(dataDir, "fixture-interpreter"); const stateFile = join(dataDir, "control.json");
  await writeFile(python, `#!${process.execPath}\nconst server=require('node:http').createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/health')return res.end('{"status":"healthy"}');if(req.headers.authorization!=='Bearer '+process.env.SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN){res.statusCode=401;return res.end('{}');}res.end('{"stopped":false}');});server.listen(0,'127.0.0.1',()=>console.log('EVOLVE_PORT='+server.address().port));\n`, { mode: 0o700 });
  let control: Awaited<ReturnType<typeof startSourceEvolve>> | undefined;
  try {
    control = await startSourceEvolve(python, dataDir, stateFile);
    assert.equal(control.runtime.status().state, "ready");
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    const env = JSON.parse(await readFile(stateFile, "utf8"));
    assert.match(env.SCIENCE_AGENT_EVOLVE_CONTROL_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert(env.SCIENCE_AGENT_EVOLVE_CONTROL_TOKEN !== control.runtime.connection()!.internalToken, "control and sidecar credentials have separate lifetimes");
    await control.close(); control = undefined;
    await assert.rejects(readFile(stateFile), { code: "ENOENT" });
    await assert.rejects(startSourceEvolve("/nonexistent/interpreter", dataDir, stateFile), /readiness/);
    await assert.rejects(startSourceEvolve(python, dataDir, join(dataDir, "missing-parent/control")));
  } finally { await control?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("source-stack CLI readiness is atomic and SIGTERM stops both control and owned sidecar", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { setTimeout: delay } = await import("node:timers/promises");
  const dataDir = await mkdtemp(join(tmpdir(), "source-evolve-cli-"));
  const python = join(dataDir, "fixture-interpreter"); const stateFile = join(dataDir, "state.json");
  await writeFile(python, `#!${process.execPath}\nconst server=require('node:http').createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(req.url==='/health'?'{"status":"healthy"}':'{"stopped":false}');});server.listen(0,'127.0.0.1',()=>console.log('EVOLVE_PORT='+server.address().port));\n`, { mode: 0o700 });
  const helper = fileURLToPath(new URL("./source-evolve.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", helper, python, dataDir, stateFile], { stdio: "ignore" });
  const exited = new Promise<number | null>(done => child.once("exit", done));
  try {
    let state: Record<string, string> | undefined;
    for (let attempt = 0; attempt < 100 && !state; attempt++) {
      try { state = JSON.parse(await readFile(stateFile, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!state) await delay(50);
    }
    assert(state, "source helper must publish complete readiness JSON");
    const response = await fetch(`${state.SCIENCE_AGENT_EVOLVE_CONTROL_URL}/status`, { headers: { authorization: `Bearer ${state.SCIENCE_AGENT_EVOLVE_CONTROL_TOKEN}` } });
    const status = await response.json() as { state: string; connection: { url: string } };
    assert.equal(status.state, "ready");
    child.kill("SIGTERM"); assert.equal(await exited, 0);
    await assert.rejects(fetch(`${status.connection.url}/health`));
    await assert.rejects(readFile(stateFile), { code: "ENOENT" });
  } finally { child.kill("SIGKILL"); await exited; await rm(dataDir, { recursive: true, force: true }); }
});
