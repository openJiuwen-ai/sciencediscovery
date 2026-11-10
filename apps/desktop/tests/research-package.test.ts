// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient } from "../src/api/client.js";
import { cancelExport, importPackage, packagePreview, readExportBlob, startCopy, startExport } from "../src/api/research-package.js";

test("package preview preserves scope, options, selected files and authentication", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    assert.equal(url.searchParams.get("sessionId"), "session/1");
    assert.equal(url.searchParams.get("includeFullMemoryGraph"), "0");
    assert.equal(url.searchParams.get("includeFullTrajectory"), "1");
    assert.deepEqual(url.searchParams.getAll("filePath"), ["a b.csv"]);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer local-token");
    return Response.json({ revision: "r1", files: [], omissions: [], estimatedBytes: 0 });
  };
  try { await packagePreview(new ApiClient("local-token"), "p/1", "session/1", "complete", true, false, ["a b.csv"]); } finally { globalThis.fetch = previous; }
});

test("an inspected package imports without uploading its bytes again", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input), "http://localhost").searchParams.get("inspectionChecksum"), "checked/hash");
    assert.equal(init?.body, undefined);
    return Response.json({ importedSessionIds: ["restored"] });
  };
  try { assert.deepEqual(await importPackage(new ApiClient("token"), "p", new Blob(["archive"]), "checked/hash"), { importedSessionIds: ["restored"] }); }
  finally { globalThis.fetch = previous; }
});

test("an expired inspection cache falls back to the original bytes, without retrying other conflicts", async () => {
  const previous = globalThis.fetch;
  const bytes = new Blob(["archive"]);
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    if (++calls === 1) return Response.json({ error: "Inspected package expired; upload it again" }, { status: 409 });
    assert.equal(init?.body, bytes);
    return Response.json({ importedSessionIds: ["restored"] });
  };
  try {
    await importPackage(new ApiClient("token"), "p", bytes, "old"); assert.equal(calls, 2);
    calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ error: "Research package import is already in progress" }, { status: 409 }); };
    await assert.rejects(importPackage(new ApiClient("token"), "p", bytes, "checked"), /already in progress/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});
test("import sends original bytes; branch requests retain boundary and idempotency key", async () => {
  const previous = globalThis.fetch; let calls = 0;
  const bytes = new Blob([new Uint8Array([0, 127, 255])]);
  globalThis.fetch = async (input, init) => {
    calls++;
    if (String(input).endsWith("/import")) { assert.equal(init?.body, bytes); assert.equal(new Headers(init?.headers).get("content-type"), "application/octet-stream"); }
    else if (String(input).endsWith("/conversation-branches")) assert.deepEqual(JSON.parse(String(init?.body)), { requestId: "retry-key", messageId: "reply-2" });
    else { const body = JSON.parse(String(init?.body)); assert.equal(body.revision, "r1"); }
    return Response.json({});
  };
  try {
    const client = new ApiClient("token"); await importPackage(client, "p", bytes); await startCopy(client, "s", "retry-key", "reply-2");
    await startExport(client, "p", { sessionId: "s", revision: "r1", level: "necessary", includeFullTrajectory: false, includeFullMemoryGraph: false });
    assert.equal(calls, 3);
  } finally { globalThis.fetch = previous; }
});

test("cancelExport POSTs to the task's cancel action", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/exports\/task-1\/cancel$/);
    assert.equal(init?.method, "POST");
    return Response.json({ id: "task-1", status: "canceled", filename: "p.sdresearch" });
  };
  try {
    const result = await cancelExport(new ApiClient("token"), "p", "task-1");
    assert.equal(result.status, "canceled");
  } finally { globalThis.fetch = previous; }
});

test("readExportBlob downloads the completed archive bytes", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /\/exports\/task-1\/download$/);
    return new Response(new Uint8Array([1, 2, 3]));
  };
  try {
    const blob = await readExportBlob(new ApiClient("token"), "p", { id: "task-1", status: "completed", filename: "p.sdresearch" });
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
  } finally { globalThis.fetch = previous; }
});
