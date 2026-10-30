// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
//
// [windows-desktop] Cross-platform Node equivalent of start-stack.sh for
// local (host-process) mode.
// Usage: node scripts/start-stack.mjs --mode local [--no-build] [--no-node-build]
//           [--jiuwenswarm | --no-jiuwenswarm]
// The original bash script stays untouched (Linux/macOS and Docker users are
// unaffected). Every platform fork lives in scripts/lib/stack-platform.mjs.
//
// Product contract (mirrors start-stack.sh line by line):
//   start order runner → memory-graph → evolve → JiuwenSwarm → adapter → api
//   an unhealthy runner only warns (the workbench stays usable); any other
//   sidecar failure stops the stack;
//   in local mode the API runs in the foreground and Ctrl-C tears down the
//   whole stack.

import { existsSync } from "node:fs";
import { copyFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  absoluteFromRepository, findHostPython, findOnPath, isMac, isWindows,
  loadDotEnv, portAvailability, portOccupant, spawnService, killTree, venvPython, waitHealthy,
} from "./lib/stack-platform.mjs";
import { cmdStart as jwStart, isUp as jwIsUp, jwConfig, jwEnv, readInstancePorts } from "./jiuwenswarm.mjs";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(scriptDir, "..");
process.chdir(repositoryRoot);

// Python services print to pipes in the OEM codepage by default (GBK on
// zh-CN), which surfaces as mojibake in the shell's stack log. Force UTF-8
// std streams for every Python child spawned under this stack —
// spawnService/jiuwenswarm inherit process.env, so one assignment covers all.
process.env.PYTHONIOENCODING ??= "utf-8";

// Desktop marker. The payload venv's sitecustomize patches subprocess
// defaults (CREATE_NO_WINDOW) only when this is set, so the console-less
// shell launch never flashes cmd windows for jw's many subprocess spawns;
// dev terminals stay untouched.
process.env.SCIENCE_AGENT_DESKTOP ??= "1";

// The desktop UI manages the skill selection (project settings): a run stages — and installs in JiuwenSwarm —
// just what it enabled, and aligns JiuwenSwarm's own on/off switches with that. Server deployments (start-stack.sh)
// keep every installed skill everywhere, switched inside JiuwenSwarm.
process.env.SCIENCE_AGENT_SKILL_SELECTION ??= "desktop";

const say = message => process.stderr.write(`${message}\n`);
const fail = message => { say(message); process.exit(1); };
const stackStarted = Date.now();

// ---------------------------------------------------------------------------
// Argument parsing (same shape and validation as the bash version)

function parseArgs(argv) {
  const options = { mode: "", modeSeen: false, noBuild: false, noNodeBuild: false, backend: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode" || arg.startsWith("--mode=")) {
      if (options.modeSeen) fail("--mode may only be specified once.");
      options.modeSeen = true;
      if (arg === "--mode") {
        index += 1;
        if (index >= argv.length) fail("--mode requires local or docker.");
        options.mode = argv[index];
      } else {
        options.mode = arg.slice("--mode=".length);
      }
    } else if (arg === "--no-build") options.noBuild = true;
    else if (arg === "--no-node-build") options.noNodeBuild = true;
    else if (arg === "--jiuwenswarm") options.backend = "jiuwenswarm";
    else if (arg === "--no-jiuwenswarm") options.backend = "native";
    else if (["-h", "--help"].includes(arg)) { usage(); process.exit(0); }
    else { usage(process.stderr); fail(`Unknown option: ${arg}`); }
  }
  if (!["local", "docker"].includes(options.mode)) {
    usage(process.stderr);
    fail("--mode must be local or docker.");
  }
  return options;
}

function usage(stream = process.stdout) {
  stream.write(`Usage: node scripts/start-stack.mjs --mode local [options]

  --mode local|docker   local: host processes (Windows supported).
                        docker: not supported by this script; use scripts/start-stack.sh.
  --no-build            reuse the last build and Python environments
  --no-node-build       skip pnpm install/build, still sync Python environments
  --jiuwenswarm         run agent turns on JiuwenSwarm (default); needs
                        \`node scripts/jiuwenswarm.mjs setup\` once
  --no-jiuwenswarm      run agent turns on the native loop

Environment mirrors start-stack.sh, notably:
  SCIENCE_DISCOVERY_DATA_DIR / SCIENCE_AGENT_EXECUTOR / SCIENCE_AGENT_PORT /
  SCIENCE_AGENT_RUNNER_PORT / SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS /
  SCIENCE_AGENT_NPM_REGISTRY / SCIENCE_AGENT_PYPI_INDEX
`);
}

const options = parseArgs(process.argv.slice(2));
if (options.mode === "docker") {
  fail("docker mode is not supported by start-stack.mjs; use scripts/start-stack.sh --mode docker.");
}

// [windows-desktop] Packaged mode (the payload tree inside an installed
// package: no pnpm/uv/host Python): skip the source-mode dependency checks
// and bootstrapping, and reuse only the service order/supervision contract
// (single source for the product contract above). The shell injects
// SCIENCE_AGENT_PYTHON_PATH (the bundled interpreter) and unpacks the envs
// on first run.
const packaged = process.env.SCIENCE_AGENT_PACKAGED === "1";
if (packaged) options.noBuild = true;

// ---------------------------------------------------------------------------
// Preparation (the prepare_local equivalent)

await loadDotEnv(join(repositoryRoot, ".env"));

// Executor choice: CLI > SCIENCE_AGENT_EXECUTOR > default jiuwenswarm
const backend = options.backend || process.env.SCIENCE_AGENT_EXECUTOR || "jiuwenswarm";
let useJiuwenswarm;
if (backend === "jiuwenswarm") {
  useJiuwenswarm = true;
  process.env.SCIENCE_AGENT_ADAPTER = "1";
  process.env.SCIENCE_AGENT_EXECUTOR = "jiuwenswarm";
} else if (backend === "native") {
  useJiuwenswarm = false;
  delete process.env.SCIENCE_AGENT_ADAPTER;
  delete process.env.SCIENCE_AGENT_EXECUTOR;
} else {
  fail(`SCIENCE_AGENT_EXECUTOR must be jiuwenswarm or native, got ${backend}.`);
}

// Data-directory variable compatibility
if (process.env.SCIENCE_DISCOVERY_DATA_DIR) {
  if (process.env.SCIENCE_AGENT_DATA_DIR) {
    say("[compat] Both SCIENCE_DISCOVERY_DATA_DIR and SCIENCE_AGENT_DATA_DIR are set; SCIENCE_DISCOVERY_DATA_DIR takes precedence.");
  }
  process.env.SCIENCE_AGENT_DATA_DIR = process.env.SCIENCE_DISCOVERY_DATA_DIR;
} else if (process.env.SCIENCE_AGENT_DATA_DIR) {
  say("[compat] SCIENCE_AGENT_DATA_DIR is deprecated; using its value as SCIENCE_DISCOVERY_DATA_DIR.");
  process.env.SCIENCE_DISCOVERY_DATA_DIR = process.env.SCIENCE_AGENT_DATA_DIR;
}

// Dependency check: collect every problem, report them all at once (same
// semantics as the bash version; curl is no longer required — health checks
// use fetch)
const dependencyProblems = [];
const noteProblem = (headline, ...remedies) =>
  dependencyProblems.push([headline, ...remedies].map(line => `    ${line}`).join("\n"));

if (packaged) {
  // Packaged mode depends only on this process (the shell ships node) and the
  // bundled Python injected by the shell; the pnpm/uv/host discovery chain
  // does not apply (they neither exist nor need to exist on a clean machine).
  const bundled = process.env.SCIENCE_AGENT_PYTHON_PATH;
  if (!bundled || !existsSync(bundled)) {
    fail("SCIENCE_AGENT_PACKAGED=1 requires SCIENCE_AGENT_PYTHON_PATH to point at the bundled Python interpreter.");
  }
} else {
  const nodeVersion = process.versions.node.split(".").map(Number);
  if (!(nodeVersion[0] > 22 || (nodeVersion[0] === 22 && nodeVersion[1] >= 19))) {
    noteProblem(`Node.js 22.19+ is required; found ${process.versions.node}.`,
      "Upgrade it, for example: nvm install 22 && nvm use 22");
  }
  if (!findOnPath("pnpm")) {
    noteProblem("pnpm 11.1.2 is required to install and build the workspace, but no 'pnpm' is on PATH.",
      "Enable it through the bundled corepack: corepack enable && corepack prepare pnpm@11.1.2 --activate");
  }
  const hostPython = findHostPython();
  if (!hostPython) {
    noteProblem("Python 3 is required for workspace analysis, but no python interpreter was found.",
      isWindows
        ? "Install it from https://www.python.org/downloads/ (the py launcher, python3 or python are all recognised)."
        : "Install your distribution's python3 package (Debian/Ubuntu: sudo apt-get install -y python3).");
  }
  if (!findOnPath("uv")) {
    noteProblem("uv 0.9+ is required to build the Python service environments, but no 'uv' is on PATH.",
      isWindows
        ? "Install it: winget install astral-sh.uv  (or see https://docs.astral.sh/uv/)"
        : "Install it: curl -LsSf https://astral.sh/uv/install.sh | sh");
  }
  if (dependencyProblems.length) {
    process.stderr.write(`ScienceDiscovery cannot start from source: ${dependencyProblems.length} host dependency problem(s).\n\n`);
    for (const problem of dependencyProblems) process.stderr.write(`  - ${problem}\n\n`);
    process.stderr.write("  Requirements table: README.md#requirements\n  Local source mode:  docs/en/how-to/deployment.md#local-mode-host-processes\n");
    process.exit(1);
  }
  process.env.SCIENCE_AGENT_PYTHON_PATH ??= hostPython;
}
if (isMac) process.env.SCIENCE_AGENT_SHELL_PATH ??= "/bin/bash";
else if (isWindows) {
  // [windows-desktop] Windows has no /usr/bin/bash semantics: prefer Git
  // Bash, fall back to cmd. The shell-execution semantics are defined by the
  // executor layer; here we only guarantee the variable has a value.
  process.env.SCIENCE_AGENT_SHELL_PATH ??=
    findOnPath("bash") ?? process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
} else {
  process.env.SCIENCE_AGENT_SHELL_PATH ??= "/usr/bin/bash";
}

// Sandbox provider resolution: Windows runs without one — the runner probes
// its own capability in-process and degrades gracefully (direct execution,
// approval fallback applies), so the startup chain never exits here.
let sandboxProvider = process.env.SCIENCE_AGENT_SANDBOX_PROVIDER ?? "auto";
if (sandboxProvider === "auto") {
  if (isMac) sandboxProvider = "seatbelt";
  else if (isWindows) {
    sandboxProvider = "";
    say("[platform] Windows host: no native sandbox provider; the runner will report its capability and degrade gracefully (direct execution, approval fallback applies).");
  } else sandboxProvider = "bubblewrap";
}
if (!["", "bubblewrap", "seatbelt"].includes(sandboxProvider)) {
  fail("SCIENCE_AGENT_SANDBOX_PROVIDER must be auto, bubblewrap, or seatbelt.");
}

// Data-directory resolution + one-time migration of a legacy data/ tree
const dataDir = absoluteFromRepository(repositoryRoot, process.env.SCIENCE_DISCOVERY_DATA_DIR ?? ".sciencediscovery-data");
if (!process.env.SCIENCE_DISCOVERY_DATA_DIR) {
  const legacy = join(repositoryRoot, "data");
  if (existsSync(legacy)) {
    if (existsSync(dataDir)) {
      say(`[compat] Skipped moving legacy data directory ${legacy} to ${dataDir}: target already exists.`);
    } else {
      try {
        await rename(legacy, dataDir);
        say(`[compat] Moved legacy data directory ${legacy} to ${dataDir}.`);
      } catch (error) {
        // On Windows the rename fails while the directory is in use (locked).
        fail(`[compat] Could not move legacy data directory ${legacy}: ${error.message}. Close the programs using it and retry.`);
      }
    }
  }
}
// The shell may tell us to use the read-only payload venvs directly
// instead of copying them into the data directory. The env var is an absolute
// path to the directory that contains the sidecar venvs.
const envsDir = process.env.SCIENCE_AGENT_ENVS_DIR
  ? resolve(process.env.SCIENCE_AGENT_ENVS_DIR)
  : join(dataDir, "envs");

// Build (--no-build skips it). Registry overrides apply to this process only
// and never touch user/global configuration.
const runOpts = { cwd: repositoryRoot };
async function runStep(label, command, args, extraEnv = {}, cwd) {
  say(`==> ${label}`);
  const child = spawnService(command, args, { ...runOpts, ...(cwd ? { cwd } : {}), env: extraEnv });
  const code = await new Promise(resolveExit => child.once("exit", resolveExit));
  if (code !== 0) fail(`${label} failed with exit code ${code}.`);
}

async function uvSyncProject(projectDir, envDir, { locked, extraArgs = [] }) {
  const env = { UV_PROJECT_ENVIRONMENT: envDir };
  if (process.env.SCIENCE_AGENT_PYPI_INDEX) env.UV_DEFAULT_INDEX = process.env.SCIENCE_AGENT_PYPI_INDEX;
  // With a custom PyPI index, --locked always fails (uv.lock records the
  // index URL); back up and restore the lockfile so the mirror never dirties
  // the working tree (same semantics as the bash uv_sync_project). The bash
  // version cds into the project directory in a subshell before syncing
  // (`uv sync` resolves by cwd).
  if (process.env.SCIENCE_AGENT_PYPI_INDEX && locked) {
    const lockfile = join(projectDir, "uv.lock");
    const backup = join(projectDir, "uv.lock.stack-backup");
    // Copy, not rename: a rename parks the lockfile away, so a hard kill
    // outside the finally (power loss, taskkill) would leave the tree without
    // a lockfile at all. With a copy the original stays in place and the
    // backup only ever adds a file. Restoring also copies and unlinks — on
    // Windows a rename onto an existing target fails if uv still holds a
    // handle to the rewritten lockfile, while an overwrite copy degrades
    // gracefully.
    await copyFile(lockfile, backup);
    try {
      await runStep(`uv sync ${projectDir}`, "uv", ["sync", ...extraArgs], env, projectDir);
    } finally {
      await copyFile(backup, lockfile);
      await rm(backup, { force: true });
    }
    return;
  }
  await runStep(`uv sync ${projectDir}`, "uv", ["sync", ...(locked ? ["--locked"] : []), ...extraArgs], env, projectDir);
}

if (!options.noBuild) {
  if (!options.noNodeBuild) {
    const registryArgs = process.env.SCIENCE_AGENT_NPM_REGISTRY ? ["--registry", process.env.SCIENCE_AGENT_NPM_REGISTRY] : [];
    await runStep("pnpm install", "pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", ...registryArgs]);
  }
  await uvSyncProject(join(repositoryRoot, "services", "paper"), join(envsDir, "paper"), { locked: true });
  // Pinned to Python 3.12 via services/gateway/.python-version.
  await uvSyncProject(join(repositoryRoot, "services", "gateway"), join(envsDir, "gateway"), { locked: false });
  if (!options.noNodeBuild) {
    await runStep("pnpm build", "pnpm", ["build"]);
    if (!isWindows && !isMac) await runStep("pnpm runner:binary", "pnpm", ["runner:binary"]);
  }
}

// Gateway interpreter discovery: two known locations, in the same order as
// resolveMcpPython; venvPython() handles bin/python vs Scripts/python.exe
// internally.
let gatewayPython = process.env.SCIENCE_AGENT_GATEWAY_PYTHON_PATH;
if (!gatewayPython || !existsSync(gatewayPython)) {
  const candidates = [venvPython(join(envsDir, "gateway")), venvPython(join(repositoryRoot, "services", "gateway", ".venv"))];
  gatewayPython = candidates.find(existsSync);
}
if (!gatewayPython) {
  fail(packaged
    ? `${join(envsDir, "gateway")} is missing; the packaged installation is incomplete — reinstall ScienceDiscovery.`
    : `${join(envsDir, "gateway")} is missing (needed for the bundled Python MCP servers). Run without --no-build once to provision it.`);
}

// memory-graph: provision unconditionally (the feature toggle lives in
// System Settings; the environment must be ready)
let memoryGraphPython = venvPython(join(envsDir, "memory-graph"));
if (!existsSync(memoryGraphPython)) {
  if (packaged) fail(`${join(envsDir, "memory-graph")} is missing; the packaged installation is incomplete — reinstall ScienceDiscovery.`);
  say("Provisioning the memory-graph Python environment...");
  await uvSyncProject(join(repositoryRoot, "services", "memory-graph"), join(envsDir, "memory-graph"), { locked: false });
}
if (!existsSync(memoryGraphPython)) memoryGraphPython = "";

// evolve: --extra candidates installs the candidate runtimes (the AST gate
// admits pandas/numpy/scipy/sklearn)
let evolvePython = venvPython(join(envsDir, "evolve"));
if (!existsSync(evolvePython)) {
  if (packaged) fail(`${join(envsDir, "evolve")} is missing; the packaged installation is incomplete — reinstall ScienceDiscovery.`);
  say("Provisioning the evolve Python environment...");
  const extraArgs = process.env.SCIENCE_AGENT_EVOLVE_STUB_ONLY === "1" ? [] : ["--extra", "candidates"];
  await uvSyncProject(join(repositoryRoot, "services", "evolve"), join(envsDir, "evolve"), { locked: false, extraArgs });
}
if (!existsSync(evolvePython)) evolvePython = "";

// adapter: the JiuwenSwarm front door (on by default)
let adapterPython = "";
if (process.env.SCIENCE_AGENT_ADAPTER === "1") {
  adapterPython = venvPython(join(envsDir, "adapter"));
  if (!existsSync(adapterPython)) {
    if (packaged) fail(`${join(envsDir, "adapter")} is missing; the packaged installation is incomplete — reinstall ScienceDiscovery.`);
    say("Provisioning the adapter Python environment...");
    await uvSyncProject(join(repositoryRoot, "services", "adapter"), join(envsDir, "adapter"), { locked: false });
  }
  if (!existsSync(adapterPython)) adapterPython = "";
}

// Runner environment assembly: every *_PATH/*_DIR passthrough is rewritten to
// a repository-absolute path (absoluteFromRepository recognises C:\ and UNC).
const runnerEnv = {
  SCIENCE_AGENT_BWRAP_PATH: process.env.SCIENCE_AGENT_BWRAP_PATH ?? "bwrap",
  ...(sandboxProvider ? { SCIENCE_AGENT_SANDBOX_PROVIDER: sandboxProvider } : {}),
  SCIENCE_AGENT_SEATBELT_PATH: process.env.SCIENCE_AGENT_SEATBELT_PATH ?? "/usr/bin/sandbox-exec",
  SCIENCE_AGENT_PYTHON_PATH: process.env.SCIENCE_AGENT_PYTHON_PATH,
  SCIENCE_AGENT_DATA_DIR: dataDir,
  SCIENCE_AGENT_RUNNER_HOST: process.env.SCIENCE_AGENT_RUNNER_HOST ?? "127.0.0.1",
  SCIENCE_AGENT_RUNNER_PORT: process.env.SCIENCE_AGENT_RUNNER_PORT ?? "4311",
  SCIENCE_AGENT_RUNNER_TOKEN: process.env.SCIENCE_AGENT_RUNNER_TOKEN ?? "sciencediscovery-runner-local",
  SCIENTIFIC_ENVS: "1",
};
for (const name of [
  "SCIENCE_AGENT_PROVISIONER_PATH", "SCIENCE_AGENT_PACKAGE_CACHE_DIR",
  "SCIENCE_AGENT_SCIENTIFIC_CHANNELS", "SCIENCE_AGENT_KERNEL_IDLE_MS",
  "SCIENCE_AGENT_EXEC_TIMEOUT_MS", "SCIENCE_AGENT_NPU_BROKER",
  "SCIENCE_AGENT_NPU_WORKLOAD_CONFIG", "SCIENCE_AGENT_NPU_PYTHON",
  "SCIENCE_AGENT_NPU_SMOKE_SCRIPT", "SCIENCE_AGENT_NPU_PROTENIX_SCRIPT",
]) {
  if (process.env[name]) {
    runnerEnv[name] = name.endsWith("_PATH") || name.endsWith("_DIR")
      ? absoluteFromRepository(repositoryRoot, process.env[name])
      : process.env[name];
  }
}

// pnpm api runs with the service directory as cwd, so these two resolutions
// must be given explicitly
process.env.SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH =
  absoluteFromRepository(repositoryRoot, process.env.SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH ?? "extensions_config.json");
process.env.SCIENCE_AGENT_GATEWAY_PYTHON_PATH ??= gatewayPython;

// ---------------------------------------------------------------------------
// Port pre-flight: the Windows reserved ranges' EACCES must surface before
// anything is spawned, with the remedy attached

const runnerHost = runnerEnv.SCIENCE_AGENT_RUNNER_HOST;
const runnerPort = Number(runnerEnv.SCIENCE_AGENT_RUNNER_PORT);
const publicPort = Number(process.env.SCIENCE_AGENT_PORT ?? 4310);
const legacyPort = Number(process.env.SCIENCE_AGENT_LEGACY_PORT ?? publicPort + 100);
const memoryGraphPort = Number(process.env.SCIENCE_AGENT_MEMORY_GRAPH_PORT ?? 17674);
const evolvePort = Number(process.env.SCIENCE_AGENT_EVOLVE_PORT ?? 4313);

// The shell's port-epoch system may shift the memory-graph port; the
// API's client is URL-driven, so the URL must follow the port unless an
// operator pinned it explicitly (prevents a PORT/URL desync foot-gun).
process.env.SCIENCE_AGENT_MEMORY_GRAPH_URL ??= `http://127.0.0.1:${memoryGraphPort}`;

// Allow JiuwenSwarm to start in the background so the control API can be
// ready earlier. The adapter still needs JiuwenSwarm, so it starts
// after JiuwenSwarm is up.
const lazyJiuwen = process.env.SCIENCE_AGENT_LAZY_JIUWEN === "1";

const portsToCheck = [
  { name: "runner", host: runnerHost, port: runnerPort },
  { name: "api", host: "127.0.0.1", port: useJiuwenswarm ? legacyPort : publicPort },
  ...(useJiuwenswarm ? [{ name: "adapter", host: "127.0.0.1", port: publicPort }] : []),
  ...(process.env.SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE !== "0" && memoryGraphPython
    ? [{ name: "memory-graph", host: "127.0.0.1", port: memoryGraphPort }] : []),
  ...(evolvePython ? [{ name: "evolve", host: "127.0.0.1", port: evolvePort }] : []),
];
const portFailures = [];
for (const { name, host, port } of portsToCheck) {
  const result = await portAvailability(host, port);
  if (!result.ok) portFailures.push({ name, host, port, code: result.code });
}
if (portFailures.length) {
  say("Cannot bind the ports this stack needs:");
  for (const { name, host, port, code } of portFailures) {
    if (code === "EADDRINUSE") {
      // Name the occupant so a tester can act on the spot instead of
      // running netstat by hand (dead end from a console-less install).
      const who = portOccupant(port);
      say(`  - ${name} ${host}:${port} — occupied by ${who ?? "another process"}.`);
    } else if (code === "EACCES") {
      say(`  - ${name} ${host}:${port} — reserved by Windows (Hyper-V/WSL dynamic exclusion range): netsh interface ipv4 show excludedportrange protocol=tcp; pick a port outside them via the matching SCIENCE_AGENT_*_PORT.`);
    } else {
      say(`  - ${name} ${host}:${port} — unavailable (${code}).`);
    }
  }
  say("Close the occupying program(s) (or exit the other ScienceDiscovery from its tray icon), then retry / 请关闭占用端口的程序（或退出托盘里已有的 ScienceDiscovery）后重试。");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Spawn phase (the start_stack equivalent: order and supervision semantics
// are the product contract)

const children = [];
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const child of children.splice(0)) killTree(child);
}
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });
process.on("exit", cleanup);

const healthTimeoutSeconds = Number(process.env.SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS ?? 20);
const runnerUrl = process.env.SCIENCE_AGENT_RUNNER_URL ?? `http://${runnerHost}:${runnerPort}`;

try {
  say("Starting the sandbox runner daemon...");
  children.push(spawnService(process.execPath, [join("services", "runner", "dist", "server.js")], { env: runnerEnv }));
  if (!await waitHealthy("runner", `${runnerUrl}/health`, { timeoutSeconds: healthTimeoutSeconds })) {
    say("WARNING: local compute is unavailable; the workbench will remain accessible. Configure a remote Runner or repair local execution.");
  }

  // [windows-desktop] Service start-order optimization: sidecars/JiuwenSwarm
  // and the control API start in parallel instead of the API waiting for
  // every sidecar to become healthy, which compresses the wizard's "local
  // API service" self-check from minutes to seconds.
  if (useJiuwenswarm && !adapterPython) {
    fail("SCIENCE_AGENT_EXECUTOR=jiuwenswarm needs the adapter: also set SCIENCE_AGENT_ADAPTER=1.");
  }

  // The adapter's Settings.from_env refuses SCIENCE_AGENT_EXECUTOR=jiuwenswarm
  // unless the override opt-in is present: this launcher owns the JiuwenSwarm
  // endpoints it passes (instance .env ports → JIUWENSWARM_GATEWAY_URL /
  // JIUWENSWARM_MGMT_URL), mirroring services/launcher/src/jiuwenswarm.ts and
  // scripts/start-stack.sh. Without this the adapter dies at boot with
  // "JiuwenSwarm requires explicit SD-owned endpoints" and the UI front door
  // (public port) never comes up. spawnService inherits process.env, so the
  // assignment covers both the lazy (bootAdapter) and non-lazy startAdapter()
  // paths below.
  if (useJiuwenswarm) process.env.SCIENCE_AGENT_JIUWENSWARM_OVERRIDES = "1";

  // Helper: start the adapter on the public port, proxying to the legacy API.
  // The extra env can be used to inject the dynamic JiuwenSwarm URLs once they
  // are known (lazy start), so the adapter talks to the correct ports.
  let adapterChild = null;
  function startAdapter(extraEnv = {}) {
    say(`Starting the adapter on port ${publicPort} (legacy API on ${legacyPort})...`);
    adapterChild = spawnService(adapterPython, ["-m", "sciencediscovery_adapter.server"], {
      env: { SCIENCE_AGENT_LEGACY_PORT: String(legacyPort), ...extraEnv },
    });
    children.push(adapterChild);
    process.env.SCIENCE_AGENT_ADAPTER_URL ??= `http://127.0.0.1:${publicPort}`;
  }

  // Sidecars: memory-graph and evolve run in the background. The control API
  // does not need them to answer /api/health, so don't block the API on them.
  const sidecarPromises = [];
  if (process.env.SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE !== "0" && memoryGraphPython) {
    sidecarPromises.push((async () => {
      say("Starting the memory-graph service...");
      children.push(spawnService(memoryGraphPython, ["-m", "sciencediscovery_memory_graph.server"], {
        env: {
          SCIENCE_AGENT_DATA_DIR: dataDir,
          SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_HTTP: process.env.SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_HTTP ?? "http://127.0.0.1:7474",
          SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN: process.env.SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN ?? "sciencediscovery-memory-graph-local",
        },
      }));
      if (!await waitHealthy("memory-graph", `http://127.0.0.1:${memoryGraphPort}/health`, { timeoutSeconds: healthTimeoutSeconds })) {
        throw new Error("memory-graph sidecar failed to start; stopping the stack.");
      }
    })());
  }
  if (evolvePython) {
    sidecarPromises.push((async () => {
      say("Starting the evolve service...");
      children.push(spawnService(evolvePython, ["-m", "sciencediscovery_evolve.server"], {
        env: {
          SCIENCE_AGENT_DATA_DIR: dataDir,
          SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN: process.env.SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN ?? "sciencediscovery-evolve-local",
        },
      }));
      if (!await waitHealthy("evolve", `http://127.0.0.1:${evolvePort}/health`, { timeoutSeconds: healthTimeoutSeconds })) {
        throw new Error("evolve sidecar failed to start; stopping the stack.");
      }
    })());
  }

  // JiuwenSwarm: lazy mode starts in the background and does not block the
  // adapter; the adapter can proxy /api/health while JiuwenSwarm is still
  // booting. Use the instance's existing .env ports (or defaults) so the adapter
  // starts immediately with the correct URLs.
  if (useJiuwenswarm) {
    const cfg = jwConfig();
    if (lazyJiuwen) {
      const urlsFromPorts = p => ({
        JIUWENSWARM_GATEWAY_URL: `ws://127.0.0.1:${p.gateway}/tui`,
        JIUWENSWARM_MGMT_URL: `ws://127.0.0.1:${p.web}/ws`,
      });
      const DEFAULT_JW_URLS = urlsFromPorts({ gateway: 19001, web: 19000 });
      const bootAdapter = urls => {
        process.env.JIUWENSWARM_GATEWAY_URL = urls.JIUWENSWARM_GATEWAY_URL;
        process.env.JIUWENSWARM_MGMT_URL = urls.JIUWENSWARM_MGMT_URL;
        if (adapterPython) startAdapter({ ...urls });
      };
      const ports = await readInstancePorts(cfg);
      // A brand-new instance's port group is decided by the init conflict
      // scan (defaults 19000/19001 shift up when occupied, e.g. 20000/20001)
      // and is unknowable before init writes the bootstrap .env. Starting
      // the adapter before that would permanently mis-point it at the wrong
      // ports (first-run chats all hit gateway unreachable). Therefore:
      //   existing instance (.env present) → start immediately with the
      //     .env ports (fast path, behavior unchanged);
      //   brand-new instance → poll the .env in the background and start the
      //     adapter with the real ports as soon as init writes it.
      let jwSideSettled = false;
      (async () => {
        try {
          if (!await jwIsUp(cfg)) {
            say("JiuwenSwarm is not running; starting it in the background (node scripts/jiuwenswarm.mjs start)...");
            await jwStart(cfg);
          }
          const env = await jwEnv(cfg).catch(() => null);
          if (env) Object.assign(process.env, env);
        } catch (error) {
          say(`JiuwenSwarm background start failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          jwSideSettled = true;
        }
      })();
      if (ports) {
        bootAdapter(urlsFromPorts(ports));
      } else {
        (async () => {
          const deadline = Date.now() + 300_000;
          for (;;) {
            const fresh = await readInstancePorts(cfg);
            if (fresh) { bootAdapter(urlsFromPorts(fresh)); break; }
            // JiuwenSwarm already settled (running / started / failed) but the
            // .env is still missing: stop waiting, use the ports from python
            // status, and finally fall back to the default group (no worse
            // than the old behavior).
            if (jwSideSettled || Date.now() >= deadline) {
              const env = await jwEnv(cfg).catch(() => null);
              bootAdapter(env ?? DEFAULT_JW_URLS);
              if (!env) say("WARNING: JiuwenSwarm instance .env not found; the adapter is starting on default ports (web 19000, gateway 19001).");
              break;
            }
            await delay(1000);
          }
        })().catch(error => {
          say(`Adapter deferred start failed: ${error instanceof Error ? error.message : String(error)}`);
          bootAdapter(DEFAULT_JW_URLS);
        });
      }
    } else {
      sidecarPromises.push((async () => {
        if (!process.env.JIUWENSWARM_GATEWAY_URL || !process.env.JIUWENSWARM_MGMT_URL) {
          const env = await jwEnv(cfg).catch(() => null);
          if (env) Object.assign(process.env, env);
        }
        const gatewayPort = Number(new URL(process.env.JIUWENSWARM_GATEWAY_URL ?? "ws://127.0.0.1:0/").port || 0);
        if (!gatewayPort || !await jwIsUp(cfg)) {
          say("JiuwenSwarm is not running; starting it (node scripts/jiuwenswarm.mjs start)...");
          await jwStart(cfg);
          Object.assign(process.env, await jwEnv(cfg));
        }
      })());
    }
  }

  // API: start as soon as the runner is healthy, before sidecars finish.
  process.env.SCIENCE_AGENT_ADAPTER_URL ??= `http://127.0.0.1:${publicPort}`;
  say(`[perf] start-stack pre-API elapsed=${Date.now() - stackStarted}ms`);
  say("Starting the control API...");
  const apiEntry = process.env.SCIENCE_AGENT_API_ENTRYPOINT ?? join(repositoryRoot, "services", "api", "dist", "server.js");
  if (process.env.SCIENCE_AGENT_API_ENTRYPOINT && !existsSync(process.env.SCIENCE_AGENT_API_ENTRYPOINT)) {
    fail("SCIENCE_AGENT_API_ENTRYPOINT requires a local existing module");
  }
  const apiChild = spawnService(process.execPath, [apiEntry], {
    cwd: join(repositoryRoot, "services", "api"),
    env: useJiuwenswarm
      ? { SCIENCE_AGENT_PORT: String(legacyPort), SCIENCE_AGENT_PUBLIC_PORT: String(publicPort) }
      : { SCIENCE_AGENT_PORT: String(publicPort) },
  });
  children.push(apiChild);

  // Adapter: in lazy mode it is started from the JiuwenSwarm background
  // promise once we know the real JiuwenSwarm ports. In non-lazy mode keep
  // the original contract: wait for JiuwenSwarm to be ready before starting
  // the adapter.
  if (useJiuwenswarm && adapterPython && !lazyJiuwen) {
    Promise.all(sidecarPromises).then(() => startAdapter()).catch(() => {});
  }

  // Wait for all sidecars (fail-fast if any required sidecar failed).
  await Promise.all(sidecarPromises);

  // Foreground wait for the API to exit (Ctrl-C goes through the SIGINT
  // handler → cleanup tears down the whole stack)
  const apiExitCode = await new Promise(resolveExit => apiChild.once("exit", resolveExit));
  cleanup();
  process.exit(apiExitCode ?? 0);
} catch (error) {
  cleanup();
  fail(error instanceof Error ? error.message : String(error));
}
