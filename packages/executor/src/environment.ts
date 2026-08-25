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

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  SYSTEM_PYTHON_ENVIRONMENT_REVISION_ID,
  SYSTEM_PYTHON_SEATBELT_ENVIRONMENT_REVISION_ID,
  SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
  SYSTEM_SHELL_SEATBELT_ENVIRONMENT_REVISION_ID,
  type EnvironmentRevision,
  type SandboxKind,
} from "@sciencediscovery/schema";

export function hostSandboxKind(platform: NodeJS.Platform = process.platform): SandboxKind {
  return platform === "darwin" ? "seatbelt" : "bubblewrap";
}

export function systemPythonEnvironmentRevisionId(
  sandbox: SandboxKind = hostSandboxKind(),
): string {
  return sandbox === "seatbelt"
    ? SYSTEM_PYTHON_SEATBELT_ENVIRONMENT_REVISION_ID
    : SYSTEM_PYTHON_ENVIRONMENT_REVISION_ID;
}

export function systemShellEnvironmentRevisionId(
  sandbox: SandboxKind = hostSandboxKind(),
): typeof SYSTEM_SHELL_ENVIRONMENT_REVISION_ID | typeof SYSTEM_SHELL_SEATBELT_ENVIRONMENT_REVISION_ID {
  return sandbox === "seatbelt"
    ? SYSTEM_SHELL_SEATBELT_ENVIRONMENT_REVISION_ID
    : SYSTEM_SHELL_ENVIRONMENT_REVISION_ID;
}

const SYSTEM_ENVIRONMENT_REVISION_IDS = new Set<string>([
  SYSTEM_PYTHON_ENVIRONMENT_REVISION_ID,
  SYSTEM_PYTHON_SEATBELT_ENVIRONMENT_REVISION_ID,
  SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
  SYSTEM_SHELL_SEATBELT_ENVIRONMENT_REVISION_ID,
]);

export function isSystemEnvironmentRevisionId(revisionId: string): boolean {
  return SYSTEM_ENVIRONMENT_REVISION_IDS.has(revisionId);
}

export const DEFAULT_ENVIRONMENT_REVISION_ID = systemPythonEnvironmentRevisionId();
const sandbox = hostSandboxKind();
// The package spec records paths inside the Runner's sandbox. Probe versions
// through PATH because the API host may install the same tools elsewhere.
const pythonProbeExecutable = process.env.SCIENCE_AGENT_PYTHON_PATH?.trim() || "python3";
const shellProbeExecutable = process.env.SCIENCE_AGENT_SHELL_PATH?.trim() || "bash";
const pythonVersion = execFileSync(pythonProbeExecutable, ["--version"], { encoding: "utf8" }).trim();
const shellVersion = execFileSync(shellProbeExecutable, ["--version"], { encoding: "utf8" }).split("\n")[0]!.trim();
const runnerVersion = sandbox === "seatbelt" ? "m4-isolation-only-v1" : "m1-bwrap-v1";
const packageSource = sandbox === "seatbelt" ? "read-only system runtime" : "read-only system /usr";
const pythonExecutable = "/usr/bin/python3";
const shellExecutable = process.platform === "darwin" ? "/bin/bash" : "/usr/bin/bash";

export const DEFAULT_ENVIRONMENT_PACKAGE_SPEC = `${JSON.stringify({
  executable: pythonExecutable,
  format: "sciencediscovery-environment-v1",
  language: "python",
  packageSource,
  pythonVersion,
  runner: runnerVersion,
}, null, 2)}\n`;

export const DEFAULT_ENVIRONMENT_PACKAGE_SPEC_HASH = createHash("sha256")
  .update(DEFAULT_ENVIRONMENT_PACKAGE_SPEC)
  .digest("hex");

export const DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC = `${JSON.stringify({
  executable: shellExecutable,
  format: "sciencediscovery-environment-v1",
  language: "shell",
  packageSource,
  shellVersion,
  runner: runnerVersion,
}, null, 2)}\n`;

export const DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC_HASH = createHash("sha256")
  .update(DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC)
  .digest("hex");

export function defaultEnvironmentRevision(): EnvironmentRevision {
  return {
    channels: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    environmentId: "legacy-system-python",
    id: DEFAULT_ENVIRONMENT_REVISION_ID,
    language: "python",
    languageVersion: pythonVersion,
    packages: [],
    packageSpecHash: DEFAULT_ENVIRONMENT_PACKAGE_SPEC_HASH,
    platform: `${process.platform}-${process.arch}`,
    provisioner: "system",
    runnerVersion,
    snapshot: {
      hash: DEFAULT_ENVIRONMENT_PACKAGE_SPEC_HASH,
      size: Buffer.byteLength(DEFAULT_ENVIRONMENT_PACKAGE_SPEC),
    },
  };
}

export function defaultShellEnvironmentRevision(): EnvironmentRevision {
  return {
    channels: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    environmentId: "system-shell",
    id: systemShellEnvironmentRevisionId(),
    language: "shell",
    languageVersion: shellVersion,
    packages: [],
    packageSpecHash: DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC_HASH,
    platform: `${process.platform}-${process.arch}`,
    provisioner: "system",
    runnerVersion,
    snapshot: {
      hash: DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC_HASH,
      size: Buffer.byteLength(DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC),
    },
  };
}
