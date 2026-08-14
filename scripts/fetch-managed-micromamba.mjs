#!/usr/bin/env node
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
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PROVISIONER_BYTES = 64 * 1024 * 1024;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultManifestPath = resolve(scriptDirectory, "../services/runner/src/micromamba-releases.json");

function usage() {
  return `Usage:
  node scripts/fetch-managed-micromamba.mjs --arch <x86_64|aarch64|amd64|arm64> --output <path> [--source <path>]
  node scripts/fetch-managed-micromamba.mjs --arch <arch> --print-tsv

Downloads (or copies) the pinned micromamba binary, verifies its SHA256, and
writes it executable. The release manifest is shared with the Runner runtime.`;
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--print-tsv") options.printTsv = true;
    else if (["--arch", "--manifest", "--output", "--source"].includes(argument)) {
      const value = arguments_[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function assertSafeField(value, label) {
  if (typeof value !== "string" || !value || /[\t\r\n]/.test(value)) {
    throw new Error(`Invalid ${label} in micromamba release manifest`);
  }
  return value;
}

export async function loadRelease(architecture, manifestPath = defaultManifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const aliases = {
    aarch64: "arm64",
    amd64: "x64",
    arm64: "arm64",
    x64: "x64",
    x86_64: "x64",
  };
  const runtimeArchitecture = aliases[architecture];
  const release = runtimeArchitecture ? manifest.releases?.[runtimeArchitecture] : undefined;
  if (!release) throw new Error(`Managed micromamba is unavailable for architecture ${architecture}`);

  const version = assertSafeField(manifest.version, "version");
  const baseUrl = assertSafeField(manifest.baseUrl, "base URL").replace(/\/$/, "");
  const filename = assertSafeField(release.filename, "filename");
  if (filename.includes("/") || filename.includes("\\")) throw new Error("Invalid filename in micromamba release manifest");
  const sha256 = assertSafeField(release.sha256, "SHA256");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid SHA256 in micromamba release manifest");

  return {
    dockerArch: assertSafeField(release.dockerArch, "Docker architecture"),
    filename,
    packageArch: assertSafeField(release.packageArch, "package architecture"),
    runtimeArch: runtimeArchitecture,
    sha256,
    url: `${baseUrl}/${version}/${filename}`,
    version,
  };
}

async function acquireBytes(release, source) {
  if (source) return await readFile(source);
  const response = await fetch(release.url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Managed micromamba download failed (${response.status})`);
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_PROVISIONER_BYTES) throw new Error("Managed micromamba download exceeds size limit");
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchManagedMicromamba({ architecture, manifestPath, output, source }) {
  const release = await loadRelease(architecture, manifestPath);
  const bytes = await acquireBytes(release, source);
  if (!bytes.length || bytes.length > MAX_PROVISIONER_BYTES) {
    throw new Error("Managed micromamba download has an invalid size");
  }
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== release.sha256) {
    throw new Error(`Managed micromamba failed SHA256 verification: expected ${release.sha256}, got ${actualSha256}`);
  }

  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    // Write the bytes that were hashed, rather than re-reading a source file
    // after verification and opening a time-of-check/time-of-use window.
    await writeFile(temporary, bytes);
    await chmod(temporary, 0o755);
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return release;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.arch) throw new Error("--arch is required");
  const release = await loadRelease(options.arch, options.manifest);
  if (options.printTsv) {
    console.log([
      release.version,
      release.runtimeArch,
      release.dockerArch,
      release.packageArch,
      release.filename,
      release.sha256,
      release.url,
    ].join("\t"));
    return;
  }
  if (!options.output) throw new Error("--output is required unless --print-tsv is used");
  await fetchManagedMicromamba({
    architecture: options.arch,
    manifestPath: options.manifest,
    output: options.output,
    source: options.source,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
