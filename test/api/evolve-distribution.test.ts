// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
/**
 * Distribution journey: download the released runtime and designated source,
 * initialize through the launcher's authenticated control, then run a real
 * sandboxed PUCT task with a local canned model. No source-tree Python env,
 * model credentials or paid calls. Runs in ordinary ST, not a release profile.
 */
import { createTest } from "../support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:st", "os:linux", "arch:amd64", "arch:arm64", "model:mock", "sandbox:bubblewrap"] });
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { defaultBootstrapIo, type BootstrapIo } from "../../services/launcher/src/bootstrap.js";
import { startEvolveControl } from "../../services/launcher/src/evolve-runtime.js";
import { EVOLVE_RELEASE } from "../../services/launcher/src/evolve-lock.js";
import type { PayloadManifest } from "../../services/launcher/src/payload-manifest.js";

const run = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const BASELINE = '"""Predict the training mean."""\nimport pandas as pd\ndef train_and_predict(train_path, test_path):\n    train = pd.read_csv(train_path)\n    test = pd.read_csv(test_path)\n    return [float(train["y"].mean())] * len(test)\n';
const CANDIDATE = '```python\n"""Learn the linear relation."""\nimport pandas as pd\nfrom sklearn.linear_model import LinearRegression\ndef train_and_predict(train_path, test_path):\n    train = pd.read_csv(train_path)\n    test = pd.read_csv(test_path)\n    model = LinearRegression()\n    model.fit(train[["x"]], train["y"])\n    return list(model.predict(test[["x"]]))\n```';

test("a user initializes the pinned release into an empty installation and completes a real Evolve task", { timeout: 15 * 60_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "evolve-distribution-"));
  const evidence: object[] = [];
  const record = (step: string, result: object = {}) => { evidence.push({ step, ...result }); };
  let control: Awaited<ReturnType<typeof startEvolveControl>> | undefined;
  let calls = 0;
  const model = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer synthetic-model-token");
    let body = ""; for await (const chunk of request) body += chunk;
    assert.match(JSON.parse(body).messages[0].content, /train_and_predict/);
    calls++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: CANDIDATE }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200 } }));
  });
  try {
    const pins = JSON.parse(await readFile(join(repository, "scripts/binary-release/runtimes.json"), "utf8"));
    const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
    await run(process.execPath, [join(repository, "scripts/binary-release/fetch-runtime.mjs"), "--runtime", "python", "--arch", architecture, "--output", join(workspace, "python"), "--cache", join(workspace, "downloads")], { timeout: 5 * 60_000 });
    record("Resolve and download the pinned distribution Python", { version: pins.python.version, sha256: pins.python.architectures[architecture].sha256 });
    const uv = pins.uv.architectures[architecture];
    const manifest: PayloadManifest = {
      formatVersion: 2, version: "distribution-journey", product: "sciencediscovery", architecture, runtimeArchitecture: process.arch,
      python: { version: pins.python.version, path: "python/bin/python3", sitePackages: "python/lib/python3.12/site-packages" },
      node: { version: process.version, path: "node" }, app: { root: ".", apiEntry: "unused", runnerEntry: "unused", webDir: "unused" },
      bootstrap: { requirementsPath: "unused", gatewayWheelPath: "unused", uv: { version: pins.uv.version, project: pins.uv.project, wheelFilename: uv.filename, wheelSha256: uv.sha256 } },
    };
    let sourceDownloads = 0; let injectDependencyFailure = true;
    const log = (message: string) => record("Installer progress", { message });
    const realIo = defaultBootstrapIo(log);
    const io: BootstrapIo = { ...realIo,
      fetch: async (url, options) => { if (String(url) === EVOLVE_RELEASE.url) sourceDownloads++; return await realIo.fetch(url, options); },
      run: async (command, args, options) => {
        if (args[0] === "pip" && injectDependencyFailure) {
          injectDependencyFailure = false;
          // Apparent size crosses the quota without allocating GiB of data or running pip.
          const file = await open(join(options!.env!.TMPDIR!, "quota-fixture"), "wx");
          try {
            await file.truncate(1024 * 1024 * 1024 + 1);
            assert((await file.stat()).blocks * 512 < 1024 * 1024, "sparse fault must not consume host disk");
          } finally { await file.close(); }
          assert(options?.signal);
          const signal = options.signal;
          await new Promise<void>((done, reject) => {
            const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); reject(new Error("disk monitor did not cancel dependency installation")); }, 10_000);
            const aborted = () => { clearTimeout(timer); done(); };
            signal.addEventListener("abort", aborted, { once: true });
            if (signal.aborted) { signal.removeEventListener("abort", aborted); aborted(); }
          });
          assert(signal.aborted);
          record("Actual disk monitor cancels sparse over-quota dependency staging without allocating GiB");
          throw new Error("controlled dependency-installer failure");
        }
        return await realIo.run(command, args, options);
      },
    };
    const context = { dataDir: join(workspace, "data"), payloadRoot: workspace, manifest, io,
      env: { PATH: process.env.PATH, SCIENCE_AGENT_EVOLVE_CANDIDATE_DIR: join(workspace, "operator-candidates"), SCIENCE_AGENT_PYPI_INDEX: "https://pypi.org/simple" }, log };
    control = await startEvolveControl(context);
    assert.equal(control.runtime.status().state, "not_initialized");
    assert(control.runtime.connection() === undefined, "unavailable service must not expose a connection");
    record("Serve without Evolve does not install or launch it");
    const headers = { authorization: `Bearer ${control.env.SCIENCE_AGENT_EVOLVE_CONTROL_TOKEN}` };
    const initUrl = `${control.env.SCIENCE_AGENT_EVOLVE_CONTROL_URL}/init`;
    const failed = await fetch(initUrl, { method: "POST", headers, signal: AbortSignal.timeout(5 * 60_000) });
    assert.equal((await failed.json() as { state: string }).state, "error");
    assert(control.runtime.connection() === undefined, "unavailable service must not expose a connection");
    assert(!(await readdir(join(context.dataDir, "evolve"))).some(name => name.startsWith(".install-")));
    record("A controlled dependency-installer failure cleans staging and leaves the service unavailable");
    const [init, concurrent] = await Promise.all([0, 1].map(() => fetch(initUrl, { method: "POST", headers, signal: AbortSignal.timeout(12 * 60_000) })));
    assert.equal(init!.status, 200); assert.equal(concurrent!.status, 200);
    assert.equal((await concurrent!.json() as { state: string }).state, "ready");
    assert.equal(sourceDownloads, 2, "one failed attempt and one coalesced retry download");
    const result = await init!.json() as { state: string; error?: string };
    assert.equal(result.state, "ready", result.error ?? "Evolve did not initialize");
    const connection = control.runtime.connection()!;
    record("Explicit Init downloads, verifies and installs the designated source plus frozen candidate dependencies", { release: EVOLVE_RELEASE.release, commit: EVOLVE_RELEASE.commit, sourceSha256: EVOLVE_RELEASE.sha256, requirementsSha256: EVOLVE_RELEASE.requirementsSha256 });
    const health = await fetch(`${connection.url}/health`);
    assert.equal((await health.json() as { status: string }).status, "healthy");
    assert.equal((await fetch(`${connection.url}/runs/unknown/stop`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${connection.url}/runs/unknown/stop`, { method: "POST", headers: { authorization: "Bearer wrong-fixture" } })).status, 401);
    record("Owned launcher process passes health and rejects absent/wrong internal credentials");
    const dataset = join(workspace, "dataset");
    await mkdir(join(dataset, "err"), { recursive: true });
    await writeFile(join(dataset, "err/train.csv"), "x,y\n" + Array.from({ length: 40 }, (_, x) => `${x},${3 * x + 1}\n`).join(""));
    const roles = ["rollout", "rollout", "rollout", "rollout", "gate", "gate", "gate", "gate", "test"];
    const shards = [];
    for (const [index, role] of roles.entries()) {
      await mkdir(join(dataset, "err", String(index)));
      const rows = Array.from({ length: 4 }, (_, n) => 40 + index * 4 + n);
      await writeFile(join(dataset, `err/${index}/test.csv`), "x\n" + rows.join("\n") + "\n");
      await writeFile(join(dataset, `err/${index}/truth.json`), JSON.stringify(rows.map(x => 3 * x + 1)));
      shards.push({ index, role, train: "err/train.csv", test: `err/${index}/test.csv`, truth: `err/${index}/truth.json` });
    }
    await writeFile(join(dataset, "manifest.json"), JSON.stringify({ criteria: { err: { shards } }, schemaVersion: 1 }));
    await new Promise<void>(resolveListen => model.listen(0, "127.0.0.1", resolveListen));
    const modelUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1/chat/completions`;
    const response = await fetch(`${connection.url}/runs`, { method: "POST", headers: { authorization: `Bearer ${connection.internalToken}`, "content-type": "application/json" },
      body: JSON.stringify({ search_id: "distribution-journey", algorithm: "puct", engine: "puct", expansions: 2,
        scorecard_hash: "sha256:distribution-journey", statement: "Bring the prediction error down", baseline_code: BASELINE, dataset_dir: dataset,
        candidate_timeout_seconds: 60, llm: { url: modelUrl, token: "synthetic-model-token" },
        sandbox: { backend: "bwrap", bwrap_path: "bwrap", disable_userns: false, proc_mode: "proc" },
        scorecard: { aggregate: "weighted_sum", constraints: [], criteria: [{ direction: "minimize", id: "err", name: "mean absolute error", measure: { datasetCas: ["sha256:fixture"], kind: "dataset_metric", metric: { direction: "minimize", name: "mae" }, split: { gateShards: 4, rolloutShards: 4, seed: 0, shardRows: 4, testShards: 1, trainRows: 40 } }, normalize: { kind: "reciprocal" }, weight: 1 }], hash: "sha256:distribution-journey", schemaVersion: 1, solvedThreshold: 0.999 } }),
      signal: AbortSignal.timeout(180_000) });
    const taskBody = await response.text();
    if (!response.ok) record("Task HTTP failure", { status: response.status, body: taskBody });
    assert.equal(response.status, 200, taskBody);
    const records = taskBody.split("\n").filter(Boolean).map(line => JSON.parse(line));
    const events = records.map(record => record.event);
    assert.equal(events[0].type, "search_started"); assert.equal(events.at(-1).type, "search_finished");
    assert.equal(events.at(-1).status, "succeeded");
    const baseline = events.find(event => event.type === "seeded").baselineScore;
    assert(events.some(event => event.type === "expanded" && event.valid === true && event.score > baseline));
    assert(events.at(-1).bestTestScore > baseline);
    assert(calls > 0); assert(calls <= 2);
    record("A real PUCT task with sandboxed pandas/sklearn candidates improves its held-out score", { modelCalls: calls, result: "succeeded" });
    const { CandidateSources } = await import("../../services/api/src/evolution/candidates.js");
    const winner = events.find(event => event.type === "expanded" && event.valid === true && event.score > baseline);
    const source = await new CandidateSources(context.dataDir, context.env.SCIENCE_AGENT_EVOLVE_CANDIDATE_DIR).read("distribution-journey", winner.codeHash);
    assert(source?.includes("LinearRegression"), "API candidate reader must find the actual sidecar output at the configured override");
    record("The API reads the actual winning candidate from the operator-configured shared directory");
    const token = connection.internalToken;
    await control.close(); control = undefined;
    await assert.rejects(fetch(`${connection.url}/health`));
    control = await startEvolveControl(context);
    assert.equal(control.runtime.status().state, "ready");
    assert(control.runtime.connection()!.internalToken === token, "restart must reuse the private install credential");
    assert.equal(sourceDownloads, 2, "restart must not download or reinstall");
    record("Restart reuses the installation and its private token, with a fresh owned process");
  } finally {
    await control?.close();
    model.closeAllConnections();
    if (model.listening) await new Promise<void>(done => model.close(() => done()));
    const destination = process.env.CI_RESULTS_DIR ? resolve(process.env.CI_RESULTS_DIR, "evolve-install-journey.json") : join(repository, ".tmp/evolve-install-journey.json");
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, JSON.stringify({ sourceRelease: EVOLVE_RELEASE.release, evidence }, null, 2));
    await rm(workspace, { recursive: true, force: true });
  }
});
