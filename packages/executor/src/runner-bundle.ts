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
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, posix, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * The runner the product deploys to an SSH host is the runner it ships with:
 * its built JavaScript plus the built JavaScript of the workspace packages it
 * imports. None of those packages has a third-party dependency, so the whole
 * deployable tree is a few hundred kilobytes of `dist/` and can be shipped over
 * the same SSH session that starts it — no package manager runs on the target.
 */
const RUNNER_PACKAGE = "@sciencediscovery/runner";
const WORKSPACE_SCOPE = "@sciencediscovery/";

/**
 * The runner keeps its repository-relative place in the deployed tree because
 * it resolves its own data files against the directory three levels above its
 * built code. Its dependencies go under `node_modules/` beside it, which is
 * where Node's resolver looks when the runner imports them by name.
 */
const RUNNER_BUNDLE_PREFIX = "services/runner";

/** Directories of a package that a running runner actually reads. */
const PACKAGE_DIRECTORIES = new Map([[RUNNER_PACKAGE, ["dist", "workloads"]]]);
const DEFAULT_PACKAGE_DIRECTORIES = ["dist"];

/** The runner entry point, relative to the deploy root. */
export const RUNNER_BUNDLE_ENTRY = `${RUNNER_BUNDLE_PREFIX}/dist/server.js`;

export interface RunnerBundle {
  /** gzip-compressed tar of the deployable tree, rooted at `node_modules/`. */
  archive: Buffer;
  /** sha256 of `archive`; identifies which build a host already has. */
  id: string;
  /** Total uncompressed size, for operator-facing messages. */
  uncompressedBytes: number;
}

interface BundleFile {
  content: Buffer;
  path: string;
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0").slice(-(width - 1)) + "\0";
}

/**
 * One ustar entry. Every field a real archiver would take from the filesystem
 * (owner, timestamps, permissions beyond the executable bit) is pinned to a
 * constant so the same sources always produce byte-identical archives, which is
 * what lets the deployment id double as an "already installed" check.
 */
function tarEntry(file: BundleFile): Buffer {
  const header = Buffer.alloc(512);
  let name = file.path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const split = name.lastIndexOf("/", name.length - 100);
    if (split < 0) throw new Error(`Runner bundle path is too long for tar: ${file.path}`);
    prefix = name.slice(0, split);
    name = name.slice(split + 1);
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) {
      throw new Error(`Runner bundle path is too long for tar: ${file.path}`);
    }
  }
  header.write(name, 0, 100, "utf8");
  header.write(octal(0o644, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(file.content.length, 12), 124, 12, "ascii");
  header.write(octal(0, 12), 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (file.content.length % 512)) % 512);
  return Buffer.concat([header, file.content, padding]);
}

function tarArchive(files: BundleFile[]): Buffer {
  return Buffer.concat([
    ...files.toSorted((left, right) => left.path.localeCompare(right.path)).map(tarEntry),
    Buffer.alloc(1024),
  ]);
}

/**
 * Walk up from a resolved entry point to the directory whose `package.json`
 * declares `name`. Resolving the entry rather than `<name>/package.json` is
 * deliberate: these packages export only their root, so a subpath resolution
 * would be refused by their `exports` map.
 */
async function packageRoot(entryPath: string, name: string): Promise<string> {
  let directory = dirname(entryPath);
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: string };
      if (manifest.name === name) return directory;
    } catch {
      // Not this directory's manifest; keep walking toward the package root.
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Could not locate the ${name} package root`);
    directory = parent;
  }
}

async function collectFiles(root: string, subdirectory: string, prefix: string): Promise<BundleFile[]> {
  const entries = await readdir(join(root, subdirectory), { recursive: true, withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  const files: BundleFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    // SEA artifacts contain this tree themselves; never recursively embed them.
    if (relative(join(root, subdirectory), absolute).split(sep)[0] === "sea") continue;
    // Types, source maps and the runner's own test files are never loaded by a
    // running runner; leaving them out keeps the SSH transfer small.
    if (/\.(?:d\.ts|map)$/.test(entry.name) || /\.test\.js$/.test(entry.name)) continue;
    files.push({
      content: await readFile(absolute),
      path: posix.join(prefix, subdirectory, relative(join(root, subdirectory), absolute).split(sep).join("/")),
    });
  }
  return files;
}

/**
 * Pack the local runner and its workspace dependencies into one archive.
 *
 * The result is deterministic, so a host that already reports this bundle's id
 * is left untouched on reconnect.
 */
export async function packRunnerBundle(from = import.meta.url): Promise<RunnerBundle> {
  const files: BundleFile[] = [];
  const visited = new Set<string>();
  const pending: Array<{ name: string; resolveFrom: string }> = [
    { name: RUNNER_PACKAGE, resolveFrom: from },
  ];
  while (pending.length) {
    const { name, resolveFrom } = pending.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const root = await packageRoot(createRequire(resolveFrom).resolve(name), name);
    const manifestSource = await readFile(join(root, "package.json"), "utf8");
    const prefix = name === RUNNER_PACKAGE ? RUNNER_BUNDLE_PREFIX : `node_modules/${name}`;
    files.push({ content: Buffer.from(manifestSource), path: `${prefix}/package.json` });
    // Package-root JSON beside the manifest is data the built code imports
    // (the external URL configuration is one), so it travels with the package.
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "package.json") continue;
      files.push({ content: await readFile(join(root, entry.name)), path: `${prefix}/${entry.name}` });
    }
    for (const directory of PACKAGE_DIRECTORIES.get(name) ?? DEFAULT_PACKAGE_DIRECTORIES) {
      files.push(...await collectFiles(root, directory, prefix));
    }
    const manifest = JSON.parse(manifestSource) as { dependencies?: Record<string, string> };
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (dependency.startsWith(WORKSPACE_SCOPE)) {
        pending.push({ name: dependency, resolveFrom: join(root, "package.json") });
      }
    }
  }
  const archive = gzipSync(tarArchive(files), { level: 9 });
  return {
    archive,
    id: createHash("sha256").update(archive).digest("hex"),
    uncompressedBytes: files.reduce((total, file) => total + file.content.length, 0),
  };
}
