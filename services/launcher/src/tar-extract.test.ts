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

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";

import { extractTar, safePayloadPath } from "./tar-extract.js";

const execFileAsync = promisify(execFile);

describe("payload tar extraction", () => {
  let workspace = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "science-agent-tar-"));
  });

  after(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  /**
   * Build a real archive with system tar so the reader is exercised against
   * the same producer the packaging script uses, long names included.
   */
  async function buildArchive(name: string, format: "gnu" | "posix"): Promise<{ archive: string; source: string }> {
    const source = join(workspace, `${name}-source`);
    const deepDirectory = join(source, "a".repeat(80), "b".repeat(80));
    await mkdir(deepDirectory, { recursive: true });
    await writeFile(join(source, "manifest.json"), '{"formatVersion":1}\n');
    await writeFile(join(deepDirectory, "nested.txt"), "nested payload file\n");
    // Real payloads carry zero-byte regular files (markers, empty
    // __init__.py); they must survive extraction.
    await writeFile(join(source, "empty.txt"), "");
    await writeFile(join(deepDirectory, "empty-nested"), "");
    await mkdir(join(source, "empty-dir"), { recursive: true });
    await writeFile(join(source, "runnable"), "#!/bin/sh\nexit 0\n");
    await chmod(join(source, "runnable"), 0o755);
    await mkdir(join(source, "links"), { recursive: true });
    await symlink("../manifest.json", join(source, "links", "manifest-link"));
    // pnpm hard-links duplicate package files, so tar records the repeats as
    // link entries rather than second copies.
    await link(join(source, "manifest.json"), join(source, "links", "manifest-hardlink"));

    const archive = join(workspace, `${name}.tar`);
    await execFileAsync("tar", [
      "--create", `--format=${format}`, "--file", archive, "--directory", source, ".",
    ]);
    return { archive, source };
  }

  for (const format of ["gnu", "posix"] as const) {
    test(`extracts a ${format} archive with long names, modes and symlinks`, async () => {
      const { archive } = await buildArchive(format, format);
      const destination = join(workspace, `${format}-out`);
      await extractTar(createReadStream(archive), destination);

      assert.equal(await readFile(join(destination, "manifest.json"), "utf8"), '{"formatVersion":1}\n');
      const nested = join(destination, "a".repeat(80), "b".repeat(80), "nested.txt");
      assert.equal(await readFile(nested, "utf8"), "nested payload file\n");
      // Zero-byte entries: regular files must exist as empty files, and a
      // directory entry (always size 0 in tar) must stay a directory.
      const emptyFile = await stat(join(destination, "empty.txt"));
      assert.ok(emptyFile.isFile(), "zero-byte regular file must be created");
      assert.equal(emptyFile.size, 0);
      assert.equal((await stat(join(destination, "a".repeat(80), "b".repeat(80), "empty-nested"))).size, 0);
      assert.ok((await stat(join(destination, "empty-dir"))).isDirectory(), "empty directory entry must stay a directory");
      // The executable bit has to survive: the payload carries node, python
      // and micromamba binaries that serve execs directly.
      assert.equal((await lstat(join(destination, "runnable"))).mode & 0o777, 0o755);
      assert.equal(await readlink(join(destination, "links", "manifest-link")), "../manifest.json");
      const hardLink = join(destination, "links", "manifest-hardlink");
      assert.equal(await readFile(hardLink, "utf8"), '{"formatVersion":1}\n');
      assert.equal((await stat(hardLink)).ino, (await stat(join(destination, "manifest.json"))).ino);
    });
  }

  test("rejects an entry that escapes the destination", () => {
    assert.throws(() => safePayloadPath("/tmp/dest", "../escape"), /unsafe payload path/);
    assert.throws(() => safePayloadPath("/tmp/dest", "/etc/passwd"), /unsafe payload path/);
    assert.throws(() => safePayloadPath("/tmp/dest", "nested/../../escape"), /unsafe payload path/);
    assert.equal(safePayloadPath("/tmp/dest", "nested/file"), "/tmp/dest/nested/file");
  });

  test("reports a truncated archive instead of writing a partial tree", async () => {
    const { archive } = await buildArchive("truncated", "gnu");
    const bytes = await readFile(archive);
    const destination = join(workspace, "truncated-out");
    await assert.rejects(
      extractTar(Readable.from([bytes.subarray(0, 512 + 100)]), destination),
      /Truncated payload/,
    );
  });

  test("rejects an unsupported entry type", async () => {
    // A FIFO header (type flag "6") stands in for anything the payload should
    // never contain; silently skipping it would produce a broken runtime.
    const header = Buffer.alloc(512);
    header.write("fifo", 0);
    header.write("0000644\0", 100);
    header.write("00000000000\0", 124);
    header.write("6", 156);
    header.write("ustar\0" + "00", 257);
    await assert.rejects(
      extractTar(Readable.from([header]), join(workspace, "fifo-out")),
      /Unsupported payload entry type/,
    );
  });
});
