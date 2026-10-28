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
test("source helper forwards only operator provisioning and sidecar settings into the actual owned child", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'source-evolve-env-'));
  const python = join(dataDir, 'fixture-interpreter'); const output = join(dataDir, 'captured.json');
  const settings = { SCIENCE_AGENT_EVOLVE_CANDIDATE_DIR: join(dataDir, 'candidates'), SCIENCE_AGENT_LOG_DIR: join(dataDir, 'logs'),
    SCIENCE_AGENT_LOG_LEVEL: 'debug', HTTPS_PROXY: 'http://proxy.invalid:3128', UV_INDEX_URL: 'https://index.invalid/simple', OPENAI_API_KEY: 'synthetic-must-not-forward' };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  await writeFile(python, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({values:Object.fromEntries(${JSON.stringify(Object.keys(settings).filter(key => key !== 'OPENAI_API_KEY'))}.map(k=>[k,process.env[k]])),leaked:process.env.OPENAI_API_KEY!==undefined||process.env.HOME!==undefined}));\nconst s=require('node:http').createServer((req,res)=>res.end(req.url==='/health'?'{"status":"healthy"}':'{"stopped":false}'));s.listen(0,'127.0.0.1',()=>console.log('EVOLVE_PORT='+s.address().port));`, { mode: 0o700 });
  let control: Awaited<ReturnType<typeof startSourceEvolve>> | undefined;
  try {
    Object.assign(process.env, settings);
    control = await startSourceEvolve(python, dataDir, join(dataDir, 'state.json'));
    assert.equal(control.runtime.status().state, 'ready');
    const { OPENAI_API_KEY: _secret, ...expected } = settings;
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { values: expected, leaked: false });
  } finally {
    await control?.close(); for (const key of Object.keys(settings)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(dataDir, { recursive: true, force: true });
  }
});
test("blank source-helper budgets start owned services; nonblank invalid values remain rejected", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'source-evolve-budget-')); const python = join(dataDir, 'interpreter');
  const previous = process.env.SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS;
  await writeFile(python, `#!${process.execPath}\nconst s=require('node:http').createServer((req,res)=>res.end(req.url==='/health'?'{"status":"healthy"}':'{"stopped":false}'));s.listen(0,'127.0.0.1',()=>console.log('EVOLVE_PORT='+s.address().port));`, { mode: 0o700 });
  try {
    for (const value of ['', ' \t\n ', '120']) {
      process.env.SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS = value;
      const control = await startSourceEvolve(python, dataDir, join(dataDir, 'state.json'));
      try { assert.equal(control.runtime.status().state, 'ready'); assert(control.runtime.connection()); }
      finally { await control.close(); }
    }
    for (const value of ['0', '-1', '1.5', 'invalid']) {
      process.env.SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS = value;
      await assert.rejects(startSourceEvolve(python, dataDir, join(dataDir, 'state.json')), /HEALTH_TIMEOUT/);
    }
  } finally {
    if (previous === undefined) delete process.env.SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS; else process.env.SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});
test("actual shell health waits default for blank values and retain explicit positive budgets", async () => {
  const { execFileSync } = await import('node:child_process');
  const source = await readFile(new URL('../../../scripts/start-stack.sh', import.meta.url), 'utf8');
  const start = source.indexOf('wait_healthy()'); const end = source.indexOf('\n}', start) + 2;
  assert(start >= 0 && end > start, 'actual shell helper must be found');
  const helper = source.slice(start, end);
  for (const [value, expected] of [['', 3], [' \t\n ', 3], ['2', 10]] as const) {
    // Execute the production function. Only curl/sleep are bounded local fixtures;
    // counting sleeps observes the budget without contacting a service or waiting.
    const stdout = execFileSync('bash', ['-c', helper + '\nhealth_attempts=3; count=0; curl(){ return 1; }; sleep(){ count=$((count+1)); }; wait_healthy fixture fixture 2>/dev/null || true; echo "$count"'],
      { env: { PATH: process.env.PATH, SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS: value }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(Number(stdout.trim()), expected);
  }
});

test("actual source CLI rejects missing arguments and failed startup without publishing private state", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "source-cli-refusal-")); const state = join(root, "state.json");
  const helper = fileURLToPath(new URL("./source-evolve.ts", import.meta.url));
  try {
    for (const [args, message] of [[[], /Expected interpreter, data directory and private state file/], [[join(root, "missing-interpreter"), root, state], /^Evolve could not start\. Check the provisioned source runtime\.\s*$/]] as const) {
      await assert.rejects(promisify(execFile)(process.execPath, ["--import", "tsx", helper, ...args], {
        env: { PATH: process.env.PATH, TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }, timeout: 10_000,
      }), error => {
        const failure = error as Error & { code?: number; signal?: string; stdout: string; stderr: string };
        assert.equal(failure.code, 1); assert.equal(failure.signal, null); assert.equal(failure.stdout, "");
        assert.match(failure.stderr, message); assert(!failure.stderr.includes("Bearer")); return true;
      });
      await assert.rejects(readFile(state), { code: "ENOENT" });
    }
    const { pathToFileURL } = await import("node:url");
    const imported = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(helper).href)});console.log('import-only');`], {
      env: { PATH: process.env.PATH, TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }, timeout: 5_000,
    });
    assert.equal(imported.stdout, "import-only\n"); assert.equal(imported.stderr, "");
    await assert.rejects(readFile(state), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("both actual shell readiness budget guards default blanks and retain explicit budgets", async () => {
  const source = await readFile(new URL("../../../scripts/start-stack.sh", import.meta.url), "utf8");
  const begin = source.indexOf('    if [[ "${SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS:-}"', source.indexOf('local evolve_state evolve_pid evolve_attempts=300'));
  const end = source.indexOf('\n    # Private control', begin);
  assert(begin >= 0 && end > begin, "actual Evolve readiness guard/loop must exist");
  const guardAndLoop = source.slice(begin, end);
  for (const [value, expected] of [["", 300], [" \t\n ", 300], ["2", 10]] as const) {
    const script = 'probe(){ local evolve_attempts=300 evolve_state=/nonexistent-fixture count=0; kill(){ return 0; }; sleep(){ count=$((count+1)); };\n' + guardAndLoop + '\n}; probe; status=$?; echo "$count"; exit "$status"';
    const result = (await import("node:child_process")).spawnSync("bash", ["-c", script.replace('local evolve_attempts=300 evolve_state=/nonexistent-fixture count=0', 'local evolve_attempts=300 evolve_state=/nonexistent-fixture; count=0')], {
      env: { PATH: process.env.PATH, SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS: value }, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.status, 1); assert.match(result.stderr, /Evolve did not become ready/);
    assert.equal(Number(result.stdout.trim()), expected); assert.equal(result.signal, null);
  }
});

test("actual source CLI SIGTERM during startup exits cleanly without publishing readiness or leaving its child", { timeout: 10_000 }, async () => {
  const { spawn } = await import("node:child_process"); const { fileURLToPath } = await import("node:url");
  const { setTimeout: delay } = await import("node:timers/promises");
  const root = await mkdtemp(join(tmpdir(), "source-cli-abort-")); const state = join(root, "state.json");
  const marker = join(root, "child.pid"); const interpreter = join(root, "interpreter");
  await writeFile(interpreter, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`, { mode: 0o700 });
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./source-evolve.ts", import.meta.url)), interpreter, root, state], {
    env: { PATH: process.env.PATH, TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = ""; let stdout = ""; child.stderr.on("data", chunk => { stderr += chunk; }); child.stdout.on("data", chunk => { stdout += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once("exit", (code, signal) => done({ code, signal })));
  try {
    let pid: number | undefined;
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      try { pid = Number(await readFile(marker, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!pid) await delay(20);
    }
    assert(pid, "actual owned child must have started before interruption");
    child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: 0, signal: null }); assert.equal(stderr, ""); assert.equal(stdout, "");
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
    await assert.rejects(readFile(state), { code: "ENOENT" });
  } finally { child.kill("SIGKILL"); await exited; await rm(root, { recursive: true, force: true }); }
});
