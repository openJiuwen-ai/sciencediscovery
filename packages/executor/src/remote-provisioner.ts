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
 * The micromamba a remote Runner needs, obtained by the control plane.
 *
 * The machines this product manages are frequently on an isolated network:
 * they carry the accelerators but have no route to the public release host,
 * while the control plane that deploys the Runner onto them does. Before this,
 * such a machine could never finish its scientific environment setup — the
 * Runner tried to download the provisioner itself and failed — so the control
 * plane fetches the release for the *remote* architecture and hands it over
 * during deployment.
 *
 * It reuses the Runner's own pinned manifest and installer, so there is one
 * definition of "the right file" and one SHA-256 check, not a second one that
 * can drift.
 */

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { installManagedMicromamba, managedMicromambaRelease } from "@sciencediscovery/runner";

import type { RemoteSshAccess, RemoteTransport } from "./remote-compute.js";

export interface ManagedProvisioner {
  architecture: "arm64" | "x64";
  path: string;
  sha256: string;
  version: string;
}

/** Linux `uname -m` as Node names it; anything else has no pinned release. */
export function provisionerArchitecture(architecture: string): "arm64" | "x64" | undefined {
  if (architecture === "x86_64" || architecture === "x64") return "x64";
  if (architecture === "aarch64" || architecture === "arm64") return "arm64";
  return undefined;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * The pinned provisioner for a remote architecture, downloaded once per
 * installation and kept in `cacheDir`. Cached by version and architecture, so
 * a second machine of the same shape costs nothing and a version bump does not
 * reuse the old file.
 */
export async function loadManagedProvisioner(
  remoteArchitecture: string,
  cacheDir: string,
  fetcher: typeof fetch = fetch,
): Promise<ManagedProvisioner> {
  const architecture = provisionerArchitecture(remoteArchitecture);
  if (!architecture) {
    throw new Error(`No pinned micromamba release exists for Linux architecture ${remoteArchitecture || "unknown"}`);
  }
  const release = managedMicromambaRelease(architecture, "linux");
  const path = resolve(cacheDir, `micromamba-${release.version}-linux-${architecture}`);
  const cached = await access(path, constants.R_OK)
    .then(async () => (await stat(path)).isFile() && await sha256File(path) === release.sha256)
    .catch(() => false);
  if (!cached) await installManagedMicromamba(path, fetcher, architecture, "linux");
  return { architecture, path, sha256: release.sha256, version: release.version };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface SeedRemoteProvisionerOptions {
  access: RemoteSshAccess;
  /** The remote machine's `uname -m`. */
  architecture: string;
  cacheDir: string;
  /** The remote ScienceDiscovery data directory, as the machine reported it. */
  dataDir: string;
  fetcher?: typeof fetch;
  /** Test seam: where the verified provisioner comes from on this machine. */
  loadProvisioner?: (architecture: string, cacheDir: string, fetcher?: typeof fetch) => Promise<ManagedProvisioner>;
  transport: RemoteTransport;
}

/**
 * Put the pinned provisioner where the remote Runner looks for it.
 *
 * Returns whether the machine ends up holding the pinned release. The transfer
 * mirrors the Runner binary's: check the checksum that is already there, stage,
 * verify remotely, then move into place — so an interrupted transfer can never
 * leave a half-written executable at the destination, and a machine that is
 * already seeded costs one `sha256sum`.
 */
export async function seedRemoteProvisioner(options: SeedRemoteProvisionerOptions): Promise<boolean> {
  const architecture = provisionerArchitecture(options.architecture);
  if (!architecture) return false;
  // The pin comes from the manifest, so a machine that is already seeded is
  // recognised without this control plane fetching anything at all.
  const pinned = managedMicromambaRelease(architecture, "linux");
  const destination = `${options.dataDir}/scientific-envs/bin/micromamba`;
  const probe = await options.transport.run(options.access, [
    "set -eu",
    // Without sha256sum nothing here can be verified, so nothing is written.
    "command -v sha256sum >/dev/null 2>&1 || { printf 'nocheck\n'; exit 0; }",
    `if [ -x ${shellQuote(destination)} ]; then sha256sum ${shellQuote(destination)} | cut -d ' ' -f 1; fi`,
    "",
  ].join("\n"), 20_000);
  if (probe.exitCode !== 0 || probe.stdout.trim() === "nocheck") return false;
  if (probe.stdout.trim() === pinned.sha256) return true;
  const provisioner = await (options.loadProvisioner ?? loadManagedProvisioner)(
    options.architecture, options.cacheDir, options.fetcher,
  );

  const directory = `${options.dataDir}/scientific-envs/bin`;
  const stage = `${directory}/.upload-${randomBytes(12).toString("hex")}`;
  const connection = await options.transport.open(options.access);
  try {
    const prepared = await connection.run([
      "set -eu",
      `mkdir -p -- ${shellQuote(directory)}`,
      `chmod 700 -- ${shellQuote(`${options.dataDir}/scientific-envs`)} ${shellQuote(directory)}`,
      "",
    ].join("\n"), 20_000);
    if (prepared.exitCode !== 0) return false;
    await connection.upload(provisioner.path, stage);
    const installed = await connection.run([
      "set -eu",
      `test "$(sha256sum ${shellQuote(stage)} | cut -d ' ' -f 1)" = ${shellQuote(provisioner.sha256)} || { echo 'provisioner checksum mismatch' >&2; exit 1; }`,
      `chmod 700 -- ${shellQuote(stage)}`,
      `mv -f -- ${shellQuote(stage)} ${shellQuote(destination)}`,
      "",
    ].join("\n"), 60_000);
    return installed.exitCode === 0;
  } finally {
    // Only this transfer's staging file goes; an existing provisioner and every
    // remote workspace stay untouched, including when the transfer was aborted.
    await connection.run(`rm -f -- ${shellQuote(stage)}`, 5_000).catch(() => undefined);
    connection.close();
  }
}
