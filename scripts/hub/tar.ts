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
 * The tar boundary for the external-skill snapshot.
 *
 * This used to be a hand-written ustar reader and writer. A compliance scan
 * compared it with existing tar implementations and could not separate our
 * file from theirs, which is expected: the format is fixed offsets and an
 * octal checksum, so every implementation looks alike. Rather than argue a
 * similarity finding, the archive work now goes through `tar-stream` (MIT,
 * listed in the third-party notice), and this module keeps only the two
 * properties the snapshot depends on: paths are validated and the bytes are
 * deterministic.
 */
import { extract, pack } from "tar-stream";

export interface TarEntry {
  bytes: Uint8Array;
  path: string;
}

/** Reject anything a snapshot must never contain, or that escapes its root. */
function safePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error(`unsafe tar path: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`unsafe tar path: ${path}`);
  }
  return path;
}

/**
 * Pack entries in path order with every varying header field pinned.
 *
 * A rebuild must produce the same bytes, so mtime, uid, gid and mode are
 * fixed; `tar-stream` writes the archive and this collects it.
 */
export async function packTar(entries: TarEntry[]): Promise<Uint8Array> {
  const sorted = [...entries].toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  const archive = pack();
  const chunks: Buffer[] = [];
  archive.on("data", (chunk) => {
    chunks.push(chunk as Buffer);
  });
  const finished = new Promise<void>((resolve, reject) => {
    archive.on("end", resolve);
    archive.on("error", reject);
  });
  for (const entry of sorted) {
    archive.entry(
      {
        name: safePath(entry.path),
        size: entry.bytes.byteLength,
        mode: 0o644,
        uid: 0,
        gid: 0,
        mtime: new Date(0),
        type: "file",
      },
      Buffer.from(entry.bytes),
    );
  }
  archive.finalize();
  await finished;
  return new Uint8Array(Buffer.concat(chunks));
}

/** Read the regular files of a tar archive, refusing any unsafe path. */
export async function unpackTar(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const archive = extract();
  const finished = new Promise<void>((resolve, reject) => {
    archive.on("finish", resolve);
    archive.on("error", (error: Error) => reject(new Error(`unreadable tar archive: ${error.message}`)));
  });
  archive.on("entry", (header, stream, next) => {
    if (header.type !== "file") {
      stream.resume();
      stream.on("end", next);
      return;
    }
    let path: string;
    try {
      path = safePath(header.name);
    } catch (error) {
      stream.resume();
      archive.destroy(error as Error);
      return;
    }
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(chunk as Buffer);
    });
    stream.on("end", () => {
      files.set(path, new Uint8Array(Buffer.concat(chunks)));
      next();
    });
    stream.resume();
  });
  archive.end(Buffer.from(bytes));
  await finished;
  return files;
}
