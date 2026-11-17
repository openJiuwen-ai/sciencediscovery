// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import { canStreamExport, writeExportStream, type ExportShellBridge } from "../src/app/export-bridge.js";

function streamOf(chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
}

function recordingBridge(failAt?: number) {
  const events: string[] = [];
  const bytes: number[] = [];
  let chunks = 0;
  const bridge: ExportShellBridge = {
    saveDialog: async () => ({ canceled: true, token: null }),
    write: async () => ({ ok: true }),
    streamBegin: async () => { events.push("begin"); return { ok: true }; },
    streamChunk: async (_token, data) => {
      chunks += 1;
      if (failAt === chunks) throw new Error("disk full");
      events.push(`chunk:${data.byteLength}`);
      bytes.push(...new Uint8Array(data));
      return { ok: true };
    },
    streamEnd: async () => { events.push("end"); return { ok: true }; },
    streamAbort: async () => { events.push("abort"); return { ok: true }; },
    showInFolder: async () => ({ ok: true }),
    downloadsDir: async () => "",
  };
  return { bridge, events, bytes };
}

test("the archive crosses the shell boundary chunk by chunk", async () => {
  // #1211 F2: the shell used to receive one ArrayBuffer holding the whole archive.
  const { bridge, events, bytes } = recordingBridge();
  await writeExportStream(bridge, "token-1", streamOf([[1, 2], [3, 4, 5]]), { recordId: "r1" });
  assert.deepEqual(events, ["begin", "chunk:2", "chunk:3", "end"]);
  assert.deepEqual(bytes, [1, 2, 3, 4, 5]);
});

test("a failed chunk aborts the destination and cancels the response body", async () => {
  // #1216 F3: releasing the lock only unlocks; the server keeps producing into a body
  // nobody reads, so the failure path has to cancel it.
  const { bridge, events } = recordingBridge(2);
  const reads: string[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.enqueue(new Uint8Array([2]));
    },
    cancel: () => { reads.push("cancel"); },
  });
  await assert.rejects(writeExportStream(bridge, "token-1", body), /disk full/);
  assert.deepEqual(events, ["begin", "chunk:1", "abort"], "no end after a failure");
  assert.deepEqual(reads, ["cancel"], "the response body is cancelled");
});

test("a shell without the streaming channels is refused rather than silently buffered", async () => {
  const legacy: ExportShellBridge = {
    saveDialog: async () => ({ canceled: true, token: null }),
    write: async () => ({ ok: true }),
    showInFolder: async () => ({ ok: true }),
    downloadsDir: async () => "",
  };
  assert.equal(canStreamExport(legacy), false);
  await assert.rejects(writeExportStream(legacy, "token-1", streamOf([[1]])), /streaming saves/);
});
