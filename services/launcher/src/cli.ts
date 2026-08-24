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
 * Command dispatch for the `ScienceDiscovery` single-file binary.
 *
 * The compiled bundle of this module is injected into a Node single-executable
 * application, and the runtime payload is appended after the ELF image, so the
 * user's whole install story is "download one file and run it".
 */
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createZstdDecompress } from "node:zlib";

import { parseEnvFile, parseInvocation, USAGE } from "./cli-options.js";
import { migrateLegacyDirectory } from "./directory-migration.js";
import { readPayloadLocator } from "./payload-container.js";
import { resolvePayload } from "./payload-store.js";
import { serve } from "./serve.js";
import { extractTar } from "./tar-extract.js";

const write = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/**
 * Apply a `KEY=VALUE` file to the environment before options are resolved.
 * Real environment variables win, matching `set -a; source .env` for callers
 * that exported a value before invoking the binary.
 */
export async function applyEnvFile(path: string, env: NodeJS.ProcessEnv): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read --env-file ${path}: ${error instanceof Error ? error.message : error}`);
  }
  for (const [name, value] of Object.entries(parseEnvFile(contents))) {
    if (env[name] === undefined) env[name] = value;
  }
}

/** Locate `--env-file` before full parsing, since it changes the defaults. */
export function envFileArgument(argv: readonly string[], cwd: string): string | undefined {
  const index = argv.indexOf("--env-file");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined) throw new Error("--env-file requires a value");
  return resolve(cwd, value);
}

async function runExtract(destination: string): Promise<number> {
  const containerPath = process.execPath;
  const locator = await readPayloadLocator(containerPath);
  if (!locator) throw new Error(`${containerPath} has no embedded runtime payload.`);
  const compressed = createReadStream(containerPath, {
    start: locator.offset,
    end: locator.offset + locator.size - 1,
  });
  const decompressed = compressed.pipe(createZstdDecompress());
  compressed.on("error", (error) => decompressed.destroy(error));
  await extractTar(decompressed, destination);
  write(`Unpacked the runtime payload into ${destination}`);
  return 0;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const envFile = envFileArgument(argv, process.cwd());
  if (envFile) await applyEnvFile(envFile, process.env);

  const cwd = process.cwd();
  const invocation = parseInvocation(argv, process.env, cwd, write);
  if (invocation.command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (invocation.command === "extract") {
    return await runExtract(invocation.extractTo as string);
  }

  if (invocation.command === "serve" && invocation.usesDefaultDataDir) {
    // Newest former default first: when a host carries both, the more recent
    // one wins and the older move logs a skip instead of overwriting it.
    for (const legacyName of ["science-discovery-data", "science-agent-data"]) {
      await migrateLegacyDirectory({
        label: "runtime data",
        legacyPath: resolve(cwd, legacyName),
        targetPath: invocation.settings.dataDir,
        log: write,
      });
    }
  }

  const { manifest, root } = await resolvePayload({ env: process.env, onProgress: write });
  if (invocation.command === "version") {
    process.stdout.write(
      [
        `ScienceDiscovery ${manifest.version} (linux-${manifest.architecture})`,
        `  node        ${manifest.node.version}`,
        `  python      ${manifest.python.version}`,
        `  micromamba  ${manifest.micromamba?.version ?? "not bundled"}`,
        `  payload     ${root}`,
        "",
      ].join("\n"),
    );
    return 0;
  }

  const { exitCode } = await serve(
    { baseEnv: process.env, manifest, payloadRoot: root, settings: invocation.settings },
    write,
  );
  return exitCode;
}
