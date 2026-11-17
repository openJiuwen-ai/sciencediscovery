// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { savePackageResponse, type SaveHooks } from "../src/research-package/save-stream.js";

const encoder = new TextEncoder();

function recordingHandle() {
  const chunks: Uint8Array[] = [];
  const events: string[] = [];
  const handle = {
    // `createWritable()` hands back a real WritableStream in the browser, so the
    // fixture is one too -- `pipeTo` refuses anything else.
    createWritable: async () => new WritableStream<Uint8Array>({
      write: (chunk) => { events.push("write"); chunks.push(chunk); },
      close: () => { events.push("close"); },
      abort: () => { events.push("abort"); },
    }),
  };
  return { handle, chunks, events };
}

function pickerReturning(handle: unknown, seen: Array<{ suggestedName: string }>) {
  return async (options: { suggestedName: string }) => {
    seen.push(options);
    return handle as never;
  };
}

test("the archive reaches the disk chunk by chunk, not as one buffer", async () => {
  // #1211 F2: `response.blob()` held the whole archive; the body must be piped.
  const { handle, chunks, events } = recordingHandle();
  const seen: Array<{ suggestedName: string }> = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("first-"));
      controller.enqueue(encoder.encode("second"));
      controller.close();
    },
  });
  let opened = 0;
  const outcome = await savePackageResponse(async () => { opened += 1; return new Response(body, { status: 200 }); }, "会话.sdresearch", { picker: pickerReturning(handle, seen) as SaveHooks["picker"] });
  assert.equal(outcome, "saved");
  assert.equal(opened, 1);
  assert.deepEqual(seen.map((item) => item.suggestedName), ["会话.sdresearch"]);
  // Two writes prove the body was forwarded as it arrived; a single write would
  // mean the caller buffered it first.
  assert.deepEqual(chunks.map((chunk) => new TextDecoder().decode(chunk)), ["first-", "second"]);
  assert.deepEqual(events, ["write", "write", "close"]);
});

test("closing the picker cancels without starting the request", async () => {
  let opened = 0;
  const outcome = await savePackageResponse(async () => { opened += 1; return new Response(); }, "a.sdresearch", {
    picker: async () => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); },
  });
  assert.equal(outcome, "cancelled");
  assert.equal(opened, 0, "a cancelled dialog must not export anything");
});

test("a refused export aborts the file instead of leaving a partial archive", async () => {
  const { handle, events } = recordingHandle();
  const seen: Array<{ suggestedName: string }> = [];
  await assert.rejects(
    savePackageResponse(async () => { throw new Error("Research package exceeds the archive size limit"); }, "a.sdresearch", { picker: pickerReturning(handle, seen) as SaveHooks["picker"] }),
    /exceeds the archive size limit/,
  );
  assert.deepEqual(events, ["abort"]);
});

test("a browser without the file picker keeps downloading the whole archive", async () => {
  const saved: Array<{ name: string; text: string }> = [];
  const outcome = await savePackageResponse(async () => new Response("archive-bytes", { status: 200 }), "b.sdresearch", {
    picker: undefined,
    download: (blob, name) => { void blob.text().then((text) => saved.push({ name, text })); },
  });
  assert.equal(outcome, "saved");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(saved.map((item) => item.name), ["b.sdresearch"]);
});
