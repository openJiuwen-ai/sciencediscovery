// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import { ExportSinks, type ExportSinkIo } from "../src/export-sink.ts";

function recordingIo() {
  const events: string[] = [];
  let nextHandle = 0;
  const io: ExportSinkIo = {
    open: (path) => { events.push(`open:${path}`); nextHandle += 1; return nextHandle; },
    write: (handle, bytes) => { events.push(`write:${handle}:${bytes.byteLength}`); },
    close: (handle) => { events.push(`close:${handle}`); },
    remove: (path) => { events.push(`remove:${path}`); },
  };
  return { io, events };
}

test("chunks are appended to one open destination", () => {
  const { io, events } = recordingIo();
  const sinks = new ExportSinks(io);
  sinks.begin("t1", "C:/exports/a.sdresearch");
  sinks.write("t1", new Uint8Array([1, 2, 3]));
  sinks.write("t1", new Uint8Array([4, 5]));
  const written = sinks.end("t1");
  assert.deepEqual(events, ["open:C:/exports/a.sdresearch", "write:1:3", "write:1:2", "close:1"]);
  assert.equal(written, 5, "the history row needs the size the stream wrote");
  assert.equal(sinks.size, 0);
});

test("abort closes and deletes the partial archive", () => {
  const { io, events } = recordingIo();
  const sinks = new ExportSinks(io);
  sinks.begin("t1", "C:/exports/a.sdresearch");
  sinks.write("t1", new Uint8Array([1]));
  sinks.abort("t1");
  assert.deepEqual(events, ["open:C:/exports/a.sdresearch", "write:1:1", "close:1", "remove:C:/exports/a.sdresearch"]);
  assert.equal(sinks.has("t1"), false);
});

test("a chunk for a destination this process never opened is refused", () => {
  const { io } = recordingIo();
  const sinks = new ExportSinks(io);
  assert.throws(() => sinks.write("forged", new Uint8Array([1])), /导出流无效/);
});

test("reusing a token closes the previous handle before truncating", () => {
  const { io, events } = recordingIo();
  const sinks = new ExportSinks(io);
  sinks.begin("t1", "C:/exports/a.sdresearch");
  sinks.begin("t1", "C:/exports/a.sdresearch");
  assert.deepEqual(events, ["open:C:/exports/a.sdresearch", "close:1", "open:C:/exports/a.sdresearch"]);
  assert.equal(sinks.size, 1);
});

test("a failed close keeps the sink so the partial archive can still be deleted", () => {
  // #1216 F4: deleting the entry before closing made abort() a no-op after a close error.
  const events: string[] = [];
  let handle = 0;
  const io: ExportSinkIo = {
    open: (path) => { events.push(`open:${path}`); handle += 1; return handle; },
    write: () => undefined,
    close: (id) => { events.push(`close:${id}`); throw Object.assign(new Error("EIO"), { code: "EIO" }); },
    remove: (path) => { events.push(`remove:${path}`); },
  };
  const sinks = new ExportSinks(io);
  sinks.begin("t1", "C:/exports/a.sdresearch");
  assert.throws(() => sinks.end("t1"), /EIO/);
  assert.equal(sinks.has("t1"), true, "the entry survives a failed close");
  sinks.abort("t1");
  assert.deepEqual(events, ["open:C:/exports/a.sdresearch", "close:1", "close:1", "remove:C:/exports/a.sdresearch"]);
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
    "open:C:/exports/a.sdresearch", "open:C:/exports/b.sdresearch",
    "close:1", "remove:C:/exports/a.sdresearch", "close:2", "remove:C:/exports/b.sdresearch",
  ]);
  assert.equal(sinks.size, 0);
});
