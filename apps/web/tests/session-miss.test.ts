// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { classifySessionPollMiss, sessionMissTarget } from "../src/api/session-miss.js";

test("session miss text keeps the id it names", () => {
  assert.equal(sessionMissTarget("Session not found"), "");
  assert.equal(sessionMissTarget("Session not found: sess-1"), "sess-1");
  assert.equal(sessionMissTarget("Execution not found: exec-9"), undefined);
});

test("a poll miss is stale when that session is still readable, and a different id stays attributed", async () => {
  const client = {
    getSession: async (id: string) => {
      if (id === "gone") throw new Error("Session not found");
      return { id };
    },
  };
  assert.equal((await classifySessionPollMiss(client, "open", new Error("Session not found"))).kind, "stale");
  assert.equal((await classifySessionPollMiss(client, "open", new Error("Session not found: open"))).kind, "stale");
  const record = await classifySessionPollMiss(client, "open", new Error("Execution not found: exec-9"));
  assert.deepEqual(record, { kind: "unrelated" });
  const namedOther = await classifySessionPollMiss(client, "open", new Error("Session not found: other-id"));
  assert.deepEqual(namedOther, { kind: "other", message: "Session not found: other-id" });
  const gone = await classifySessionPollMiss(client, "gone", new Error("Session not found"));
  assert.deepEqual(gone, { kind: "gone", message: "Session not found: gone" });
  const offline = {
    getSession: async () => { throw new Error("network down"); },
  };
  assert.deepEqual(
    await classifySessionPollMiss(offline, "open", new Error("Session not found")),
    { kind: "other", message: "network down" },
  );
  assert.equal((await classifySessionPollMiss(client, "open", new Error("request rejected"))).kind, "unrelated");
});
