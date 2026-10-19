// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * Source-start dependency journey for Issue #29. No LLM and no network.
 * Build the API and the Runner first (pnpm build), then from the repository root:
 *   node test/api/source-start-dependency-journey.mjs
 * A user on a bare host runs scripts/start-stack.sh, learns every missing host
 * dependency and its fix from one run, and can follow the printed links. Once
 * the tools are present but bubblewrap is not, the Runner they start says how to
 * install it, in the terminal and in the readiness the Web UI shows.
 * Uses throwaway PATH directories, ephemeral loopback ports and tokens, and
 * ignored private data; writes report.md under .tmp/ and removes its data.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".tmp", "source-start-dependency-" + randomUUID());
const runnerToken = randomUUID();
const apiToken = randomUUID();
const sha = execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim();
const dirty = Boolean(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {encoding: "utf8"}).trim());
const redact = (text) => String(text).replaceAll(runnerToken, "[redacted]").replaceAll(apiToken, "[redacted]")
  .replaceAll(process.cwd(), "<worktree>");
const which = (command) => execFileSync("bash", ["-c", `command -v ${command}`], {encoding: "utf8"}).trim();
const steps = [];
const services = [];

async function step(name, operation) {
  const started = Date.now();
  try {
    const detail = await operation();
    steps.push({name, result: "PASS", elapsedMs: Date.now() - started, detail});
  } catch (error) {
    steps.push({name, result: "FAIL", detail: redact(error)});
    throw error;
  }
}

/** A PATH directory holding only the named host tools, so a test host looks bare. */
async function hostPath(name, tools, extra = {}) {
  const directory = resolve(root, name);
  await mkdir(directory, {recursive: true});
  for (const tool of tools) await symlink(which(tool), resolve(directory, tool));
  for (const [tool, body] of Object.entries(extra)) await writeFile(resolve(directory, tool), body, {mode: 0o755});
  return directory;
}

function startStack(path) {
  // The repository root may carry a developer .env; this journey needs none.
  return spawnSync(which("bash"), ["scripts/start-stack.sh", "--mode", "local", "--no-build"], {
    env: {PATH: path, HOME: root}, encoding: "utf8", timeout: 30_000,
  });
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
const slug = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replaceAll(" ", "-");

async function assertAnchor(file, anchor) {
  const headings = (await readFile(file, "utf8")).split("\n").filter((line) => /^#{1,6} /.test(line))
    .map((line) => slug(line.replace(/^#+ /, "")));
  assert.ok(headings.includes(anchor), `${file}#${anchor} does not match a heading`);
}

/** Start one product service and wait for the line that names its address. */
async function startService(name, script, env, pattern) {
  const child = spawn(process.execPath, [script], {stdio: ["ignore", "pipe", "pipe"], env});
  const service = {name, child, stdout: "", stderr: ""};
  services.push(service);
  child.stdout.on("data", (chunk) => { service.stdout += chunk; });
  child.stderr.on("data", (chunk) => { service.stderr += chunk; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const origin = (service.stdout + service.stderr).match(pattern)?.[1];
    if (origin) return {...service, origin};
    if (child.exitCode !== null) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`${name} did not start: ${redact(service.stderr.slice(-2000))}`);
}

try {
  await mkdir(root, {recursive: true});
  const shellTools = ["bash", "dirname", "uname"];

  await step("1. 裸主机运行源码启动脚本：一次列出全部缺失依赖及修复办法", async () => {
    const result = startStack(await hostPath("bare", shellTools));
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /Starting the sandbox runner/);
    assert.match(result.stderr, /cannot start from source: 5 host dependency problem\(s\)/);
    for (const command of ["node", "pnpm", "python3", "uv", "curl"]) {
      assert.match(result.stderr, new RegExp(`no '${command}' is on PATH`));
    }
    // Every headline is followed by at least one indented remedy line.
    const problems = result.stderr.split("\n  - ").slice(1);
    assert.equal(problems.length, 5);
    for (const problem of problems) assert.match(problem, /\n {4}\S/);
    assert.ok(result.stderr.split("\n").length <= 30, "the report fits on one terminal screen");
    return {exit: result.status, report: result.stderr};
  });

  await step("2. 只装了旧版 Node：报告写出发现的版本和升级办法", async () => {
    const oldNode = '#!/bin/sh\ncase "$1" in --version) echo v20.11.0 ;; *) exit 1 ;; esac\n';
    const result = startStack(await hostPath("old-node", shellTools, {node: oldNode}));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Node\.js 22\.19\+ is required; found v20\.11\.0\.\n {4}Upgrade it/);
    assert.doesNotMatch(result.stderr, /no 'node' is on PATH/);
    return {exit: result.status, node: result.stderr.match(/Node\.js 22\.19\+ is required; found [^\n]+/)?.[0]};
  });

  await step("3. 报告与 Runner 提示里的文档链接都指向覆盖该依赖的章节", async () => {
    const report = startStack(resolve(root, "bare")).stderr;
    const links = [...report.matchAll(/^ {2}[A-Za-z ]+: +(\S+)#(\S+)$/gm)].map((match) => [match[1], match[2]]);
    assert.deepEqual(links.map(([file]) => file), ["README.md", "docs/en/getting-started/deployment.md"]);
    for (const [file, anchor] of links) await assertAnchor(file, anchor);
    const row = (await readFile("README.md", "utf8")).split("\n").find((line) => line.startsWith("| **Local source mode**"));
    for (const named of ["Node.js", "pnpm", "Python 3", "uv", "curl", "Bubblewrap"]) assert.ok(row.includes(named), named);
    const guide = await readFile("docs/en/getting-started/deployment.md", "utf8");
    const section = guide.slice(guide.indexOf("## Local source mode"), guide.indexOf("### Clone and start"));
    for (const named of ["Node.js", "pnpm", "python3", "uv", "curl", "Bubblewrap", "Seatbelt"]) assert.ok(section.includes(named), named);
    for (const anchor of ["linux-reports-missing-bwrap", "macos-reports-seatbelt-is-unavailable"]) {
      await assertAnchor("docs/en/getting-started/deployment.md", anchor);
    }
    return {links: links.map((link) => link.join("#"))};
  });

  let runner;
  await step("4. 没有 bubblewrap 时启动 Runner：终端直接给出包名、bwrap 与安装命令", async () => {
    // The tools are present now; only bwrap is missing from PATH, as start-stack runs it.
    const path = await hostPath("no-bwrap", ["bash", "python3"]);
    runner = await startService("runner", "services/runner/dist/server.js", {
      PATH: path, HOME: root, TMPDIR: root,
      SCIENCE_AGENT_DATA_DIR: resolve(root, "data"), SCIENCE_AGENT_BWRAP_PATH: "bwrap",
      SCIENCE_AGENT_SANDBOX_PROVIDER: "bubblewrap", SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1",
      SCIENCE_AGENT_RUNNER_PORT: "0", SCIENCE_AGENT_RUNNER_TOKEN: runnerToken,
      SCIENTIFIC_ENVS: "0", SCIENCE_AGENT_NPU_BROKER: "0",
    }, /runner listening on (http:\/\/127\.0\.0\.1:\d+)/);
    const terminal = services.find((service) => service.name === "runner").stderr;
    assert.match(terminal, /bubblewrap is not available: "bwrap" could not be started \(spawn bwrap ENOENT\)\./);
    assert.match(terminal, /Install the bubblewrap package, which provides the bwrap executable: sudo apt-get install -y bubblewrap/);
    assert.match(terminal, /Details: docs\/en\/getting-started\/deployment\.md#linux-reports-missing-bwrap/);
    const response = await fetch(runner.origin + "/execution-capability", {headers: {authorization: "Bearer " + runnerToken}});
    assert.equal(response.status, 200);
    const capability = await response.json();
    assert.equal(capability.reason, "dependency-unavailable");
    assert.ok(terminal.includes(capability.detail), "the terminal and the capability report say the same thing");
    return {terminal: redact(terminal.trim()), reason: capability.reason};
  });

  await step("5. Web 界面读取的执行就绪信息同样带有修复办法", async () => {
    const api = await startService("api", "services/api/dist/server.js", {
      PATH: process.env.PATH, HOME: root, TMPDIR: root,
      SCIENCE_AGENT_DATA_DIR: resolve(root, "data"), SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: "0",
      SCIENCE_AGENT_AUTH_TOKEN: apiToken, SCIENCE_AGENT_RUNNER_URL: runner.origin, SCIENCE_AGENT_RUNNER_TOKEN: runnerToken,
      // Keep the sidecars on a closed port so the journey never reaches another stack.
      SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:9", SCIENCE_AGENT_EVOLVE_URL: "http://127.0.0.1:9",
    }, /ScienceDiscovery listening on (http:\/\/127\.0\.0\.1:\d+)/);
    // The Settings "Execution readiness" card renders capability.detail from this endpoint.
    const response = await fetch(api.origin + "/api/runners/local/execution-capability", {
      method: "POST", headers: {authorization: "Bearer " + apiToken},
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.connected, true);
    assert.equal(body.capability.ready, false);
    assert.match(body.capability.detail, /bubblewrap package, which provides the bwrap executable/);
    assert.match(body.capability.detail, /#linux-reports-missing-bwrap/);
    return {connected: body.connected, reason: body.capability.reason, detailLines: body.capability.detail.split("\n").length};
  });
} catch (error) {
  process.exitCode = 1;
  console.error(redact(error));
} finally {
  for (const service of services.reverse()) {
    if (service.child.exitCode === null && service.child.signalCode === null) {
      const exited = once(service.child, "exit");
      service.child.kill("SIGTERM");
      await exited;
    }
  }
  await writeFile(resolve(root, "report.md"), "# Source-start dependency journey\n\nSHA: " + sha + "\nDirty: " + dirty + "\n\n"
    + steps.map((item) => "- " + item.result + " " + item.name + "\n\n```text\n" + redact(JSON.stringify(item.detail, null, 2)) + "\n```").join("\n\n") + "\n");
  await rm(resolve(root, "data"), {recursive: true, force: true});
  console.log(JSON.stringify({passed: steps.filter((item) => item.result === "PASS").length, total: steps.length, report: redact(resolve(root, "report.md"))}));
}
