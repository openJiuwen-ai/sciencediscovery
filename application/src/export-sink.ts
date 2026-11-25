// Streaming writer for study-package exports.
//
// A package can be several GiB; `sd-shell:export-write` used to take the whole
// archive as one ArrayBuffer, which made the renderer hold it and the main
// process copy it again. The streaming channels keep one file descriptor open
// per destination token and append each chunk as it arrives, so the peak is one
// chunk on each side.
//
// The bytes go to a sibling temporary file and only `end` renames it onto the
// destination: the save dialog asks whether to replace an existing archive, and a
// save that fails at 80% must not destroy the file the user chose to keep
// (#1216 review 2). `abort` removes the temporary and leaves the destination
// untouched. Pure class over an injected fs, so the sequencing is unit-tested
// without a host.

import { closeSync, openSync, renameSync, rmSync, writeSync } from "node:fs";

export interface ExportSinkIo {
  open: (path: string) => number;
  write: (handle: number, bytes: Uint8Array) => number;
  close: (handle: number) => void;
  remove: (path: string) => void;
  rename: (from: string, to: string) => void;
}

const NODE_IO: ExportSinkIo = {
  open: (path) => openSync(path, "w"),
  write: (handle, bytes) => writeSync(handle, bytes),
  close: (handle) => { closeSync(handle); },
  remove: (path) => { rmSync(path, { force: true }); },
  rename: (from, to) => { renameSync(from, to); },
};

/** The temporary a destination token streams into before it is committed. */
function partPath(path: string, token: string): string {
  const tag = token.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "export";
  return `${path}.${tag}.part`;
}

export class ExportSinks {
  private readonly open = new Map<string, { handle: number; path: string; part: string; bytes: number }>();
  private readonly io: ExportSinkIo;

  constructor(io: ExportSinkIo = NODE_IO) {
    this.io = io;
  }

  /** Open the temporary that will become `path` on `end`. A token that is still
   *  streaming is aborted, never committed: reusing a live token must not publish a
   *  truncated archive over the destination (#1216 review 3). */
  begin(token: string, path: string): void {
    if (this.open.has(token)) this.abort(token);
    const part = partPath(path, token);
    this.open.set(token, { handle: this.io.open(part), path, part, bytes: 0 });
  }

  /** Append one chunk. An unknown token is an error, not a silent no-op: the
   *  renderer only ever names a token this process issued. */
  write(token: string, bytes: Uint8Array): void {
    const sink = this.open.get(token);
    if (!sink) throw new Error("导出流无效，请重新选择保存位置。");
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const remaining = bytes.subarray(offset);
        const written = this.io.write(sink.handle, remaining);
        if (!Number.isInteger(written) || written <= 0 || written > remaining.byteLength) {
          throw new Error("无法完整写入导出文件，未保存。");
        }
        offset += written;
        sink.bytes += written;
      }
    } catch (error) {
      this.abort(token);
      throw error;
    }
  }

  /** Close the temporary and move it onto the destination. The caller owns the
   *  "written" flag so a failed close or rename cannot report a saved archive.
   *  On failure the entry stays in the map, so `abort` can still remove the
   *  temporary (#1216 F4). */
  end(token: string): number {
    const sink = this.open.get(token);
    if (!sink) return 0;
    this.io.close(sink.handle);
    // Nothing arrived: drop the empty temporary and refuse. Returning 0 here looked
    // like "no such token" to the handler, which then still recorded a written
    // destination and a zero-byte history row for a save that never happened
    // (#1216 review 4).
    if (sink.bytes === 0) {
      this.open.delete(token);
      try { this.io.remove(sink.part); } catch { /* already gone */ }
      throw new Error("导出数据为空，未保存。");
    }
    this.io.rename(sink.part, sink.path);
    this.open.delete(token);
    return sink.bytes;
  }

  /** Close and delete the temporary; the destination keeps whatever it had. */
  abort(token: string): void {
    const sink = this.open.get(token);
    if (!sink) return;
    this.open.delete(token);
    try { this.io.close(sink.handle); } catch { /* already gone */ }
    try { this.io.remove(sink.part); } catch { /* already gone */ }
  }

  /** Drop every open stream: a renderer that reloaded or crashed will never send
   *  its own abort, so each temporary must go with it (#1216 F5). */
  abortAll(): void {
    for (const token of [...this.open.keys()]) this.abort(token);
  }

  has(token: string): boolean {
    return this.open.has(token);
  }

  get size(): number {
    return this.open.size;
  }
}
