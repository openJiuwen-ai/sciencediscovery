// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvolveRuntime, startEvolveControl, evolveStartupTimeoutMs, type EvolveRuntimeIo } from "./evolve-runtime.js";
import type { EvolveInstallContext } from "./evolve-install.js";

const FIXTURE = `const http = require('node:http');
const server = http.createServer((req, res) => {
 res.setHeader('content-type','application/json');
 if (req.url === '/health') return res.end(JSON.stringify({status:'healthy'}));
 if (req.url === '/environment') return res.end(JSON.stringify({leaked:process.env.REAL_MODEL_TOKEN !== undefined, locked:process.env.UV_NO_INDEX === "1"}));
 if (req.headers.authorization !== 'Bearer ' + process.env.SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN) { res.statusCode=401;return res.end('{}'); }
 res.end(JSON.stringify({stopped:false}));
});
server.listen(0,'127.0.0.1',()=>console.log('EVOLVE_PORT='+server.address().port));`;
async function fixture(action: (context: EvolveInstallContext) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), "evolve-runtime-test-"));
  const context: EvolveInstallContext = { dataDir, payloadRoot: dataDir, env: { PATH: process.env.PATH, REAL_MODEL_TOKEN: "synthetic-must-not-forward" }, log: () => {},
    manifest: { formatVersion: 1, product: "sciencediscovery", version: "fixture", architecture: "x86_64", runtimeArchitecture: "x64",
      python: { version: "fixture", path: "missing", sitePackages: "unused" }, node: { version: "fixture", path: "node" },
      app: { root: ".", apiEntry: "unused", runnerEntry: "unused", webDir: "unused" } } };
  try { await action(context); } finally { await rm(dataDir, { recursive: true, force: true }); }
}
test("restore is zero-download; explicit init starts owned socket with auth, no inherited model credential, then stops", async () => fixture(async (context) => {
  let installs = 0; let launches = 0;
  const runtime = new EvolveRuntime(context, {
    install: async (init) => { if (!init) return undefined; installs++; return { python: process.execPath, root: context.dataDir, token: "fixture-private" }; },
    spawn: ((_command, _args, options) => { launches++; return spawn(process.execPath, ["-e", FIXTURE], options); }),
    fetch, startupTimeoutMs: 5_000,
  });
  await runtime.start(); assert.equal(runtime.status().state, "not_initialized"); assert.equal(launches, 0);
  await Promise.all([runtime.start(true), runtime.start(true)]);
  try {
    assert.equal(installs, 1); assert.equal(launches, 1); assert.equal(runtime.status().state, "ready");
    const connection = runtime.connection()!; assert.match(connection.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(`${connection.url}/runs/x/stop`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${connection.url}/runs/x/stop`, { method: "POST", headers: { authorization: `Bearer ${connection.internalToken}` } })).status, 200);
    assert.deepEqual(await (await fetch(`${connection.url}/environment`)).json(), { leaked: false, locked: true });
    await runtime.start(true); assert.equal(installs, 1);
  } finally { await runtime.stop(); }
  assert.equal(runtime.connection(), undefined);
  await assert.rejects(runtime.start(true), /stopping/);
}));
test("installer, spawn, authentication, malformed port and health failures remain unavailable and retryable", async () => fixture(async (context) => {
  for (const mode of ["install", "spawn", "auth", "port", "health", "network"]) {
    const io: EvolveRuntimeIo = {
      install: async () => { if (mode === "install") throw new Error("failure with synthetic-private-detail"); return { python: process.execPath, root: context.dataDir, token: "fixture-private" }; },
      spawn: ((_command, _args, options) => spawn(mode === "spawn" ? "/nonexistent/evolve-test-command" : process.execPath,
        ["-e", mode === "port" ? "console.log('EVOLVE_PORT=99999');setInterval(()=>{},1000)" : FIXTURE], options)),
      fetch: async (...args) => {
        if (mode === "network") throw new Error("network failed");
        if (mode === "health") return Response.json({ status: "unhealthy" });
        if (mode === "auth" && String(args[0]).includes("/stop")) return Response.json({}, { status: 401 });
        return fetch(...args);
      }, startupTimeoutMs: 200,
    };
    const runtime = new EvolveRuntime(context, io);
    try { await runtime.start(true); assert.equal(runtime.status().state, "error", mode);
      assert.equal(runtime.connection(), undefined); assert(!JSON.stringify(runtime.status()).includes("synthetic-private-detail"));
    } finally { await runtime.stop(); }
  }
}));
test("unexpected child exit clears its endpoint; explicit retry restores it", async () => fixture(async (context) => {
  let child: ReturnType<typeof spawn> | undefined;
  const runtime = new EvolveRuntime(context, {
    install: async () => ({ python: process.execPath, root: context.dataDir, token: "fixture-private" }),
    spawn: ((_command, _args, options) => child = spawn(process.execPath, ["-e", FIXTURE], options)),
    fetch, startupTimeoutMs: 5_000,
  });
  try {
    await runtime.start(); const exited = new Promise(resolve => child!.once("exit", resolve)); child!.kill(); await exited;
    assert.equal(runtime.status().state, "error"); assert.equal(runtime.connection(), undefined);
    await runtime.start(true); assert.equal(runtime.status().state, "ready");
  } finally { await runtime.stop(); }
}));
test("private launcher control enforces auth and verbs; failed Init remains a safe public state", async () => fixture(async (context) => {
  const control = await startEvolveControl(context);
  try {
    const url = control.env.SCIENCE_AGENT_EVOLVE_CONTROL_URL!;
    const headers = { authorization: `Bearer ${control.env.SCIENCE_AGENT_EVOLVE_CONTROL_TOKEN}` };
    assert.equal((await fetch(`${url}/status`)).status, 401);
    assert.equal((await fetch(`${url}/init`, { headers })).status, 404);
    assert.equal((await fetch(`${url}/other`, { headers })).status, 404);
    assert.deepEqual(await (await fetch(`${url}/status`, { headers })).json(), { state: "not_initialized", canInitialize: true });
    const result = await (await fetch(`${url}/init`, { method: "POST", headers })).json() as { state: string; connection?: unknown };
    assert.equal(result.state, "error"); assert.equal(result.connection, undefined);
  } finally { await control.close(); }
}));
test("shutdown during initialization cannot publish or spawn a late installation", async () => fixture(async (context) => {
  let release: (value: { python: string; root: string; token: string }) => void;
  const runtime = new EvolveRuntime(context, {
    install: async () => await new Promise(resolve => { release = resolve; }),
    spawn: (() => { throw new Error("must not spawn after shutdown"); }), fetch,
  });
  const initializing = runtime.start(true);
  await Promise.resolve();
  const stopping = runtime.stop();
  release!({ python: process.execPath, root: context.dataDir, token: "synthetic" });
  await initializing; await stopping;
  assert.equal(runtime.connection(), undefined);
  assert.equal(runtime.status().canInitialize, false);
}));
test("exit during authenticated readiness cannot republish a dead child; explicit retry succeeds", async () => fixture(async (context) => {
  let child: ReturnType<typeof spawn>; let interrupt = true; let requests = 0;
  const runtime = new EvolveRuntime(context, {
    install: async () => ({ python: process.execPath, root: context.dataDir, token: "fixture-private" }),
    spawn: (_command, _args, options) => child = spawn(process.execPath, ["-e", FIXTURE], options),
    fetch: async (...args) => {
      const response = await fetch(...args); requests++;
      if (interrupt && String(args[0]).includes("/stop")) {
        interrupt = false;
        const exited = new Promise(resolve => child.once("exit", resolve));
        child.kill("SIGTERM"); await exited;
      }
      return response;
    }, startupTimeoutMs: 5_000,
  });
  try {
    await runtime.start(true);
    assert.equal(requests, 2, "readiness must not keep contacting an exited process");
    assert.equal(runtime.status().state, "error"); assert.equal(runtime.connection(), undefined);
    await runtime.start(true);
    assert.equal(runtime.status().state, "ready"); assert(runtime.connection());
  } finally { await runtime.stop(); }
}));
test("shutdown while health or auth is completing cannot publish a connection", async () => fixture(async (context) => {
  for (const boundary of ["/health", "/stop"]) {
    let child: ReturnType<typeof spawn>; let stopping: Promise<void> | undefined;
    let deliverSignal: (() => void) | undefined; let requests = 0;
    const runtime = new EvolveRuntime(context, {
      install: async () => ({ python: process.execPath, root: context.dataDir, token: "fixture-private" }),
      spawn: (_command, _args, options) => {
        child = spawn(process.execPath, ["-e", FIXTURE], options);
        const kill = child.kill.bind(child);
        // Hold signal delivery so the assertion observes publication before stop
        // completes, rather than allowing stop's final state to hide the race.
        child.kill = signal => { deliverSignal = () => { kill(signal); }; return true; };
        return child;
      },
      fetch: async (...args) => {
        const response = await fetch(...args); requests++;
        if (String(args[0]).includes(boundary)) stopping = runtime.stop();
        return response;
      }, startupTimeoutMs: 5_000,
    });
    try {
      await runtime.start(true);
      assert.equal(runtime.connection(), undefined, boundary);
      assert.notEqual(runtime.status().state, "ready", boundary);
      assert.equal(requests, boundary === "/health" ? 1 : 2);
    } finally { deliverSignal?.(); await stopping; await runtime.stop(); }
  }
}));
test("owned sidecars receive documented candidate/log settings, with source-only provisioning settings and no model secrets", async () => fixture(async context => {
  const settings = {
    SCIENCE_AGENT_EVOLVE_CANDIDATE_DIR: join(context.dataDir, 'operator-candidates'),
    SCIENCE_AGENT_EVOLVE_LOG_LEVEL: 'debug', SCIENCE_AGENT_LOG_LEVEL: 'warning', SCIENCE_AGENT_LOG_DIR: join(context.dataDir, 'operator-logs'),
    SCIENCE_AGENT_LOG_MAX_BYTES: '2048', SCIENCE_AGENT_LOG_BACKUP_COUNT: '2',
  };
  const provisioning = { HTTP_PROXY: 'http://proxy.invalid:3128', HTTPS_PROXY: 'http://proxy.invalid:3128', ALL_PROXY: 'http://proxy.invalid:3128', NO_PROXY: '127.0.0.1',
    http_proxy: 'http://proxy.invalid:3128', https_proxy: 'http://proxy.invalid:3128', all_proxy: 'http://proxy.invalid:3128', no_proxy: 'localhost',
    UV_INDEX_URL: 'https://index.invalid/simple', UV_DEFAULT_INDEX: 'https://index.invalid/simple', UV_EXTRA_INDEX_URL: 'https://extra.invalid/simple',
    PIP_INDEX_URL: 'https://index.invalid/simple', PIP_EXTRA_INDEX_URL: 'https://extra.invalid/simple', SSL_CERT_FILE: '/fixture/cert.pem', SSL_CERT_DIR: '/fixture/certs' };
  const keys = [...Object.keys(settings), ...Object.keys(provisioning)];
  context.env = { ...context.env, ...settings, ...provisioning, HOME: '/fixture/private-home', OPENAI_API_KEY: 'synthetic-never-forward' };
  for (const allowRuntimeProvisioning of [false, true]) {

    const runtime = new EvolveRuntime(context, { install: async () => ({ python: process.execPath, root: context.dataDir, token: 'synthetic-private' }),
      spawn: (_command, _args, options) => spawn(process.execPath, ['-e', FIXTURE.replace("if (req.url === '/environment') return res.end(JSON.stringify({leaked:process.env.REAL_MODEL_TOKEN !== undefined, locked:process.env.UV_NO_INDEX === \"1\"}));",`if(req.url==='/environment')return res.end(JSON.stringify({values:Object.fromEntries(${JSON.stringify(keys)}.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]])),leaked:process.env.HOME!==undefined||process.env.OPENAI_API_KEY!==undefined||process.env.REAL_MODEL_TOKEN!==undefined}));`)], options), fetch, allowRuntimeProvisioning, startupTimeoutMs: 5_000 });
    try {
      await runtime.start(); assert.equal(runtime.status().state, 'ready');
      const result = await (await fetch(runtime.connection()!.url + '/environment')).json();
      assert.deepEqual(result, { values: { ...settings, ...(allowRuntimeProvisioning ? provisioning : {}) }, leaked: false });
    } finally { await runtime.stop(); }
  }
}));

test("the documented source health budget also permits slow owned startup", async () => fixture(async context => {
  assert.equal(evolveStartupTimeoutMs({}), 60_000);
  assert.equal(evolveStartupTimeoutMs({ SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS: '120' }), 120_000);
  for (const value of ['0', '-1', '0.5', 'invalid', 'Infinity', '9007199254740991']) assert.throws(() => evolveStartupTimeoutMs({ SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS: value }), /HEALTH_TIMEOUT/);
  context.env.SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS = '120';
  const original = Date.now; let calls = 0;
  Date.now = () => original() + (calls++ === 0 ? 0 : 61_000);
  const runtime = new EvolveRuntime(context, { install: async () => ({ python: process.execPath, root: context.dataDir, token: 'fixture-private' }),
    spawn: (_command, _args, options) => spawn(process.execPath, ['-e', FIXTURE], options), fetch });
  try { await runtime.start(); assert.equal(runtime.status().state, 'ready'); assert(runtime.connection()); }
  finally { Date.now = original; await runtime.stop(); }
}));
