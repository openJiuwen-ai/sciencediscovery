// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunnerClient, RemoteComputeClient } from "@sciencediscovery/executor";
import { ExecutionBlocks } from "@sciencediscovery/governance";
import type { SessionStore } from "../store.js";
import { handleExecutionReadiness } from "./execution-readiness.js";

test("capability routes probe only the named Runner; decisions check session and runner ownership", async () => {
  const queue = new ExecutionBlocks();
  const calls: string[] = [];
  const store = { executionBlocks: queue, getSession: (id: string) => id === "s" ? {} : undefined,
    assertSessionWritable() {}, assertSessionAllowsRunner(_session: string, runner: string) {
      if (runner !== "lab") throw new Error("Runner not allowed");
    },
  } as unknown as SessionStore;
  const local = { executionCapability: async () => { calls.push("local"); return { ready: true }; } } as RunnerClient;
  const remote = { runnerClient: (id: string) => ({ executionCapability: async (refresh: boolean) => {
    calls.push(`${id}:${refresh}`); throw new Error("remote offline");
  } }) } as unknown as RemoteComputeClient;
  const invoke = async (method: string, path: string, body?: unknown) => {
    let status = 0, result: any;
    const response = { writeHead(value: number) { status = value; }, end(value: string) { result = JSON.parse(value); } } as unknown as ServerResponse;
    await handleExecutionReadiness({ method } as IncomingMessage, response, new URL(path, "http://api.test"), store, local, remote, async () => body);
    return { status, body: result };
  };
  assert.equal((await invoke("POST", "/api/runners/lab/execution-capability")).body.connected, false);
  assert.deepEqual(calls, ["lab:true"]);
  const waiting = queue.wait({ sessionId: "s", executionId: "run", runnerId: "local", reason: "missing", alternatives: [{ runnerId: "lab", label: "Lab" }] });
  const block = queue.list("s")[0]!;
  assert.equal((await invoke("GET", "/api/sessions/missing/execution-blocks")).status, 404);
  assert.equal((await invoke("GET", "/api/sessions/s/execution-blocks")).body[0].id, block.id);
  const path = `/api/sessions/s/execution-blocks/${block.id}`;
  assert.equal((await invoke("POST", path, { action: "switch", runnerId: "foreign" })).status, 409);
  assert.equal((await invoke("POST", path, { action: "switch", runnerId: "lab" })).status, 200);
  assert.deepEqual(await waiting, { action: "switch", runnerId: "lab" });
  assert.equal((await invoke("POST", path, { action: "retry" })).status, 409);
});
