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
 * A format-version-2 payload no longer embeds the gateway's Python dependency
 * tree or any deer-flow content. Before the stack starts, the launcher
 * restores them into the persistent data directory:
 *
 *   1. uv — downloaded as a pinned PyPI wheel from a configurable package
 *      index (Huawei Cloud mirror by default), sha256-verified against the
 *      pin recorded at build time, binary extracted with the bundled CPython.
 *   2. deer-flow — fetched at the exact commit the repository's submodule
 *      gitlink records: the GitCode mirror first, then the canonical GitHub
 *      repository, then a GitHub codeload archive for hosts without git.
 *      Whatever the source, the result is verified (commit SHA or content
 *      tree digest) before it is used; when every source fails, the error
 *      spells out how to place the checkout manually.
 *   3. The gateway environment — a uv-managed venv on the bundled CPython,
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
import { access, chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { promisify } from "node:util";

import { externalUrl, formatExternalUrl } from "@science-agent/external-urls";

import { digestTree } from "./content-digest.js";
import { findExecutable } from "./preflight.js";
import { extractTar } from "./tar-extract.js";
import type { PayloadBootstrap, PayloadManifest } from "./payload-manifest.js";

const execFileAsync = promisify(execFile);

/** uv pip output for the full gateway tree is large; do not truncate it. */
const RUN_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const GIT_FETCH_TIMEOUT_MS = 15 * 60_000;
const INSTALL_TIMEOUT_MS = 60 * 60_000;
const LOCK_WAIT_TIMEOUT_MS = 60 * 60_000;
const DEERFLOW_MARKER_FILE = ".science-agent-deerflow.json";
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
  deerFlowDir: string;
  /** Git URLs in fallback order: mirror first, canonical second. */
  deerFlowGitUrls: string[];
  /** Git-less archive of the pinned commit; the last-resort download. */
  deerFlowArchiveUrl: string;
}

/**
 * Resolve the bootstrap configuration. Environment variables take precedence;
 * the defaults come from the repository's external URL authority
 * (config/external-urls.json), so the Huawei Cloud mirror default and the
 * deer-flow source order are maintained in one place.
 */
export function resolveBootstrapSettings(
  env: NodeJS.ProcessEnv,
  dataDir: string,
  bootstrap: PayloadBootstrap,
): BootstrapSettings {
  const pypiIndex = env.SCIENCE_AGENT_PYPI_INDEX?.trim() || externalUrl("bootstrap.pypi_index");
  const mirror = env.SCIENCE_AGENT_DEERFLOW_GIT_URL?.trim() || externalUrl("bootstrap.deer_flow_git_mirror");
  const canonical = externalUrl("bootstrap.deer_flow_git_canonical");
  return {
    dataDir,
    deerFlowArchiveUrl: formatExternalUrl("bootstrap.deer_flow_archive_template", {
      commit: bootstrap.deerFlow.commit,
    }),
    deerFlowDir: resolve(env.SCIENCE_AGENT_DEERFLOW_DIR?.trim() || join(dataDir, "vendor", "deer-flow")),
    deerFlowGitUrls: mirror === canonical ? [canonical] : [mirror, canonical],
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

async function isNonEmptyDirectory(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isDirectory()) return false;
    return (await readdir(path)).length > 0;
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

interface DeerFlowMarker {
  commit: string;
  source: string;
  treeDigest: string;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function manualPlacementMessage(
  settings: BootstrapSettings,
  bootstrap: PayloadBootstrap,
  attempts: string[],
): string {
  const { commit } = bootstrap.deerFlow;
  return [
    "deer-flow could not be downloaded automatically.",
    "",
    "Attempted sources, in order:",
    ...attempts.map((attempt) => `  - ${attempt}`),
    "",
    `ScienceDiscovery needs deer-flow at exactly commit ${commit}`,
    "(the version this release was built and tested against). To place it manually:",
    "",
    "  1. On a machine with access, obtain that exact commit. Either:",
    `       git clone ${settings.deerFlowGitUrls[settings.deerFlowGitUrls.length - 1]} deer-flow`,
    `       git -C deer-flow checkout ${commit}`,
    "     or download and unpack the archive:",
    `       ${settings.deerFlowArchiveUrl}`,
    `       (unpacks to deer-flow-${commit}/; rename that directory to deer-flow)`,
    `  2. Move the checkout to: ${settings.deerFlowDir}`,
    "     so that this directory itself contains backend/, frontend/ and so on.",
    "  3. Run serve again. The launcher verifies the commit before using it.",
  ].join("\n");
}

/**
 * Ensure the pinned deer-flow checkout exists at the configured location.
 * Sources are tried in the user-mandated order: GitCode mirror, canonical
 * GitHub repository, then the codeload archive that works without git. Every
 * path ends in verification — a checkout is only accepted once its commit or
 * content digest matches the pin, and acceptance is recorded in a marker so
 * later launches skip straight through.
 */
export async function ensureDeerFlow(
  io: BootstrapIo,
  settings: BootstrapSettings,
  bootstrap: PayloadBootstrap,
): Promise<string> {
  const { commit, treeDigest } = bootstrap.deerFlow;
  const target = settings.deerFlowDir;
  const markerPath = join(target, DEERFLOW_MARKER_FILE);

  const marker = await readJson<DeerFlowMarker>(markerPath);
  if (marker?.commit === commit && marker.treeDigest === treeDigest) return target;

  if (await isNonEmptyDirectory(target)) {
    // A directory without a matching marker is either a manual placement or a
    // leftover from an older release; verify it rather than trusting it.
    const git = await io.findExecutable("git");
    if (git && (await isNonEmptyDirectory(join(target, ".git")))) {
      const head = (await io.run(git, ["-C", target, "rev-parse", "HEAD"])).stdout.trim();
      if (head !== commit) {
        throw new Error(
          `${target} contains deer-flow at commit ${head}, but this release needs ${commit}.\n`
          + `Run: git -C ${target} fetch origin ${commit} && git -C ${target} checkout ${commit}\n`
          + "or remove the directory and run serve again to download it.",
        );
      }
    } else {
      io.log(`Verifying the existing deer-flow checkout at ${target}...`);
      const digest = await digestTree(target);
      if (digest !== treeDigest) {
        throw new Error(
          `${target} exists but its content does not match deer-flow commit ${commit}.\n`
          + "Remove the directory and run serve again to download the pinned version, or replace it "
          + `with an exact checkout of that commit.\n(expected ${treeDigest}, found ${digest})`,
        );
      }
    }
    await writeFile(markerPath, `${JSON.stringify({ commit, source: "pre-existing", treeDigest } satisfies DeerFlowMarker, null, 2)}\n`);
    return target;
  }

  const attempts: string[] = [];
  const git = await io.findExecutable("git");

  const promote = async (staging: string, source: string): Promise<void> => {
    await writeFile(
      join(staging, DEERFLOW_MARKER_FILE),
      `${JSON.stringify({ commit, source, treeDigest } satisfies DeerFlowMarker, null, 2)}\n`,
    );
    await mkdir(dirname(target), { recursive: true });
    await rename(staging, target);
  };

  for (const [index, url] of settings.deerFlowGitUrls.entries()) {
    if (!git) {
      attempts.push(`git fetch from ${url}: git is not installed on this host`);
      continue;
    }
    const staging = join(settings.dataDir, ".bootstrap-staging", `deer-flow-git-${index}.${process.pid}`);
    try {
      io.log(`Downloading deer-flow ${commit.slice(0, 12)} from ${url}...`);
      await rm(staging, { force: true, recursive: true });
      await mkdir(staging, { recursive: true });
      await io.run(git, ["init", "--quiet", staging]);
      // Fetching the commit itself (not a branch) is what pins the version:
      // the mirror's default branch may be ahead of or behind the gitlink.
      await io.run(git, ["-C", staging, "fetch", "--quiet", "--depth", "1", url, commit], {
        timeoutMs: GIT_FETCH_TIMEOUT_MS,
      });
      await io.run(git, ["-C", staging, "-c", "advice.detachedHead=false", "checkout", "--quiet", commit]);
      const head = (await io.run(git, ["-C", staging, "rev-parse", "HEAD"])).stdout.trim();
      if (head !== commit) throw new Error(`checked out ${head} instead of ${commit}`);
      await promote(staging, url);
      return target;
    } catch (error) {
      attempts.push(`git fetch from ${url}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
      await rm(staging, { force: true, recursive: true });
    }
  }

  {
    const staging = join(settings.dataDir, ".bootstrap-staging", `deer-flow-archive.${process.pid}`);
    try {
      io.log(`Downloading the deer-flow archive from ${settings.deerFlowArchiveUrl}...`);
      await rm(staging, { force: true, recursive: true });
      await mkdir(staging, { recursive: true });
      const response = await io.fetch(settings.deerFlowArchiveUrl, { redirect: "follow" });
      if (!response.ok || !response.body) {
        throw new Error(`download failed (${response.status})`);
      }
      const tarStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(createGunzip());
      await extractTar(tarStream, staging);
      const entries = await readdir(staging);
      if (entries.length !== 1) throw new Error(`expected one top-level directory, found ${entries.length}`);
      const root = join(staging, entries[0] as string);
      const digest = await digestTree(root);
      if (digest !== treeDigest) {
        throw new Error(`archive content does not match the pinned commit (expected ${treeDigest}, got ${digest})`);
      }
      await promote(root, settings.deerFlowArchiveUrl);
      await rm(staging, { force: true, recursive: true });
      return target;
    } catch (error) {
      attempts.push(
        `archive download ${settings.deerFlowArchiveUrl}: ${error instanceof Error ? error.message.split("\n")[0] : error}`,
      );
      await rm(staging, { force: true, recursive: true });
    }
  }

  throw new Error(manualPlacementMessage(settings, bootstrap, attempts));
}

interface GatewayEnvironmentMarker {
  deerFlowCommit: string;
  gatewayWheel: string;
  payloadRoot: string;
  pythonVersion: string;
  requirementsSha256: string;
  /** Comma-joined module names the fast path probes for availability. */
  sentinels: string;
  uvVersion: string;
}

/** Modules imported before the marker fast path is trusted. */
function gatewaySentinelModules(manifest: PayloadManifest): string[] {
  // Importing the actual gateway entry exercises its transitive imports; the
  // other two modules represent the process host and the local DeerFlow tree.
  return ["uvicorn", manifest.app.gatewayModule, "deerflow"];
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
  deerFlowDir: string,
  gatewayRuntime: GatewayProbeRuntime,
): Promise<string> {
  const environmentDir = join(settings.dataDir, "envs", "gateway");
  const markerPath = join(environmentDir, GATEWAY_ENV_MARKER_FILE);
  const venvPython = join(environmentDir, "bin", "python");
  const requirementsPath = join(payloadRoot, bootstrap.requirementsPath);
  const gatewayWheelPath = join(payloadRoot, bootstrap.gatewayWheelPath);
  const harnessDir = join(deerFlowDir, bootstrap.deerFlow.harnessPath);
  const sentinels = gatewaySentinelModules(manifest);
  await recoverGatewayEnvironmentBackup(environmentDir, settings.dataDir);

  const expected: GatewayEnvironmentMarker = {
    deerFlowCommit: bootstrap.deerFlow.commit,
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
    // The harness comes from the verified deer-flow checkout and the gateway
    // wheel from the payload; both are local and --no-deps keeps every
    // third-party package under the hash-checked install above.
    await io.run(
      uvBinary,
      [
        "pip", "install",
        "--python", stagingPython,
        "--no-deps",
        "--index-url", settings.pypiIndex,
        harnessDir,
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
  deerFlowDir: string;
  /** Interpreter the gateway service must run with. */
  gatewayPython: string;
  uvBinary: string;
}

/** Run the full first-launch bootstrap; a no-op fast path once completed. */
export async function runBootstrap(context: BootstrapContext): Promise<BootstrapResult> {
  const bootstrap = context.manifest.bootstrap;
  if (!bootstrap) throw new Error("runBootstrap requires a payload manifest with a bootstrap section.");
  const io = context.io ?? defaultBootstrapIo(context.log);
  const settings = resolveBootstrapSettings(context.env, context.dataDir, bootstrap);
  const pythonBinary = join(context.payloadRoot, context.manifest.python.path);

  return await withBootstrapLock(context.dataDir, io, async () => {
    const uvBinary = await ensureUv(io, settings, bootstrap, pythonBinary);
    const deerFlowDir = await ensureDeerFlow(io, settings, bootstrap);
    const gatewayPython = await ensureGatewayEnvironment(
      io, settings, bootstrap, context.payloadRoot, context.manifest, uvBinary, deerFlowDir, context.gatewayRuntime,
    );
    return { deerFlowDir, gatewayPython, uvBinary };
  });
}
