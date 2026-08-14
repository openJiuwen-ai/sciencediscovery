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

// Download and verify a pinned language runtime for the single-file release,
// then unpack it into the payload staging tree. Everything comes from
// scripts/binary-release/runtimes.json, so a build cannot silently pick up a
// different Node or CPython than the one the release was tested with.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(scriptDirectory, "runtimes.json");

const USAGE = `Usage: fetch-runtime.mjs --runtime node|python --arch x86_64|aarch64 --output <directory>

Options:
  --cache <directory>   Where verified archives are kept (default: <output>/../.downloads)
  --print-json          Print the resolved manifest entry and exit without downloading
`;

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--arch": options.architecture = value(); break;
      case "--cache": options.cache = resolve(value()); break;
      case "--output": options.output = resolve(value()); break;
      case "--print-json": options.printJson = true; break;
      case "--runtime": options.runtime = value(); break;
      case "-h": case "--help": process.stdout.write(USAGE); process.exit(0); break;
      default: throw new Error(`Unknown argument: ${flag}\n\n${USAGE}`);
    }
  }
  if (!options.runtime || !options.architecture) throw new Error(USAGE);
  return options;
}

export async function loadManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

export function resolveRuntime(manifest, runtime, architecture) {
  const section = manifest[runtime];
  if (!section) throw new Error(`Unknown runtime: ${runtime}`);
  const entry = section.architectures[architecture];
  if (!entry) throw new Error(`${runtime} is not pinned for architecture ${architecture}`);
  const url = runtime === "python"
    ? `${section.baseUrl}/${section.release}/${entry.filename}`
    : `${section.baseUrl}/${section.version}/${entry.filename}`;
  return { ...entry, url, version: section.version };
}

async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Fetch to a cache directory, reusing an archive that already verifies. */
async function download(entry, cacheDirectory) {
  await mkdir(cacheDirectory, { recursive: true });
  const target = join(cacheDirectory, entry.filename);
  if (await exists(target)) {
    if (await sha256(target) === entry.sha256) return target;
    await rm(target, { force: true });
  }
  process.stderr.write(`Downloading ${entry.url}\n`);
  const response = await fetch(entry.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${entry.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.sha256) {
    throw new Error(`Checksum mismatch for ${entry.filename}: expected ${entry.sha256}, got ${digest}`);
  }
  await writeFile(target, bytes);
  return target;
}

/**
 * Unpack an archive whose contents live under a single top-level directory
 * and promote that directory to `output`, so callers get a stable prefix
 * regardless of how upstream names its root.
 */
async function unpackSingleRoot(archivePath, output) {
  const staging = `${output}.unpack`;
  await rm(staging, { force: true, recursive: true });
  await rm(output, { force: true, recursive: true });
  await mkdir(staging, { recursive: true });
  await execFileAsync("tar", ["--extract", "--file", archivePath, "--directory", staging]);
  const entries = await readdir(staging);
  if (entries.length !== 1) {
    throw new Error(`Expected one top-level directory in ${archivePath}, found ${entries.length}`);
  }
  await mkdir(dirname(output), { recursive: true });
  await rename(join(staging, entries[0]), output);
  await rm(staging, { force: true, recursive: true });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = await loadManifest();
  const entry = resolveRuntime(manifest, options.runtime, options.architecture);
  if (options.printJson) {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
    return;
  }
  if (!options.output) throw new Error("--output is required unless --print-json is used");
  const cache = options.cache ?? join(dirname(options.output), ".downloads");
  const archivePath = await download(entry, cache);
  await unpackSingleRoot(archivePath, options.output);
  process.stderr.write(`Unpacked ${options.runtime} ${entry.version} (${options.architecture}) into ${options.output}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
