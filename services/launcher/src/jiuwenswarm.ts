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
 * Starts the embedded JiuwenSwarm instance and the Python adapter that fronts
 * it, for `serve --jiuwenswarm`. Both were installed at build time into a
 * flat, PYTHONPATH-addressable directory rather than a venv (see
 * scripts/binary-release/build-payload.sh for why), so every invocation here
 * runs the bundled interpreter directly against that PYTHONPATH and calls an
 * entry-point module's `main()` itself — never JiuwenSwarm's own
 * console-script wrappers, whose shebang is the *build* machine's absolute
 * path and would fail once this payload is extracted somewhere else.
 *
 * Mirrors `scripts/jiuwenswarm.sh` and the `--jiuwenswarm` path of
 * `scripts/start-stack.sh`: same instance name, same
 * `progressive_tool_enabled: false` config patch, same adapter/API port split
 * (adapter takes the public port, the API moves to port + 100).
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PayloadManifest } from "./payload-manifest.js";
import type { ServiceDefinition } from "./supervisor.js";

/** Fixed, not derived from the data dir name: matches every other JiuwenSwarm entry point in this repo. */
const INSTANCE_NAME = "sciencediscovery";

export interface JiuwenSwarmContext {
  manifest: PayloadManifest;
  payloadRoot: string;
  /** The launcher's own data directory; JiuwenSwarm's HOME and instance table live under it, never the real $HOME. */
  dataDir: string;
  baseEnv: NodeJS.ProcessEnv;
  pythonBinary: string;
  log: (message: string) => void;
}

interface JiuwenSwarmPaths {
  pythonBinary: string;
  sitePackages: string;
  adapterSitePackages: string;
  home: string;
  dataDir: string;
  instanceWorkspace: string;
}

export function jiuwenswarmPaths(context: JiuwenSwarmContext): JiuwenSwarmPaths {
  const jw = context.manifest.jiuwenswarm;
  if (!jw) {
    throw new Error(
      "--jiuwenswarm was given, but this release was not built with JiuwenSwarm embedded "
      + "(the payload manifest has no jiuwenswarm section). Rebuild with a payload that carries it.",
    );
  }
  const home = join(context.dataDir, "jiuwenswarm-home");
  return {
    pythonBinary: context.pythonBinary,
    sitePackages: join(context.payloadRoot, jw.sitePackages),
    adapterSitePackages: join(context.payloadRoot, jw.adapterSitePackages),
    home,
    dataDir: join(context.dataDir, "jiuwenswarm-data"),
    instanceWorkspace: join(home, ".jiuwenswarm-instances", INSTANCE_NAME),
  };
}

interface PythonRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** One entry-point call: `<bundled python> -c "<module>.main()"`, argv set to what the console script would have gotten. */
function runEntryPoint(
  paths: JiuwenSwarmPaths,
  baseEnv: NodeJS.ProcessEnv,
  moduleName: string,
  args: readonly string[],
): Promise<PythonRunResult> {
  const script = `
import sys
sys.argv = ["${moduleName}", *sys.argv[1:]]
from ${moduleName} import main
sys.exit(main() or 0)
`;
  return new Promise((resolveRun) => {
    const child = spawn(paths.pythonBinary, ["-c", script, ...args], {
      env: {
        ...baseEnv,
        HOME: paths.home,
        JIUWENSWARM_DATA_DIR: paths.dataDir,
        PYTHONPATH: paths.sitePackages,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
    child.on("error", (error) => resolveRun({ code: 127, stdout, stderr: `${stderr}${error.message}\n` }));
  });
}

async function instanceExists(paths: JiuwenSwarmPaths): Promise<boolean> {
  try {
    await readFile(join(paths.instanceWorkspace, ".env"));
    return true;
  } catch {
    return false;
  }
}

/**
 * The one JiuwenSwarm setting ScienceDiscovery depends on: with JiuwenSwarm's
 * default (`true`) a run's tools are hidden behind a search step and the
 * model no longer sees them by the names ScienceDiscovery defined. Mirrors
 * `scripts/jiuwenswarm.sh`'s `apply_config()`, minus that script's optional
 * context-window and free-search defaults — those are user-configurable
 * later from Settings, this one is not optional.
 */
async function applyConfig(paths: JiuwenSwarmPaths): Promise<void> {
  const configPath = join(paths.instanceWorkspace, "config", "config.yaml");
  const text = await readFile(configPath, "utf8");
  const patched = /^progressive_tool_enabled:.*$/m.test(text)
    ? text.replace(/^progressive_tool_enabled:.*$/m, "progressive_tool_enabled: false")
    : `progressive_tool_enabled: false\n${text}`;
  if (patched !== text) await writeFile(configPath, patched, "utf8");
}

/** Idempotent: creates and configures the instance only if it does not exist yet. */
export async function ensureInstance(context: JiuwenSwarmContext): Promise<JiuwenSwarmPaths> {
  const paths = jiuwenswarmPaths(context);
  if (await instanceExists(paths)) return paths;
  context.log(`Creating the JiuwenSwarm instance ${INSTANCE_NAME}...`);
  const init = await runEntryPoint(paths, context.baseEnv, "jiuwenswarm.init_workspace", ["--name", INSTANCE_NAME]);
  if (init.code !== 0) {
    throw new Error(`jiuwenswarm-init failed (status ${String(init.code)}):\n${init.stderr || init.stdout}`);
  }
  await applyConfig(paths);
  return paths;
}

/** `ServiceDefinition` for the Supervisor: no healthUrl, its ports are not known until it reports them (see waitForGateway). */
export function jiuwenswarmServiceDefinition(paths: JiuwenSwarmPaths, baseEnv: NodeJS.ProcessEnv): ServiceDefinition {
  const script = `
import sys
sys.argv = ["jiuwenswarm-start", "--name", "${INSTANCE_NAME}", "app"]
from jiuwenswarm.start_services import main
sys.exit(main() or 0)
`;
  return {
    name: "JiuwenSwarm",
    command: paths.pythonBinary,
    args: ["-c", script],
    cwd: paths.home,
    env: {
      ...baseEnv,
      HOME: paths.home,
      JIUWENSWARM_DATA_DIR: paths.dataDir,
      // Python loads sitecustomize from a PYTHONPATH entry itself. Point at the adapter package
      // directory so its guarded startup hook applies JiuwenSwarm's MCP timeout patch before
      // startup prewarming creates a client with the 30-second fallback.
      PYTHONPATH: `${join(paths.adapterSitePackages, "sciencediscovery_adapter")}:${paths.sitePackages}`,
      SCIENCE_AGENT_JIUWENSWARM_BOOTSTRAP: "1",
    },
  };
}

export interface JiuwenSwarmEndpoints {
  gatewayPort: number;
  webPort: number;
}

/**
 * Poll `jiuwenswarm-start --status` until the instance reports running and
 * publishes its (dynamically chosen) gateway and web ports — the adapter
 * needs both before it can start. Budget matches `scripts/jiuwenswarm.sh`:
 * up to 180s starting, plus the same extra grace after the gateway accepts
 * connections but before the agent server answers behind it.
 */
export async function waitForGateway(
  paths: JiuwenSwarmPaths,
  baseEnv: NodeJS.ProcessEnv,
  isSettled: () => boolean,
): Promise<JiuwenSwarmEndpoints> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (isSettled()) throw new Error("JiuwenSwarm exited before its gateway came up. See the output above.");
    const status = await runEntryPoint(paths, baseEnv, "jiuwenswarm.start_services", ["--status", INSTANCE_NAME]);
    if (status.code === 0 && /^Status:\s*running/m.test(status.stdout)) {
      const gatewayMatch = /^\s*gateway:\s*(\d+)/m.exec(status.stdout);
      const webMatch = /^\s*web:\s*(\d+)/m.exec(status.stdout);
      if (gatewayMatch?.[1] && webMatch?.[1]) {
        // Measured in scripts/jiuwenswarm.sh: the gateway accepts connections a few seconds before the agent server does.
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 6_000));
        return { gatewayPort: Number(gatewayMatch[1]), webPort: Number(webMatch[1]) };
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error(`JiuwenSwarm did not report as running within 180s.`);
}

export interface AdapterSettings {
  publicPort: number;
  legacyPort: number;
  host: string;
  endpoints: JiuwenSwarmEndpoints;
}

/** `ServiceDefinition` for the Supervisor: health-gated on the adapter's own `/agent/info`. */
export function adapterServiceDefinition(
  paths: JiuwenSwarmPaths,
  baseEnv: NodeJS.ProcessEnv,
  settings: AdapterSettings,
): ServiceDefinition {
  return {
    name: "JiuwenSwarm adapter",
    command: paths.pythonBinary,
    args: ["-m", "sciencediscovery_adapter.server"],
    cwd: paths.home,
    env: {
      ...baseEnv,
      PYTHONPATH: paths.adapterSitePackages,
      SCIENCE_AGENT_HOST: settings.host,
      SCIENCE_AGENT_PORT: String(settings.publicPort),
      SCIENCE_AGENT_LEGACY_PORT: String(settings.legacyPort),
      JIUWENSWARM_GATEWAY_URL: `ws://127.0.0.1:${settings.endpoints.gatewayPort}/tui`,
      JIUWENSWARM_MGMT_URL: `ws://127.0.0.1:${settings.endpoints.webPort}/ws`,
    },
    healthUrl: `http://127.0.0.1:${settings.publicPort}/agent/info`,
  };
}
