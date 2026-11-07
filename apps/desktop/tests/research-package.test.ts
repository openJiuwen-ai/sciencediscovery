// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient } from "../src/api/client.js";
import { importPackage, packagePreview, startCopy, startExport } from "../src/api/research-package.js";

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
