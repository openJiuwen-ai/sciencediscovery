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
 * Deterministic digest over a directory tree's paths and contents.
 *
 * The packaging script records this digest for the pinned deer-flow commit,
 * and the first-launch bootstrap recomputes it to prove that a checkout
 * obtained without git — a codeload archive or a manually placed copy — is
 * byte-for-byte the locked submodule version. The digest deliberately covers
 * only entry kind, path and content: archive extraction and manual copies do
 * not preserve permission bits reliably, and git itself does not track empty
 * directories or timestamps.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Collect `kind relative-path content-sha256` lines, sorted by path. */
async function collectEntries(root: string, relative: string, lines: string[]): Promise<void> {
  const directory = relative ? join(root, relative) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    // `.git` only appears in git-produced checkouts, never in archives; it is
    // repository state rather than tree content, so it never enters the digest.
    if (entry.name === ".git") continue;
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await collectEntries(root, entryRelative, lines);
    } else if (entry.isSymbolicLink()) {
      const target = await readlink(join(root, entryRelative));
      lines.push(`L ${entryRelative}\0${createHash("sha256").update(target).digest("hex")}`);
    } else if (entry.isFile()) {
      lines.push(`F ${entryRelative}\0${await fileSha256(join(root, entryRelative))}`);
    } else {
      throw new Error(`Unsupported directory entry while digesting ${root}: ${entryRelative}`);
    }
  }
}

/** Digest a tree as `sha256:<hex>`; two trees match iff their digests match. */
export async function digestTree(root: string): Promise<string> {
  const lines: string[] = [];
  await collectEntries(root, "", lines);
  const hash = createHash("sha256");
  for (const line of lines) hash.update(`${line}\n`, "utf8");
  return `sha256:${hash.digest("hex")}`;
}
