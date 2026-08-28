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
 * Argument and `.env` parsing for the launcher, kept free of I/O and process
 * state so the option surface can be unit tested directly.
 */
import { resolve } from "node:path";

import { renamedEnvironmentValue, type CompatibilityLog } from "./environment.js";
import type { ServeSettings } from "./serve.js";

export type Command = "serve" | "version" | "help" | "extract" | "run";

/** Input source for `run`: exactly one of positional / content / stdin is set. */
export interface RunSettings {
  /** Positional argument: a problem text or a full JSON input object. */
  positional?: string;
  /** `--content <text>`: a problem text. */
  input?: string;
  /** `--stdin`: read input from stdin. */
  stdin: boolean;
  sessionId?: string;
  projectId?: string;
  modelId?: string;
  skills?: string;
  connectors?: string;
  approval?: string;
  autoApprove: boolean;
  review?: string;
  token?: string;
  output?: string;
  timeout?: number;
}

export interface ParsedInvocation {
  command: Command;
  /** Set for `extract`; destination directory for the unpacked payload. */
  extractTo?: string;
  /** `.env` file to load before applying defaults, when the operator asked. */
  envFile?: string;
  /** True when neither an environment variable nor --data-dir chose the path. */
  usesDefaultDataDir: boolean;
  settings: ServeSettings;
  /** Set for `run`; carries the CLI options that select the session and run. */
  runSettings?: RunSettings;
}

export const USAGE = `Usage: ScienceDiscovery <command> [options]

Commands:
  serve                    Start the Web UI, control API and sandbox runner
  run [input] [options]    Run an agent task via a running serve (CLI client)
  extract --to <dir>       Unpack the embedded runtime payload without starting it
  version                  Print the release version and bundled runtime versions
  help                     Show this message

serve options:
  --data-dir <path>        Runtime data directory (default: ./.sciencediscovery-data)
  --host <address>         Web UI / API bind address (default: 127.0.0.1)
  --port <number>          Web UI / API port (default: 4310)
  --runner-port <number>   Loopback runner port (default: 4311)
  --env-file <path>        Load KEY=VALUE settings from this file before starting
  --bwrap <path>           bubblewrap executable (default: bwrap from PATH)
  --seatbelt <path>        macOS Seatbelt launcher (default: /usr/bin/sandbox-exec)
  --sandbox-provider <p>   auto, bubblewrap, or seatbelt (default: auto)
  --skip-sandbox-check     Start when the platform sandbox probe fails
  --no-scientific-envs     Do not provision the managed scientific environments

run options:
  input (positional)       Problem text, or a JSON object for full input
  --content <text>         Problem text (mutually exclusive with positional/--stdin)
  --stdin                  Read input from stdin (recommended for piping)
  --session <id>           Reuse an existing session; if omitted a new one is created
  --project <id>           Reuse or create a project
  --model <id>             Override the session model
  --skills <id,...>        Override enabled skills
  --connectors <id,...>    Override enabled connectors
  --approval <mode>        ask_for_dangerous (default) | always_allow
  --auto-approve           Equivalent to --approval always_allow
  --review <auto|manual>   Override review mode
  --token <token>          Override the token read from the data directory
  --output <jsonl|text>    Output format, default jsonl (no TTY) / text (TTY)
  --timeout <ms>           Wall-clock timeout for the run

Bubblewrap is the only required host dependency. Neo4j is not bundled, so the
memory-graph feature stays off unless a separate server is configured.

First launch downloads uv and the Python dependencies of the bundled MCP
servers into the data directory (later launches skip this). Optional overrides:
  SCIENCE_DISCOVERY_DATA_DIR          Runtime data directory
  SCIENCE_DISCOVERY_PAYLOAD_CACHE_DIR Extracted payload cache root
  SCIENCE_DISCOVERY_PAYLOAD_DIR       Pre-extracted payload root
  SCIENCE_AGENT_PYPI_INDEX        Package index for Python dependencies
                                  (default: the Huawei Cloud PyPI mirror)
  SCIENCE_AGENT_UV_INSTALL_INDEX  Index the uv wheel is fetched from
                                  (default: SCIENCE_AGENT_PYPI_INDEX)
  SCIENCE_AGENT_UV_PATH           Existing uv executable to use as-is
`;

function requireValue(name: string, value: string | undefined): string {
  if (value === undefined) throw new Error(`${name} requires a value`);
  return value;
}

function parsePort(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`${name} must be an integer between 0 and 65535`);
  }
  return value;
}

const truthy = (value: string | undefined): boolean =>
  value === undefined || /^(1|true|yes|on)$/i.test(value.trim());

export function defaultSettings(
  env: NodeJS.ProcessEnv,
  cwd: string,
  onCompatibility?: CompatibilityLog,
): ServeSettings {
  const sandboxProvider = env.SCIENCE_AGENT_SANDBOX_PROVIDER?.trim() || "auto";
  if (!["auto", "bubblewrap", "seatbelt"].includes(sandboxProvider)) {
    throw new Error("SCIENCE_AGENT_SANDBOX_PROVIDER must be auto, bubblewrap, or seatbelt");
  }
  return {
    bwrapPath: env.SCIENCE_AGENT_BWRAP_PATH?.trim() || "bwrap",
    sandboxProvider: sandboxProvider as "auto" | "bubblewrap" | "seatbelt",
    seatbeltPath: env.SCIENCE_AGENT_SEATBELT_PATH?.trim() || "/usr/bin/sandbox-exec",
    dataDir: resolve(
      cwd,
      renamedEnvironmentValue(
        env,
        "SCIENCE_DISCOVERY_DATA_DIR",
        "SCIENCE_AGENT_DATA_DIR",
        onCompatibility,
      ) || ".sciencediscovery-data",
    ),
    // A downloadable binary binds loopback unless the operator opts in: the
    // product's default API token is well known, so exposing the UI on every
    // interface has to be a deliberate choice.
    host: env.SCIENCE_AGENT_HOST?.trim() || "127.0.0.1",
    port: parsePort("SCIENCE_AGENT_PORT", env.SCIENCE_AGENT_PORT?.trim() || "4310"),
    runnerHost: env.SCIENCE_AGENT_RUNNER_HOST?.trim() || "127.0.0.1",
    runnerPort: parsePort("SCIENCE_AGENT_RUNNER_PORT", env.SCIENCE_AGENT_RUNNER_PORT?.trim() || "4311"),
    scientificEnvironments: truthy(env.SCIENTIFIC_ENVS),
    skipSandboxCheck: false,
  };
}

export function parseInvocation(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  onCompatibility?: CompatibilityLog,
): ParsedInvocation {
  const [rawCommand, ...rest] = argv;
  const command = rawCommand ?? "help";
  if (!["serve", "version", "help", "extract", "run", "--help", "-h", "--version"].includes(command)) {
    throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  }
  const dataDirFromEnvironment = Boolean(
    env.SCIENCE_DISCOVERY_DATA_DIR?.trim() || env.SCIENCE_AGENT_DATA_DIR?.trim(),
  );
  const dataDirFromArgument = rest.includes("--data-dir");
  const invocation: ParsedInvocation = {
    command: command === "--help" || command === "-h"
      ? "help"
      : command === "--version" ? "version" : (command as Command),
    settings: defaultSettings(env, cwd, dataDirFromArgument ? undefined : onCompatibility),
    usesDefaultDataDir: !dataDirFromEnvironment && !dataDirFromArgument,
  };
  if (invocation.command === "run") {
    invocation.runSettings = { stdin: false, autoApprove: false };
  }
  const runOpts = (flag: string): RunSettings => {
    if (!invocation.runSettings) throw new Error(`${flag} requires the run command`);
    return invocation.runSettings;
  };

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    // run 的位置参数:不以 "-" 开头的项当问题正文或完整 JSON 输入(仅首个)
    if (invocation.command === "run" && argument !== undefined && !argument.startsWith("-") && invocation.runSettings && invocation.runSettings.positional === undefined) {
      invocation.runSettings.positional = argument;
      continue;
    }
    const next = (): string => requireValue(argument as string, rest[++index]);
    switch (argument) {
      case "--bwrap": invocation.settings.bwrapPath = next(); break;
      case "--sandbox-provider": {
        const provider = next();
        if (!["auto", "bubblewrap", "seatbelt"].includes(provider)) {
          throw new Error("--sandbox-provider must be auto, bubblewrap, or seatbelt");
        }
        invocation.settings.sandboxProvider = provider as "auto" | "bubblewrap" | "seatbelt";
        break;
      }
      case "--seatbelt": invocation.settings.seatbeltPath = next(); break;
      case "--data-dir": invocation.settings.dataDir = resolve(cwd, next()); break;
      case "--env-file": invocation.envFile = resolve(cwd, next()); break;
      // Accepted and ignored: a saved command line must not start failing just
      // because the service that owned this port was removed.
      case "--gateway-port":
        next();
        onCompatibility?.("[compat] --gateway-port is ignored; the gateway HTTP service was removed.");
        break;
      case "--host": invocation.settings.host = next(); break;
      case "--no-scientific-envs": invocation.settings.scientificEnvironments = false; break;
      case "--port": invocation.settings.port = parsePort(argument, next()); break;
      case "--runner-port": invocation.settings.runnerPort = parsePort(argument, next()); break;
      case "--skip-sandbox-check": invocation.settings.skipSandboxCheck = true; break;
      case "--to": invocation.extractTo = resolve(cwd, next()); break;
      case "-h": case "--help": invocation.command = "help"; break;
      // run 选项
      case "--auto-approve": runOpts(argument).autoApprove = true; break;
      case "--stdin": runOpts(argument).stdin = true; break;
      case "--content": runOpts(argument).input = next(); break;
      case "--session": runOpts(argument).sessionId = next(); break;
      case "--project": runOpts(argument).projectId = next(); break;
      case "--model": runOpts(argument).modelId = next(); break;
      case "--skills": runOpts(argument).skills = next(); break;
      case "--connectors": runOpts(argument).connectors = next(); break;
      case "--approval": {
        const value = next();
        if (value !== "ask_for_dangerous" && value !== "always_allow") {
          throw new Error(`${argument} must be ask_for_dangerous or always_allow`);
        }
        runOpts(argument).approval = value;
        break;
      }
      case "--review": {
        const value = next();
        if (value !== "auto" && value !== "manual") {
          throw new Error(`${argument} must be auto or manual`);
        }
        runOpts(argument).review = value;
        break;
      }
      case "--token": runOpts(argument).token = next(); break;
      case "--output": {
        const value = next();
        if (value !== "jsonl" && value !== "text" && value !== "json") {
          throw new Error(`${argument} must be jsonl, json or text`);
        }
        runOpts(argument).output = value;
        break;
      }
      case "--timeout": {
        const raw = next();
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error(`${argument} must be a positive number`);
        }
        runOpts(argument).timeout = value;
        break;
      }
      default:
        throw new Error(`Unknown option: ${String(argument)}\n\n${USAGE}`);
    }
  }

  if (invocation.command === "extract" && !invocation.extractTo) {
    throw new Error("extract requires --to <directory>");
  }
  if (invocation.command === "run" && invocation.runSettings) {
    const { positional, input, stdin } = invocation.runSettings;
    const sources = [positional !== undefined, input !== undefined, stdin].filter(Boolean).length;
    if (sources > 1) {
      throw new Error(`run input must be exactly one of: positional, --content, --stdin (got ${sources})`);
    }
  }
  return invocation;
}

/**
 * Parse a `KEY=VALUE` settings file. The repository launcher sources `.env`
 * with the shell; the binary has no shell, so it accepts the same simple
 * assignments (comments, blank lines and one level of quoting) itself.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, name, rawValue = ""] = match;
    const quoted = /^"(.*)"$/.exec(rawValue) ?? /^'(.*)'$/.exec(rawValue);
    values[name as string] = quoted ? (quoted[1] as string) : rawValue.replace(/\s+#.*$/, "").trim();
  }
  return values;
}
