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
 * First-run unpacking of the embedded payload.
 *
 * `serve` needs real files on disk (a Node binary, a CPython prefix, service
 * trees) so it can exec normal processes. The single downloadable file is
 * therefore expanded once into a versioned cache directory keyed by the
 * payload digest; later runs reuse it, and a payload rebuild lands in a new
 * directory instead of corrupting the old one.
 */
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createZstdDecompress } from "node:zlib";

import { PAYLOAD_MANIFEST_FILE, parsePayloadManifest, type PayloadManifest } from "./payload-manifest.js";
import { readPayloadLocator, type PayloadLocator } from "./payload-container.js";
import { extractTar } from "./tar-extract.js";

export interface PayloadStoreOptions {
  /** Container to read the payload from; defaults to the running executable. */
  containerPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Progress sink for the one-off extraction, which takes a few seconds. */
  onProgress?: (message: string) => void;
}

export interface ResolvedPayload {
  manifest: PayloadManifest;
  /** Absolute path of the extracted payload root. */
  root: string;
}

/** Root of the extraction cache, honouring XDG and an explicit override. */
export function payloadCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SCIENCE_AGENT_PAYLOAD_CACHE_DIR?.trim();
  if (override) return resolve(override);
  const xdgCache = env.XDG_CACHE_HOME?.trim();
  const base = xdgCache ? resolve(xdgCache) : join(env.HOME?.trim() || homedir(), ".cache");
  return join(base, "science-agent", "payload");
}

async function readManifest(root: string): Promise<PayloadManifest> {
  const manifestPath = join(root, PAYLOAD_MANIFEST_FILE);
  return parsePayloadManifest(await readFile(manifestPath, "utf8"), manifestPath);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function extractPayload(
  containerPath: string,
  locator: PayloadLocator,
  target: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  // Extract beside the final directory, then rename: the rename is atomic, so
  // a concurrent or interrupted first run can never expose a half payload.
  const staging = await mkdtemp(`${target}.staging-`);
  try {
    onProgress?.(`Unpacking the runtime payload into ${target} (first run only)...`);
    const compressed = createReadStream(containerPath, {
      start: locator.offset,
      end: locator.offset + locator.size - 1,
    });
    const decompressed = compressed.pipe(createZstdDecompress());
    compressed.on("error", (error) => decompressed.destroy(error));
    await extractTar(decompressed, staging);
    try {
      await rename(staging, target);
    } catch (error) {
      // Another process finished first; its copy is equivalent by digest.
      if (!(await isDirectory(target))) throw error;
      await rm(staging, { force: true, recursive: true });
    }
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
}

/**
 * Resolve the payload for this run, extracting it on first use.
 *
 * `SCIENCE_AGENT_PAYLOAD_DIR` points at an already-extracted payload, which is
 * how the packaging script smoke-tests a payload before it is embedded and how
 * an operator can pre-seed an air-gapped host.
 */
export async function resolvePayload(options: PayloadStoreOptions = {}): Promise<ResolvedPayload> {
  const env = options.env ?? process.env;
  const explicit = env.SCIENCE_AGENT_PAYLOAD_DIR?.trim();
  if (explicit) {
    const root = resolve(explicit);
    if (!(await isDirectory(root))) {
      throw new Error(`SCIENCE_AGENT_PAYLOAD_DIR points at ${root}, which is not a directory.`);
    }
    return { manifest: await readManifest(root), root };
  }

  const containerPath = resolve(options.containerPath ?? process.execPath);
  const locator = await readPayloadLocator(containerPath);
  if (!locator) {
    throw new Error(
      `${containerPath} has no embedded runtime payload.\n`
      + "Run the released single-file binary, or set SCIENCE_AGENT_PAYLOAD_DIR to an extracted payload.",
    );
  }

  const root = join(payloadCacheRoot(env), locator.id);
  if (!(await isDirectory(root))) {
    await extractPayload(containerPath, locator, root, options.onProgress);
  }
  return { manifest: await readManifest(root), root };
}
