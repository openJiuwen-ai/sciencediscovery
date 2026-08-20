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

// Turn a payload directory into one executable file per architecture.
//
// The launcher is a Node single-executable application: the bundled CLI is
// injected into the pinned `node` binary for the target architecture, which
// keeps the artifact a real ELF executable that `file` and exec(2) understand.
// The compressed payload is then appended after the ELF image and described by
// a fixed-size footer, because trailing bytes are ignored by the loader while
// remaining trivially seekable from inside the running launcher.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { execFile } from "node:child_process";
import { appendFile, chmod, copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadManifest, resolveRuntime } from "./fetch-runtime.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const launcherPackage = join(repositoryRoot, "services/launcher");
const require = createRequire(join(launcherPackage, "package.json"));

/** Sentinel postject looks for inside the Node binary; fixed by Node itself. */
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const PAYLOAD_MAGIC = Buffer.from("SCIDISCOVERYPL01", "ascii");

const USAGE = `Usage: build-binary.mjs --arch <x86_64|aarch64> --payload <dir> --output <file> [--keep-work]
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
      case "--keep-work": options.keepWork = true; break;
      case "--output": options.output = resolve(value()); break;
      case "--payload": options.payload = resolve(value()); break;
      case "-h": case "--help": process.stdout.write(USAGE); process.exit(0); break;
      default: throw new Error(`Unknown argument: ${flag}\n\n${USAGE}`);
    }
  }
  for (const required of ["architecture", "payload", "output"]) {
    if (!options[required]) throw new Error(USAGE);
  }
  return options;
}

/** Bundle the launcher into the single CommonJS file a SEA blob requires. */
async function bundleLauncher(workDirectory) {
  const esbuild = require("esbuild");
  const bundlePath = join(workDirectory, "launcher.cjs");
  await esbuild.build({
    bundle: true,
    entryPoints: [join(launcherPackage, "dist/main.js")],
    format: "cjs",
    logLevel: "warning",
    minify: false,
    outfile: bundlePath,
    platform: "node",
    target: "node22",
  });
  return bundlePath;
}

/**
 * Build the SEA blob. Snapshots and the V8 code cache are deliberately off:
 * both are architecture-specific, and leaving them off is what lets an x86_64
 * host produce the aarch64 artifact.
 */
export async function buildSeaBlob(workDirectory, bundlePath, nodeExecutable, run = execFileAsync) {
  const configPath = join(workDirectory, "sea-config.json");
  const blobPath = join(workDirectory, "launcher.blob");
  await writeFile(configPath, `${JSON.stringify({
    disableExperimentalSEAWarning: true,
    // Node records `main` in the SEA blob. Relative names keep the release
    // binary independent of (and free from) the builder's absolute paths.
    main: basename(bundlePath),
    output: basename(blobPath),
    useCodeCache: false,
    useSnapshot: false,
  }, undefined, 2)}\n`);
  await run(nodeExecutable, ["--experimental-sea-config", configPath], {
    cwd: workDirectory,
    maxBuffer: 64 * 1024 * 1024,
  });
  return blobPath;
}

export function resolveSeaRuntimePlan(
  manifest,
  targetArchitecture,
  platform = process.platform,
  hostArchitecture = process.arch,
) {
  if (platform !== "linux") {
    throw new Error(`SEA release binaries can only be built on Linux, not ${platform}.`);
  }
  const generatorArchitecture = Object.entries(manifest.architectures ?? {})
    .find(([, entry]) => entry.runtimeArchitecture === hostArchitecture)?.[0];
  if (!generatorArchitecture) {
    throw new Error(`No pinned Node runtime can execute on build architecture ${hostArchitecture}.`);
  }
  const target = resolveRuntime(manifest, "node", targetArchitecture);
  const generator = resolveRuntime(manifest, "node", generatorArchitecture);
  if (generator.version !== target.version) {
    throw new Error(
      `Pinned SEA generator version ${generator.version} (${generatorArchitecture}) does not match `
      + `target host version ${target.version} (${targetArchitecture}).`,
    );
  }
  return { generator, generatorArchitecture, target, targetArchitecture };
}

export async function verifyNodeVersion(nodeExecutable, expectedVersion, run = execFileAsync) {
  let stdout;
  try {
    ({ stdout } = await run(nodeExecutable, ["-p", "process.version"], {
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not verify SEA generator Node at ${nodeExecutable}: ${detail}`);
  }
  const actualVersion = stdout.trim();
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `SEA generator Node version mismatch: expected ${expectedVersion} from runtimes.json, `
      + `got ${actualVersion || "<empty>"} from ${nodeExecutable}.`,
    );
  }
  return actualVersion;
}

async function injectBlob(binaryPath, blobPath) {
  await execFileAsync(
    process.execPath,
    [require.resolve("postject/dist/cli.js"), binaryPath, "NODE_SEA_BLOB", blobPath, "--sentinel-fuse", SEA_FUSE],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * Compress the payload tree. `--sort=name` plus a fixed mtime and owner keeps
 * the archive byte-identical across builds of the same inputs, so the release
 * checksums are reproducible.
 */
async function compressPayload(payloadDirectory, workDirectory) {
  const archivePath = join(workDirectory, "payload.tar.zst");
  // Level 19 is the release default; lower it while iterating on a build.
  const level = process.env.SCIENCE_AGENT_PAYLOAD_ZSTD_LEVEL?.trim() || "19";
  await execFileAsync("tar", [
    "--create",
    "--format=gnu",
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    `--use-compress-program=zstd -${level} -T0`,
    "--file", archivePath,
    "--directory", payloadDirectory,
    ".",
  ], { maxBuffer: 16 * 1024 * 1024 });
  return archivePath;
}

async function fetchNodeBinary(architecture, workDirectory) {
  const runtimeDirectory = join(workDirectory, `node-runtime-${architecture}`);
  await execFileAsync(process.execPath, [
    join(scriptDirectory, "fetch-runtime.mjs"),
    "--runtime", "node",
    "--arch", architecture,
    "--output", runtimeDirectory,
    "--cache", join(dirname(workDirectory), ".downloads"),
  ], { maxBuffer: 16 * 1024 * 1024 });
  return join(runtimeDirectory, "bin/node");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await stat(join(options.payload, "manifest.json"));
  await mkdir(dirname(options.output), { recursive: true });
  // The compressed payload is hundreds of megabytes, so staging happens beside
  // the release output rather than in a possibly tmpfs-backed /tmp.
  const workDirectory = join(dirname(options.output), `.work-${options.architecture}`);
  await rm(workDirectory, { force: true, recursive: true });
  await mkdir(workDirectory, { recursive: true });

  try {
    const manifest = await loadManifest();
    const runtimePlan = resolveSeaRuntimePlan(manifest, options.architecture);
    process.stderr.write(`Preparing the ${options.architecture} executable...\n`);
    const targetNodeBinary = await fetchNodeBinary(options.architecture, workDirectory);
    const generatorNodeBinary = runtimePlan.generatorArchitecture === options.architecture
      ? targetNodeBinary
      : await fetchNodeBinary(runtimePlan.generatorArchitecture, workDirectory);
    const generatorVersion = await verifyNodeVersion(generatorNodeBinary, runtimePlan.target.version);
    process.stderr.write(
      `Generating the SEA blob with pinned Node ${generatorVersion} (${runtimePlan.generatorArchitecture}).\n`,
    );

    process.stderr.write("Bundling the launcher...\n");
    const bundlePath = await bundleLauncher(workDirectory);
    const blobPath = await buildSeaBlob(workDirectory, bundlePath, generatorNodeBinary);

    await rm(options.output, { force: true });
    await copyFile(targetNodeBinary, options.output);
    await chmod(options.output, 0o755);
    await injectBlob(options.output, blobPath);

    process.stderr.write("Compressing the runtime payload...\n");
    const archivePath = await compressPayload(options.payload, workDirectory);
    const payloadSize = (await stat(archivePath)).size;
    const offset = (await stat(options.output)).size;

    // Stream the payload onto the executable and digest it in the same pass;
    // buffering a multi-hundred-megabyte archive would only waste memory.
    const digest = createHash("sha256");
    await pipeline(
      createReadStream(archivePath),
      async function* hashing(chunks) {
        for await (const chunk of chunks) {
          digest.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(options.output, { flags: "a" }),
    );
    const identifier = digest.digest("hex").slice(0, 32);

    const footer = Buffer.alloc(48);
    PAYLOAD_MAGIC.copy(footer, 0);
    footer.writeBigUInt64LE(BigInt(offset), 16);
    footer.writeBigUInt64LE(BigInt(payloadSize), 24);
    Buffer.from(identifier, "hex").copy(footer, 32);
    await appendFile(options.output, footer);
    await chmod(options.output, 0o755);

    const finalSize = (await stat(options.output)).size;
    process.stderr.write(
      `Built ${options.output} (${(finalSize / 1024 / 1024).toFixed(1)} MiB, payload ${identifier})\n`,
    );
  } finally {
    if (!options.keepWork) await rm(workDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
