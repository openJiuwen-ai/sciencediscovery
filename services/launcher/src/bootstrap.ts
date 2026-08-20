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

/**
 * First-launch dependency bootstrap for the single-file binary.
 *
 * A format-version-2 payload does not embed the gateway's Python dependency
 * tree. Before the stack starts, the launcher restores it into the persistent
 * data directory:
 *
 *   1. uv — downloaded as a pinned PyPI wheel from a configurable package
 *      index (Huawei Cloud mirror by default), sha256-verified against the
 *      pin recorded at build time, binary extracted with the bundled CPython.
 *   2. The gateway environment — a uv-managed venv on the bundled CPython,
 *      installed from the hash-pinned requirements export of
 *      services/gateway/uv.lock. The export carries exact versions and
 *      sha256 hashes but no index URLs, so the mirror configuration applies
 *      while the resolution stays identical to the checked-in lockfile.
 *
 * Every step is idempotent: completion is recorded in a marker whose identity
 * fields are re-checked on the next launch, partial work happens in staging
 * directories that are promoted with an atomic rename, and a directory lock
 * serializes concurrent `serve` processes.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { externalUrl } from "@sciencediscovery/external-urls";

import { findExecutable } from "./preflight.js";
import type { PayloadBootstrap, PayloadManifest } from "./payload-manifest.js";

const execFileAsync = promisify(execFile);

/** uv pip output for the full gateway tree is large; do not truncate it. */
const RUN_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 60 * 60_000;
const LOCK_WAIT_TIMEOUT_MS = 60 * 60_000;
const GATEWAY_ENV_MARKER_FILE = ".science-agent-bootstrap.json";

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Injectable process/network seams so tests never touch real endpoints. */
export interface BootstrapIo {
  fetch: typeof fetch;
  findExecutable: (command: string) => Promise<string | undefined>;
  log: (message: string) => void;
  run: (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
  ) => Promise<RunResult>;
}

/** Exact process context shared with the real gateway service definition. */
export interface GatewayProbeRuntime {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

async function defaultRun(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      maxBuffer: RUN_MAX_BUFFER_BYTES,
      timeout: options.timeoutMs,
    });
  } catch (error) {
    const detail = error as NodeJS.ErrnoException & { stderr?: string };
    const stderr = detail.stderr?.toString().trim();
    throw new Error(
      `${basename(command)} ${args[0] ?? ""} failed: ${detail.message.split("\n")[0]}${stderr ? `\n${stderr}` : ""}`,
    );
  }
}

export function defaultBootstrapIo(log: (message: string) => void): BootstrapIo {
  return { fetch: globalThis.fetch, findExecutable, log, run: defaultRun };
}

export interface BootstrapSettings {
  dataDir: string;
  /** Package index used for the gateway dependency installation. */
  pypiIndex: string;
  /** Package index the uv wheel itself is downloaded from. */
  uvInstallIndex: string;
  /** Operator-provided uv binary; skips the wheel download entirely. */
  uvPathOverride?: string;
}

/**
 * Resolve the bootstrap configuration. Environment variables take precedence;
 * the default package index comes from the repository's external URL authority
 * (config/external-urls.json), so the Huawei Cloud mirror default is
 * maintained in one place.
 */
export function resolveBootstrapSettings(
  env: NodeJS.ProcessEnv,
  dataDir: string,
): BootstrapSettings {
  const pypiIndex = env.SCIENCE_AGENT_PYPI_INDEX?.trim() || externalUrl("bootstrap.pypi_index");
  return {
    dataDir,
    pypiIndex,
    uvInstallIndex: env.SCIENCE_AGENT_UV_INSTALL_INDEX?.trim() || pypiIndex,
    uvPathOverride: env.SCIENCE_AGENT_UV_PATH?.trim() || undefined,
  };
}

const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** A fresh per-step staging directory beneath the data directory. */
async function createStaging(dataDir: string, step: string): Promise<string> {
  const staging = join(dataDir, ".bootstrap-staging", `${step}.${process.pid}`);
  await rm(staging, { force: true, recursive: true });
  await mkdir(staging, { recursive: true });
  return staging;
}

/**
 * Resolve a PEP 503 simple-index project page and return the download URL of
 * one exact wheel file. Mirrors lay out their artifact storage differently,
 * so the URL always comes from the page rather than a hard-coded pattern.
 */
export async function findWheelUrl(
  io: BootstrapIo,
  indexUrl: string,
  project: string,
  filename: string,
): Promise<string> {
  const pageUrl = `${indexUrl.replace(/\/+$/, "")}/${project}/`;
  const response = await io.fetch(pageUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`The package index returned ${response.status} for ${pageUrl}`);
  }
  const html = await response.text();
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const href = (match[1] as string).replace(/&amp;/g, "&");
    let resolved: URL;
    try {
      resolved = new URL(href, response.url || pageUrl);
    } catch {
      continue;
    }
    resolved.hash = "";
    if (decodeURIComponent(resolved.pathname).endsWith(`/${filename}`)) return resolved.toString();
  }
  throw new Error(`${pageUrl} does not list ${filename}; the index may be incomplete or out of date.`);
}

async function downloadVerified(
  io: BootstrapIo,
  url: string,
  destination: string,
  expectedSha256: string,
): Promise<void> {
  const response = await io.fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256Hex(bytes);
  if (digest !== expectedSha256) {
    throw new Error(`Checksum mismatch for ${url}: expected sha256 ${expectedSha256}, got ${digest}`);
  }
  await writeFile(destination, bytes);
}

/**
 * Install the pinned uv binary into the data directory, or return the one
 * already installed there. The wheel comes from the configured index and is
 * verified against the sha256 the packaging script pinned, then the binary
 * is pulled out of the wheel with the bundled interpreter — a wheel is a zip
 * archive, and the payload's CPython is always present.
 */
export async function ensureUv(
  io: BootstrapIo,
  settings: BootstrapSettings,
  bootstrap: PayloadBootstrap,
  pythonBinary: string,
): Promise<string> {
  if (settings.uvPathOverride) {
    const override = await io.findExecutable(settings.uvPathOverride);
    if (!override) {
      throw new Error(`SCIENCE_AGENT_UV_PATH points at ${settings.uvPathOverride}, which is not executable.`);
    }
    return override;
  }

  const { project, version, wheelFilename, wheelSha256 } = bootstrap.uv;
  const target = join(settings.dataDir, "tools", "uv", version, "uv");
  if (await isExecutableFile(target)) return target;

  io.log(`Installing uv ${version} from ${settings.uvInstallIndex} (first run only)...`);
  const staging = await createStaging(settings.dataDir, "uv");
  try {
    let wheelUrl: string;
    try {
      wheelUrl = await findWheelUrl(io, settings.uvInstallIndex, project, wheelFilename);
      await downloadVerified(io, wheelUrl, join(staging, wheelFilename), wheelSha256);
    } catch (error) {
      throw new Error(
        `Could not download uv ${version} from ${settings.uvInstallIndex}: `
        + `${error instanceof Error ? error.message : error}\n`
        + "Set SCIENCE_AGENT_UV_INSTALL_INDEX (or SCIENCE_AGENT_PYPI_INDEX) to a reachable PyPI mirror, "
        + "or point SCIENCE_AGENT_UV_PATH at an existing uv executable.",
      );
    }

    const unpacked = join(staging, "unpacked");
    await io.run(pythonBinary, ["-m", "zipfile", "-e", join(staging, wheelFilename), unpacked]);
    // Wheel data scripts carry the binary; zip extraction drops the mode bit.
    const binary = join(unpacked, `${project}-${version}.data`, "scripts", "uv");
    if (!(await stat(binary).then((entry) => entry.isFile(), () => false))) {
      throw new Error(`${wheelFilename} does not contain the expected uv binary under ${project}-${version}.data/scripts/.`);
    }
    await chmod(binary, 0o755);
    await mkdir(dirname(target), { recursive: true });
    await rename(binary, target);
    return target;
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

interface GatewayEnvironmentMarker {
  gatewayWheel: string;
  payloadRoot: string;
  pythonVersion: string;
  requirementsSha256: string;
  /** Comma-joined module names the fast path probes for availability. */
  sentinels: string;
  uvVersion: string;
}

/**
 * Modules imported before the marker fast path is trusted.
 *
 * One module per install step: `mcp` proves the hash-checked third-party
 * install landed, and a bundled stdio server proves the gateway wheel did.
 * The names are fixed here rather than read from the manifest on purpose: an
 * already-extracted payload from an older release records the retired HTTP
 * entry point, and probing that would fail forever and rebuild on every launch.
 */
function gatewaySentinelModules(): string[] {
  return ["mcp", "science_agent_gateway.uniprot_mcp"];
}

/** Fixed probe program; module names travel as argv, never interpolated. */
const SENTINEL_PROBE = [
  "import importlib, sys",
  "for module in sys.argv[1:]:",
  "    importlib.import_module(module)",
].join("\n");

/** Returns undefined when every sentinel resolves, else a failure summary. */
async function probeSentinels(
  io: BootstrapIo,
  venvPython: string,
  modules: string[],
  runtime: GatewayProbeRuntime,
): Promise<string | undefined> {
  // The gateway module comes from the signed payload manifest. It still ends
  // up on an interpreter command line, so accept Python identifiers only.
  if (modules.length === 0 || modules.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(name))) {
    return `unusable sentinel list ${JSON.stringify(modules)}`;
  }
  try {
    await io.run(venvPython, ["-I", "-c", SENTINEL_PROBE, ...modules], runtime);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function gatewayEnvironmentBackup(dataDir: string): string {
  return join(dataDir, ".bootstrap-staging", "gateway-env-backup");
}

/** Finish or roll back an interrupted directory swap from a previous launch. */
async function recoverGatewayEnvironmentBackup(target: string, dataDir: string): Promise<void> {
  const backup = gatewayEnvironmentBackup(dataDir);
  if (!(await pathExists(backup))) return;
  if (await pathExists(target)) {
    await rm(backup, { force: true, recursive: true });
  } else {
    await mkdir(dirname(target), { recursive: true });
    await rename(backup, target);
  }
}

/** Replace a directory using same-filesystem renames and restore on failure. */
async function replaceDirectory(staging: string, target: string, dataDir: string): Promise<void> {
  const backup = gatewayEnvironmentBackup(dataDir);
  await recoverGatewayEnvironmentBackup(target, dataDir);
  await mkdir(dirname(target), { recursive: true });
  let movedExisting = false;
  try {
    if (await pathExists(target)) {
      await rename(target, backup);
      movedExisting = true;
    }
    await rename(staging, target);
  } catch (error) {
    if (movedExisting && !(await pathExists(target))) {
      try {
        await rename(backup, target);
      } catch (restoreError) {
        throw new Error(
          `Could not promote the rebuilt gateway environment and could not restore the previous one: `
          + `${error instanceof Error ? error.message : error}; restore failed: `
          + `${restoreError instanceof Error ? restoreError.message : restoreError}`,
        );
      }
    }
    throw error;
  }
  if (movedExisting) await rm(backup, { force: true, recursive: true });
}

/**
 * Provision the gateway venv from the hash-pinned requirements export. The
 * venv is keyed to the payload (its base interpreter lives inside the payload
 * cache, which changes per release) and to the exact inputs; any mismatch
 * rebuilds the environment rather than starting the gateway against stale
 * dependencies.
 */
export async function ensureGatewayEnvironment(
  io: BootstrapIo,
  settings: BootstrapSettings,
  bootstrap: PayloadBootstrap,
  payloadRoot: string,
  manifest: PayloadManifest,
  uvBinary: string,
  gatewayRuntime: GatewayProbeRuntime,
): Promise<string> {
  const environmentDir = join(settings.dataDir, "envs", "gateway");
  const markerPath = join(environmentDir, GATEWAY_ENV_MARKER_FILE);
  const venvPython = join(environmentDir, "bin", "python");
  const requirementsPath = join(payloadRoot, bootstrap.requirementsPath);
  const gatewayWheelPath = join(payloadRoot, bootstrap.gatewayWheelPath);
  const sentinels = gatewaySentinelModules();
  await recoverGatewayEnvironmentBackup(environmentDir, settings.dataDir);

  const expected: GatewayEnvironmentMarker = {
    gatewayWheel: basename(gatewayWheelPath),
    payloadRoot,
    pythonVersion: manifest.python.version,
    requirementsSha256: await fileSha256(requirementsPath),
    sentinels: sentinels.join(","),
    uvVersion: bootstrap.uv.version,
  };
  const marker = await readJson<GatewayEnvironmentMarker>(markerPath);
  const markerMatches = Boolean(
    marker
    && (Object.keys(expected) as (keyof GatewayEnvironmentMarker)[]).every((key) => marker[key] === expected[key])
  );
  if (markerMatches && (await isExecutableFile(venvPython))) {
    const probeFailure = await probeSentinels(io, venvPython, sentinels, gatewayRuntime);
    if (!probeFailure) return venvPython;
    io.log(`Gateway environment integrity check failed; rebuilding it (${probeFailure.split("\n")[0]}).`);
  }

  io.log(`Provisioning the gateway Python environment in ${environmentDir} (first run only)...`);
  io.log(`Package index: ${settings.pypiIndex}`);
  // Build a relocatable venv beside the live environment. The previous tree
  // remains recoverable until a fully installed and import-probed replacement
  // is ready for same-filesystem rename promotion.
  const staging = await createStaging(settings.dataDir, "gateway-env");
  const stagingPython = join(staging, "bin", "python");
  const uvEnvironment: NodeJS.ProcessEnv = { ...process.env, UV_PYTHON_DOWNLOADS: "never" };
  const pythonBinary = join(payloadRoot, manifest.python.path);
  try {
    await io.run(uvBinary, ["venv", staging, "--python", pythonBinary, "--relocatable"], { env: uvEnvironment });
    // --require-hashes makes the mirror prove it serves the exact artifacts
    // the lockfile resolved; versions cannot drift and content cannot differ.
    await io.run(
      uvBinary,
      [
        "pip", "install",
        "--python", stagingPython,
        "--require-hashes",
        "--index-url", settings.pypiIndex,
        "--requirements", requirementsPath,
      ],
      { env: uvEnvironment, timeoutMs: INSTALL_TIMEOUT_MS },
    );
    // The gateway wheel is our own code from the payload; --no-deps keeps every
    // third-party package under the hash-checked install above.
    await io.run(
      uvBinary,
      [
        "pip", "install",
        "--python", stagingPython,
        "--no-deps",
        "--index-url", settings.pypiIndex,
        gatewayWheelPath,
      ],
      { env: uvEnvironment, timeoutMs: INSTALL_TIMEOUT_MS },
    );
    const probeFailure = await probeSentinels(io, stagingPython, sentinels, gatewayRuntime);
    if (probeFailure) throw new Error(`the rebuilt environment failed its import probe: ${probeFailure}`);
    await writeFile(join(staging, GATEWAY_ENV_MARKER_FILE), `${JSON.stringify(expected, null, 2)}\n`);
    await replaceDirectory(staging, environmentDir, settings.dataDir);
  } catch (error) {
    throw new Error(
      `Provisioning the gateway environment failed: ${error instanceof Error ? error.message : error}\n`
      + `Package index: ${settings.pypiIndex} (override with SCIENCE_AGENT_PYPI_INDEX).\n`
      + "Re-run serve to resume; already-downloaded packages are cached.",
    );
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
  return venvPython;
}

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Serialize bootstrap work across concurrent `serve` processes with a lock
 * directory. `mkdir` is atomic, a dead holder is detected through its
 * recorded pid, and waiters re-check the completion markers after acquiring.
 */
export async function withBootstrapLock<T>(
  dataDir: string,
  io: BootstrapIo,
  action: () => Promise<T>,
): Promise<T> {
  const lockDir = join(dataDir, ".bootstrap.lock");
  const pidFile = join(lockDir, "pid");
  const started = Date.now();
  let announced = false;
  for (;;) {
    try {
      await mkdir(lockDir);
      await writeFile(pidFile, String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number.parseInt((await readFile(pidFile, "utf8").catch(() => "")).trim(), 10);
      if (Number.isInteger(holder) && holder > 0 && !processAlive(holder)) {
        await rm(lockDir, { force: true, recursive: true });
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for the bootstrap lock ${lockDir}. If no other ScienceDiscovery process is running, remove that directory and retry.`,
        );
      }
      if (!announced) {
        io.log("Waiting for another ScienceDiscovery process to finish first-launch setup...");
        announced = true;
      }
      await sleep(1000);
    }
  }
  try {
    return await action();
  } finally {
    await rm(lockDir, { force: true, recursive: true });
  }
}

export interface BootstrapContext {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  gatewayRuntime: GatewayProbeRuntime;
  io?: BootstrapIo;
  log: (message: string) => void;
  manifest: PayloadManifest;
  payloadRoot: string;
}

export interface BootstrapResult {
  /** Interpreter the gateway service must run with. */
  gatewayPython: string;
  uvBinary: string;
}

/** Run the full first-launch bootstrap; a no-op fast path once completed. */
export async function runBootstrap(context: BootstrapContext): Promise<BootstrapResult> {
  const bootstrap = context.manifest.bootstrap;
  if (!bootstrap) throw new Error("runBootstrap requires a payload manifest with a bootstrap section.");
  const io = context.io ?? defaultBootstrapIo(context.log);
  const settings = resolveBootstrapSettings(context.env, context.dataDir);
  const pythonBinary = join(context.payloadRoot, context.manifest.python.path);

  return await withBootstrapLock(context.dataDir, io, async () => {
    const uvBinary = await ensureUv(io, settings, bootstrap, pythonBinary);
    const gatewayPython = await ensureGatewayEnvironment(
      io, settings, bootstrap, context.payloadRoot, context.manifest, uvBinary, context.gatewayRuntime,
    );
    return { gatewayPython, uvBinary };
  });
}
