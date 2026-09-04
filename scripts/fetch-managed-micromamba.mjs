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
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const MAX_PROVISIONER_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const RETRY_DELAY_MS = 2_000;
const execFileAsync = promisify(execFile);
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

  let condaPackage;
  if (release.condaPackage !== undefined) {
    const cacheFilename = assertSafeField(release.condaPackage.cacheFilename, "conda cache filename");
    if (!/^[0-9A-Za-z._+-]+$/.test(cacheFilename) || !cacheFilename.endsWith(".tar.bz2")) {
      throw new Error("Invalid conda cache filename in micromamba release manifest");
    }
    const packageSubdir = assertSafeField(release.condaPackage.subdir, "conda package subdirectory");
    if (!/^[a-z0-9-]+$/.test(packageSubdir)) {
      throw new Error("Invalid conda package subdirectory in micromamba release manifest");
    }
    const packageFilename = assertSafeField(release.condaPackage.filename, "conda package filename");
    if (packageFilename.includes("/") || packageFilename.includes("\\") || !packageFilename.endsWith(".tar.bz2")) {
      throw new Error("Invalid conda package filename in micromamba release manifest");
    }
    const packageSha256 = assertSafeField(release.condaPackage.sha256, "conda package SHA256");
    if (!/^[a-f0-9]{64}$/.test(packageSha256)) {
      throw new Error("Invalid conda package SHA256 in micromamba release manifest");
    }
    condaPackage = {
      cacheFilename,
      filename: packageFilename,
      sha256: packageSha256,
      subdir: packageSubdir,
    };
  }

  return {
    condaPackage,
    dockerArch: assertSafeField(release.dockerArch, "Docker architecture"),
    filename,
    packageArch: assertSafeField(release.packageArch, "package architecture"),
    runtimeArch: runtimeArchitecture,
    sha256,
    url: `${baseUrl}/${version}/${filename}`,
    version,
  };
}

export function micromambaCacheUrl(release, cacheBaseUrl) {
  if (!release.condaPackage) {
    throw new Error(`Managed micromamba has no pinned conda package for architecture ${release.runtimeArch}`);
  }
  let parsed;
  try {
    parsed = new URL(cacheBaseUrl);
  } catch {
    throw new Error("BINARY_CACHE_URL must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("BINARY_CACHE_URL must be an HTTPS URL without credentials, query, or fragment");
  }
  return `${parsed.href.replace(/\/$/, "")}/${encodeURIComponent(release.condaPackage.cacheFilename)}`;
}

export function condaPackageUrl(release, mirrorBaseUrl) {
  if (!release.condaPackage) {
    throw new Error(`Managed micromamba has no pinned conda package for architecture ${release.runtimeArch}`);
  }
  let parsed;
  try {
    parsed = new URL(mirrorBaseUrl);
  } catch {
    throw new Error("MICROMAMBA_CONDA_MIRROR must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("MICROMAMBA_CONDA_MIRROR must be an HTTPS URL without credentials, query, or fragment");
  }
  const baseUrl = parsed.href.replace(/\/$/, "");
  return `${baseUrl}/${release.condaPackage.subdir}/${release.condaPackage.filename}`;
}

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function binaryCacheOnlyFromEnvironment() {
  const value = process.env.BINARY_CACHE_ONLY?.trim() ?? "0";
  if (!/^[01]$/.test(value)) throw new Error("BINARY_CACHE_ONLY must be 0 or 1");
  return value === "1";
}

class RetryableDownloadError extends Error {}

function retryableError(error) {
  return error instanceof RetryableDownloadError
    || error instanceof TypeError
    || error?.name === "AbortError"
    || error?.name === "TimeoutError";
}

export async function downloadBytesWithRetry(url, {
  attempts = DOWNLOAD_ATTEMPTS,
  fetchImplementation = fetch,
  retryDelayMs = RETRY_DELAY_MS,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImplementation(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const message = `Managed micromamba download failed (${response.status})`;
        if (retryableStatus(response.status)) throw new RetryableDownloadError(message);
        throw new Error(message);
      }
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > MAX_PROVISIONER_BYTES) {
        throw new Error("Managed micromamba download exceeds size limit");
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === attempts || !retryableError(error)) throw error;
      process.stderr.write(
        `Managed micromamba download attempt ${attempt}/${attempts} failed: ${errorMessage(error)}; retrying.\n`,
      );
      if (retryDelayMs > 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs * attempt));
      }
    }
  }
  throw new Error("Managed micromamba download exhausted all attempts");
}

async function extractMicromambaFromCondaPackage(archiveBytes, temporaryParent) {
  await mkdir(temporaryParent, { recursive: true });
  const temporaryDirectory = await mkdtemp(resolve(temporaryParent, ".micromamba-conda-"));
  const archivePath = resolve(temporaryDirectory, "micromamba.tar.bz2");
  try {
    await writeFile(archivePath, archiveBytes);
    await execFileAsync("tar", ["-xjf", archivePath, "-C", temporaryDirectory, "bin/micromamba"]);
    return await readFile(resolve(temporaryDirectory, "bin/micromamba"));
  } catch (error) {
    throw new Error(`Managed micromamba conda package extraction failed: ${errorMessage(error)}`);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

export async function acquireManagedMicromambaBytes(release, source, {
  binaryCacheBaseUrl,
  binaryCacheDirectory,
  binaryCacheOnly = false,
  condaMirrorBaseUrl,
  downloadImplementation = downloadBytesWithRetry,
  extractImplementation = extractMicromambaFromCondaPackage,
  temporaryParent = ".",
} = {}) {
  if (source) return await readFile(source);
  if (!release.condaPackage) return await downloadImplementation(release.url);

  const verifyPackage = (bytes) => {
    if (!bytes.length || bytes.length > MAX_PROVISIONER_BYTES) {
      throw new Error("Managed micromamba conda package has an invalid size");
    }
    const actualPackageSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualPackageSha256 !== release.condaPackage.sha256) {
      throw new Error(
        `Managed micromamba conda package failed SHA256 verification: expected ${release.condaPackage.sha256}, got ${actualPackageSha256}`,
      );
    }
    return bytes;
  };

  const archivePath = binaryCacheDirectory
    ? join(binaryCacheDirectory, release.condaPackage.cacheFilename)
    : undefined;
  let archiveBytes;
  if (archivePath) {
    try {
      archiveBytes = verifyPackage(await readFile(archivePath));
      process.stderr.write(`Binary local cache hit: ${release.condaPackage.cacheFilename}\n`);
    } catch {
      await rm(archivePath, { force: true });
    }
  }

  if (!archiveBytes && binaryCacheBaseUrl) {
    const cacheUrl = micromambaCacheUrl(release, binaryCacheBaseUrl);
    process.stderr.write(`Checking remote cache: ${cacheUrl}\n`);
    try {
      archiveBytes = verifyPackage(await downloadImplementation(cacheUrl));
      process.stderr.write(`Binary remote cache hit: ${release.condaPackage.cacheFilename}\n`);
    } catch (error) {
      process.stderr.write(
        `Binary remote cache miss or invalid entry for ${release.condaPackage.cacheFilename}: ${errorMessage(error)}\n`,
      );
    }
  }

  if (!archiveBytes && binaryCacheOnly) {
    throw new Error(`Required binary cache object is missing or invalid: ${release.condaPackage.cacheFilename}`);
  }

  if (!archiveBytes && condaMirrorBaseUrl) {
    const mirrorUrl = condaPackageUrl(release, condaMirrorBaseUrl);
    process.stderr.write(`Downloading managed micromamba from conda mirror: ${mirrorUrl}\n`);
    archiveBytes = verifyPackage(await downloadImplementation(mirrorUrl));
  }

  if (!archiveBytes) return await downloadImplementation(release.url);

  if (archivePath) {
    await mkdir(binaryCacheDirectory, { recursive: true });
    const temporaryArchive = `${archivePath}.${process.pid}.tmp`;
    try {
      await writeFile(temporaryArchive, archiveBytes);
      await rename(temporaryArchive, archivePath);
    } finally {
      await rm(temporaryArchive, { force: true });
    }
  }
  return await extractImplementation(archiveBytes, temporaryParent);
}

export async function fetchManagedMicromamba({
  architecture,
  binaryCacheBaseUrl = process.env.BINARY_CACHE_URL,
  binaryCacheDirectory = process.env.BINARY_CACHE_DIR,
  binaryCacheOnly = binaryCacheOnlyFromEnvironment(),
  condaMirrorBaseUrl = process.env.MICROMAMBA_CONDA_MIRROR,
  manifestPath,
  output,
  source,
}) {
  const release = await loadRelease(architecture, manifestPath);
  await mkdir(dirname(output), { recursive: true });
  const bytes = await acquireManagedMicromambaBytes(release, source, {
    binaryCacheBaseUrl,
    binaryCacheDirectory: binaryCacheDirectory ? resolve(binaryCacheDirectory) : undefined,
    binaryCacheOnly,
    condaMirrorBaseUrl,
    temporaryParent: dirname(output),
  });
  if (!bytes.length || bytes.length > MAX_PROVISIONER_BYTES) {
    throw new Error("Managed micromamba download has an invalid size");
  }
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== release.sha256) {
    throw new Error(`Managed micromamba failed SHA256 verification: expected ${release.sha256}, got ${actualSha256}`);
  }

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
