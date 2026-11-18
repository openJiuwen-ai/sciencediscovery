// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExportSinks, type ExportSinkIo } from "../src/export-sink.ts";

function recordingIo() {
  const events: string[] = [];
  let nextHandle = 0;
  const io: ExportSinkIo = {
    open: (path) => { events.push(`open:${path}`); nextHandle += 1; return nextHandle; },
    write: (handle, bytes) => { events.push(`write:${handle}:${bytes.byteLength}`); },
    close: (handle) => { events.push(`close:${handle}`); },
    remove: (path) => { events.push(`remove:${path}`); },
    rename: (from, to) => { events.push(`rename:${from}->${to}`); },
  };
  return { io, events };
}

test("chunks are appended to one open temporary and renamed onto the destination", () => {
  const { io, events } = recordingIo();
  const sinks = new ExportSinks(io);
  sinks.begin("t1", "C:/exports/a.sdresearch");
  sinks.write("t1", new Uint8Array([1, 2, 3]));
  sinks.write("t1", new Uint8Array([4, 5]));
  const written = sinks.end("t1");
  assert.deepEqual(events, [
    "open:C:/exports/a.sdresearch.t1.part",
    "write:1:3",
    "write:1:2",
    "close:1",
    "rename:C:/exports/a.sdresearch.t1.part->C:/exports/a.sdresearch",
  ]);
  assert.equal(written, 5, "the history row needs the size the stream wrote");
  assert.equal(sinks.size, 0);
});

test("abort removes the temporary and never touches the destination", () => {
  const { io, events } = recordingIo();
  const sinks = new ExportSinks(io);
  sinks.begin("t1", "C:/exports/a.sdresearch");
  sinks.write("t1", new Uint8Array([1]));
  sinks.abort("t1");
  assert.deepEqual(events, [
    "open:C:/exports/a.sdresearch.t1.part",
    "write:1:1",
    "close:1",
    "remove:C:/exports/a.sdresearch.t1.part",
  ]);
  assert.equal(sinks.has("t1"), false);
});

test("a chunk for a destination this process never opened is refused", () => {
  const { io } = recordingIo();
  const sinks = new ExportSinks(io);
  assert.throws(() => sinks.write("forged", new Uint8Array([1])), /导出流无效/);
});

test("reusing a live token aborts the previous stream instead of publishing it", () => {
  // #1216 review 3: `begin` used to `end()` the previous stream, which now renames - so a
  // reused token would publish a truncated archive over the destination.
  const { io, events } = recordingIo();
  const sinks = new ExportSinks(io);
  sinks.begin("t1", "C:/exports/a.sdresearch");
  sinks.write("t1", new Uint8Array([1, 2]));
  sinks.begin("t1", "C:/exports/a.sdresearch");
  assert.deepEqual(events, [
    "open:C:/exports/a.sdresearch.t1.part",
    "write:1:2",
    "close:1",
    "remove:C:/exports/a.sdresearch.t1.part",
    "open:C:/exports/a.sdresearch.t1.part",
  ]);
  assert.equal(sinks.size, 1);
});

test("a failed close keeps the sink so the temporary can still be deleted", () => {
  // #1216 F4: deleting the entry before closing made abort() a no-op after a close error.
  const events: string[] = [];
  let handle = 0;
  const io: ExportSinkIo = {
    open: (path) => { events.push(`open:${path}`); handle += 1; return handle; },
    write: () => undefined,
    close: (id) => { events.push(`close:${id}`); throw Object.assign(new Error("EIO"), { code: "EIO" }); },
    remove: (path) => { events.push(`remove:${path}`); },
    rename: (from, to) => { events.push(`rename:${from}->${to}`); },
  };
  const sinks = new ExportSinks(io);
  sinks.begin("t1", "C:/exports/a.sdresearch");
  assert.throws(() => sinks.end("t1"), /EIO/);
  assert.equal(sinks.has("t1"), true, "the entry survives a failed close");
  sinks.abort("t1");
  assert.deepEqual(events, [
    "open:C:/exports/a.sdresearch.t1.part", "close:1", "close:1", "remove:C:/exports/a.sdresearch.t1.part",
  ]);
  assert.equal(sinks.size, 0);
});

test("abortAll drops every open stream when the renderer disappears", () => {
  // #1216 F5: a reloaded or crashed renderer never sends its own abort.
  const { io, events } = recordingIo();
  const sinks = new ExportSinks(io);
  sinks.begin("t1", "C:/exports/a.sdresearch");
  sinks.begin("t2", "C:/exports/b.sdresearch");
  sinks.abortAll();
  assert.deepEqual(events, [
    "open:C:/exports/a.sdresearch.t1.part", "open:C:/exports/b.sdresearch.t2.part",
    "close:1", "remove:C:/exports/a.sdresearch.t1.part",
    "close:2", "remove:C:/exports/b.sdresearch.t2.part",
  ]);
  assert.equal(sinks.size, 0);
});

test("an empty stream is refused instead of published as a finished export", () => {
  // #1216 review 4: a 0-byte stream must not replace the destination, and it must not
  // read as a completed save either — `end` throws, so the IPC handler cannot record a
  // written destination or a `bytes: 0` history row for it.
  const { io, events } = recordingIo();
  const sinks = new ExportSinks(io);
  sinks.begin("t1", "C:/exports/a.sdresearch");
  assert.throws(() => sinks.end("t1"), /导出数据为空/u);
  assert.deepEqual(events, [
    "open:C:/exports/a.sdresearch.t1.part",
    "close:1",
    "remove:C:/exports/a.sdresearch.t1.part",
  ], "no rename when nothing was written");
  assert.equal(sinks.size, 0, "the token is forgotten, so a retry opens a fresh temporary");
});

test("an aborted save over an existing destination leaves the old bytes", async () => {
  // #1216 review 2: the save dialog offers to replace an archive, so a failure must not
  // consume it.
  const root = await mkdtemp(join(tmpdir(), "export-sink-"));
  try {
    const destination = join(root, "evidence.sdresearch");
    await writeFile(destination, "the archive the user already had");
    const sinks = new ExportSinks();
    sinks.begin("token-1", destination);
    sinks.write("token-1", new Uint8Array([1, 2, 3]));
    sinks.abort("token-1");
    assert.equal(await readFile(destination, "utf8"), "the archive the user already had");
    assert.equal(existsSync(`${destination}.token-1.part`), false, "the temporary is gone");

    // A completed save replaces it, and leaves no temporary behind.
    sinks.begin("token-1", destination);
    sinks.write("token-1", new Uint8Array([9, 9]));
    sinks.end("token-1");
    assert.deepEqual([...await readFile(destination)], [9, 9]);
    assert.equal(existsSync(`${destination}.token-1.part`), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
