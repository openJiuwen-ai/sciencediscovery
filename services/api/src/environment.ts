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

import { SYSTEM_SHELL_ENVIRONMENT_REVISION_ID, type EnvironmentRevision } from "@sciencediscovery/schema";

export const DEFAULT_ENVIRONMENT_REVISION_ID = "system-python3-bwrap-v1";
const pythonVersion = execFileSync("/usr/bin/python3", ["--version"], { encoding: "utf8" }).trim();
const shellVersion = execFileSync("/usr/bin/bash", ["--version"], { encoding: "utf8" }).split("\n")[0]!.trim();

export const DEFAULT_ENVIRONMENT_PACKAGE_SPEC = `${JSON.stringify({
  executable: "/usr/bin/python3",
  format: "sciencediscovery-environment-v1",
  language: "python",
  packageSource: "read-only system /usr",
  pythonVersion,
  runner: "m1-bwrap-v1",
}, null, 2)}\n`;

export const DEFAULT_ENVIRONMENT_PACKAGE_SPEC_HASH = createHash("sha256")
  .update(DEFAULT_ENVIRONMENT_PACKAGE_SPEC)
  .digest("hex");

export const DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC = `${JSON.stringify({
  executable: "/usr/bin/bash",
  format: "sciencediscovery-environment-v1",
  language: "shell",
  packageSource: "read-only system /usr",
  shellVersion,
  runner: "m1-bwrap-v1",
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
    runnerVersion: "m1-bwrap-v1",
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
    id: SYSTEM_SHELL_ENVIRONMENT_REVISION_ID,
    language: "shell",
    languageVersion: shellVersion,
    packages: [],
    packageSpecHash: DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC_HASH,
    platform: `${process.platform}-${process.arch}`,
    provisioner: "system",
    runnerVersion: "m1-bwrap-v1",
    snapshot: {
      hash: DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC_HASH,
      size: Buffer.byteLength(DEFAULT_SHELL_ENVIRONMENT_PACKAGE_SPEC),
    },
  };
}
