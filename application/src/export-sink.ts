// Streaming writer for study-package exports.
//
// A package can be several GiB; `sd-shell:export-write` used to take the whole
// archive as one ArrayBuffer, which made the renderer hold it and the main
// process copy it again. The streaming channels keep one file descriptor open
// per destination token and append each chunk as it arrives, so the peak is one
// chunk on each side.
//
// `abort` removes the partial file: a failed or cancelled save must not leave a
// truncated archive behind for the next download to mistake for a complete one.
// Pure class over an injected fs, so the sequencing is unit-tested without a
// host.

import { closeSync, openSync, rmSync, writeSync } from "node:fs";

export interface ExportSinkIo {
  open: (path: string) => number;
  write: (handle: number, bytes: Uint8Array) => void;
  close: (handle: number) => void;
  remove: (path: string) => void;
}

const NODE_IO: ExportSinkIo = {
  open: (path) => openSync(path, "w"),
  write: (handle, bytes) => { writeSync(handle, bytes); },
  close: (handle) => { closeSync(handle); },
  remove: (path) => { rmSync(path, { force: true }); },
};

export class ExportSinks {
  private readonly open = new Map<string, { handle: number; path: string; bytes: number }>();
  private readonly io: ExportSinkIo;

  constructor(io: ExportSinkIo = NODE_IO) {
    this.io = io;
  }

  /** Truncate (or create) the destination and keep it open for chunks. */
  begin(token: string, path: string): void {
    if (this.open.has(token)) this.end(token);
    this.open.set(token, { handle: this.io.open(path), path, bytes: 0 });
  }

  /** Append one chunk. An unknown token is an error, not a silent no-op: the
   *  renderer only ever names a token this process issued. */
  write(token: string, bytes: Uint8Array): void {
    const sink = this.open.get(token);
    if (!sink) throw new Error("导出流无效，请重新选择保存位置。");
    this.io.write(sink.handle, bytes);
    sink.bytes += bytes.byteLength;
  }

  /** Close the file and report how much was written, so the caller can record
   *  the history row. The caller owns the "written" flag so a failed close
   *  cannot report a saved archive. */
  end(token: string): number {
    const sink = this.open.get(token);
    if (!sink) return 0;
    this.open.delete(token);
    this.io.close(sink.handle);
    return sink.bytes;
  }

  /** Close and delete the partial archive. */
  abort(token: string): void {
    const sink = this.open.get(token);
    if (!sink) return;
    this.open.delete(token);
    try { this.io.close(sink.handle); } catch { /* already gone */ }
    try { this.io.remove(sink.path); } catch { /* already gone */ }
  }

  has(token: string): boolean {
    return this.open.has(token);
  }

  get size(): number {
    return this.open.size;
  }
}
