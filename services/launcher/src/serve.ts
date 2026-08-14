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
 * `ScienceDiscovery serve`: bring the whole product up from the embedded payload.
 *
 * Everything the stack executes — Node, CPython, micromamba, the built Web
 * assets — comes out of the payload, so a host needs only bubblewrap. Docker
 * is never consulted on this path; the container image is a separate
 * deployment mode with its own entrypoint.
 */
import { chmod, copyFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  accessTokenBanner,
  resolveServeCredentials,
  type ServeCredentials,
} from "./bootstrap-tokens.js";
import { runBootstrap } from "./bootstrap.js";
import type { PayloadManifest } from "./payload-manifest.js";
import { runPreflight } from "./preflight.js";
import { Supervisor, type ServiceDefinition } from "./supervisor.js";

export interface ServeSettings {
  bwrapPath: string;
  dataDir: string;
  gatewayHost: string;
  gatewayPort: number;
  host: string;
  port: number;
  runnerHost: string;
  runnerPort: number;
  scientificEnvironments: boolean;
  skipSandboxCheck: boolean;
}

export interface ServeContext {
  manifest: PayloadManifest;
  payloadRoot: string;
  settings: ServeSettings;
  /** Base environment the services inherit; the process env in production. */
  baseEnv: NodeJS.ProcessEnv;
  /**
   * Gateway interpreter provisioned by the first-launch bootstrap. Absent for
   * format-version-1 payloads, whose dependencies are embedded beside the
   * bundled interpreter.
   */
  gatewayPythonPath?: string;
}

/**
 * A `ServeContext` with the stack credentials already resolved. `serve` does
 * that one disk read/write up front so `planServices` stays a pure function of
 * its input — the tests exercise the topology without touching the data dir.
 */
export interface ServicePlanContext extends ServeContext {
  credentials: ServeCredentials;
}

/** Environment names the launcher forwards untouched when the operator set them. */
const FORWARDED_RUNNER_SETTINGS = [
  "SCIENCE_AGENT_EXEC_TIMEOUT_MS",
  "SCIENCE_AGENT_KERNEL_IDLE_MS",
  "SCIENCE_AGENT_PACKAGE_CACHE_DIR",
  "SCIENCE_AGENT_SCIENTIFIC_CHANNELS",
] as const;

function forwarded(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of FORWARDED_RUNNER_SETTINGS) {
    const value = baseEnv[name]?.trim();
    if (value) result[name] = value;
  }
  return result;
}

export function gatewayUrl(settings: ServeSettings, baseEnv: NodeJS.ProcessEnv = {}): string {
  return baseEnv.SCIENCE_AGENT_GATEWAY_URL?.trim().replace(/\/$/, "")
    || `http://${settings.gatewayHost}:${settings.gatewayPort}`;
}

export function runnerUrl(settings: ServeSettings, baseEnv: NodeJS.ProcessEnv = {}): string {
  return baseEnv.SCIENCE_AGENT_RUNNER_URL?.trim().replace(/\/$/, "")
    || `http://${settings.runnerHost}:${settings.runnerPort}`;
}

/** Absolute path of a payload-relative entry recorded in the manifest. */
const payloadPath = (root: string, relative: string): string => join(root, relative);

/**
 * Build the ordered service list. Kept pure so tests can assert the topology,
 * ordering and environment without spawning anything.
 */
export function planServices(context: ServicePlanContext): ServiceDefinition[] {
  const { credentials, manifest, payloadRoot, settings } = context;
  // The deer-flow harness otherwise writes `.deer-flow/` beside the working
  // directory, which here is inside the payload cache — state would then be
  // stranded when a new release unpacks to a different cache directory.
  const baseEnv: NodeJS.ProcessEnv = {
    ...context.baseEnv,
    DEER_FLOW_HOME: context.baseEnv.DEER_FLOW_HOME?.trim() || join(settings.dataDir, "deer-flow"),
  };
  const nodeBinary = payloadPath(payloadRoot, manifest.node.path);
  const pythonBinary = context.gatewayPythonPath ?? payloadPath(payloadRoot, manifest.python.path);
  const appRoot = payloadPath(payloadRoot, manifest.app.root);

  const gatewayBase = gatewayUrl(settings, baseEnv);
  const runnerBase = runnerUrl(settings, baseEnv);

  // No PYTHONPATH: the payload installs the gateway dependencies into the
  // bundled interpreter's own site-packages. The gateway launches stdio MCP
  // servers through the MCP SDK, which passes only an allow-listed environment
  // to those subprocesses, so anything carried in PYTHONPATH would be dropped
  // exactly where the gateway needs its own package to be importable.
  const gatewayEnvironment: NodeJS.ProcessEnv = {
    ...baseEnv,
    SCIENCE_AGENT_GATEWAY_HOST: settings.gatewayHost,
    // Both ends of the internal channel get the value `serve` already resolved,
    // so neither service has to find the stored credential from whatever working
    // directory it happens to run in.
    SCIENCE_AGENT_GATEWAY_INTERNAL_TOKEN: credentials.gatewayInternalToken.token,
    SCIENCE_AGENT_GATEWAY_PORT: String(settings.gatewayPort),
  };

  const runnerEnvironment: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...forwarded(baseEnv),
    SCIENCE_AGENT_BWRAP_PATH: settings.bwrapPath,
    SCIENCE_AGENT_DATA_DIR: settings.dataDir,
    SCIENCE_AGENT_RUNNER_HOST: settings.runnerHost,
    SCIENCE_AGENT_RUNNER_PORT: String(settings.runnerPort),
    SCIENCE_AGENT_RUNNER_TOKEN: baseEnv.SCIENCE_AGENT_RUNNER_TOKEN?.trim() || "science-agent-runner-local",
    SCIENTIFIC_ENVS: settings.scientificEnvironments ? "1" : "0",
  };

  const apiEnvironment: NodeJS.ProcessEnv = {
    ...baseEnv,
    SCIENCE_AGENT_AUTH_TOKEN: credentials.authToken.token,
    SCIENCE_AGENT_DATA_DIR: settings.dataDir,
    SCIENCE_AGENT_GATEWAY_INTERNAL_TOKEN: credentials.gatewayInternalToken.token,
    SCIENCE_AGENT_GATEWAY_URL: gatewayBase,
    SCIENCE_AGENT_HOST: settings.host,
    SCIENCE_AGENT_PORT: String(settings.port),
    SCIENCE_AGENT_RUNNER_TOKEN: runnerEnvironment.SCIENCE_AGENT_RUNNER_TOKEN,
    SCIENCE_AGENT_RUNNER_URL: runnerBase,
  };

  return [
    {
      name: "agent-loop gateway",
      command: pythonBinary,
      args: ["-m", manifest.app.gatewayModule],
      cwd: appRoot,
      env: gatewayEnvironment,
      healthUrl: `${gatewayBase}/health`,
    },
    {
      name: "bubblewrap runner",
      command: nodeBinary,
      args: [payloadPath(payloadRoot, manifest.app.runnerEntry)],
      cwd: appRoot,
      env: runnerEnvironment,
      healthUrl: `${runnerBase}/health`,
    },
    {
      name: "control API and Web UI",
      command: nodeBinary,
      args: [payloadPath(payloadRoot, manifest.app.apiEntry)],
      cwd: appRoot,
      env: apiEnvironment,
      healthUrl: `http://${settings.host === "0.0.0.0" ? "127.0.0.1" : settings.host}:${settings.port}/health`,
    },
  ];
}

/**
 * Copy the payload's micromamba into the Runner's managed location on first
 * run. The Runner verifies it against `micromamba-releases.json` and only
 * downloads when the file is absent, so seeding keeps first launch offline.
 * This mirrors `scripts/seed-managed-micromamba.sh` in the container image.
 */
export async function seedProvisioner(context: ServeContext): Promise<string | undefined> {
  const { baseEnv, manifest, payloadRoot, settings } = context;
  if (!manifest.micromamba || !settings.scientificEnvironments) return undefined;
  // An administrator-provided provisioner is authoritative; never overwrite it.
  if (baseEnv.SCIENCE_AGENT_PROVISIONER_PATH?.trim()) return undefined;

  const target = join(settings.dataDir, "scientific-envs", "bin", "micromamba");
  try {
    await stat(target);
    return target;
  } catch {
    // Not seeded yet.
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await copyFile(payloadPath(payloadRoot, manifest.micromamba.path), temporary);
  await chmod(temporary, 0o755);
  await rename(temporary, target);
  return target;
}

export interface ServeResult {
  exitCode: number;
}

export async function serve(context: ServeContext, log: (message: string) => void): Promise<ServeResult> {
  const { manifest, settings } = context;
  log(`ScienceDiscovery ${manifest.version} (linux-${manifest.architecture})`);

  await runPreflight({
    bwrapPath: settings.bwrapPath,
    dataDir: settings.dataDir,
    env: context.baseEnv,
    skipSandboxCheck: settings.skipSandboxCheck,
    warn: log,
  });
  await seedProvisioner(context);

  // Resolved before anything starts: the same values go to the children below
  // and into both the gateway bootstrap probe and the ready banner, so every
  // process observes one credential set and the user can recover access.
  const credentials = resolveServeCredentials(settings.dataDir, context.baseEnv);

  // Format-version-2 payloads restore uv, deer-flow and the gateway
  // environment on first launch; later launches pass straight through.
  if (manifest.bootstrap && !context.gatewayPythonPath) {
    // The integrity probe imports the real gateway entry point, whose config
    // resolution depends on process context. Reuse the service plan verbatim
    // so the probe cannot accidentally inherit the launcher's working tree.
    const gatewayService = planServices({ ...context, credentials })[0];
    if (!gatewayService) throw new Error("The gateway service plan is empty.");
    const bootstrap = await runBootstrap({
      dataDir: settings.dataDir,
      env: context.baseEnv,
      gatewayRuntime: { cwd: gatewayService.cwd, env: gatewayService.env },
      log,
      manifest,
      payloadRoot: context.payloadRoot,
    });
    context = { ...context, gatewayPythonPath: bootstrap.gatewayPython };
  }

  const services = planServices({ ...context, credentials });
  await mkdir(services[0]?.env.DEER_FLOW_HOME as string, { recursive: true });

  const supervisor = new Supervisor({ log });
  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    log(`\nReceived ${signal}; stopping the ScienceDiscovery stack...`);
    void supervisor.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await supervisor.start(services);

    const uiHost = settings.host === "0.0.0.0" ? "127.0.0.1" : settings.host;
    log("");
    log(`  ScienceDiscovery is ready at http://${uiHost}:${settings.port}`);
    for (const line of accessTokenBanner(settings.dataDir, credentials)) log(line);
    log(`  Data directory: ${settings.dataDir}`);
    log("  Memory graph is disabled: it needs a Neo4j server, which is not bundled.");
    log("  Press Ctrl-C to stop.");
    log("");

    const first = await supervisor.waitForFirstExit();
    if (!stopping) {
      log(`${first.name} exited (${first.signal ? `signal ${first.signal}` : `status ${String(first.code)}`}); stopping the stack.`);
    }
    return { exitCode: stopping ? 0 : (first.code ?? 1) };
  } finally {
    await supervisor.stop();
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}
