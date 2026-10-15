// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createTest } from "../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });

test("MCP fault proxy isolates upstream sockets and never replays tool POSTs", async t => {
  const sockets = [];
  const bodies = [];
  const target = createServer(async (request, response) => {
    sockets.push(request.socket);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks).toString());
    if (request.url === "/reset") { request.socket.destroy(); return; }
    response.end("ok");
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  t.after(() => { target.closeAllConnections(); target.close(); });
  const proxy = spawn(process.execPath, [fileURLToPath(new URL("../test/fixtures/swarm-mcp-fault-proxy.mjs", import.meta.url))], {
    env: { ...process.env, E2E_MCP_PROXY_PORT: "0", E2E_MCP_PROXY_TARGET: `http://127.0.0.1:${target.address().port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(proxy, "exit");
  t.after(async () => { proxy.kill(); await exited; });
  let diagnostics = "";
  proxy.stderr.on("data", chunk => { diagnostics += chunk; });
  const origin = await new Promise((resolve, reject) => {
    let output = "";
    proxy.once("error", reject);
    proxy.once("exit", () => reject(new Error("Proxy exited before listening")));
    proxy.stdout.on("data", chunk => {
      output += chunk;
      const match = /listening on (127\.0\.0\.1:\d+)/.exec(output);
      if (match) resolve(`http://${match[1]}`);
    });
  });
  const post = (path, body) => fetch(`${origin}${path}`, { method: "POST", body });
  for (const body of ["first", "second"]) {
    const response = await post("/mcp/run", body);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  }
  assert.notEqual(sockets[0], sockets[1], "Parallel task calls must not inherit a closing idle upstream socket");
  const failed = await post("/reset", "uncertain");
  assert.equal(failed.status, 502);
  await failed.text();
  assert.deepEqual(bodies, ["first", "second", "uncertain"], "Uncertain tool POST must be forwarded exactly once");
  assert.match(diagnostics, /forwarding failed/);
  const injected = JSON.stringify({ method: "tools/call", params: { arguments: { _sd_run: "test-run", command: "printf 'E2E_MCP_HTTP_503_test'" } } });
  assert.equal((await post("/mcp/run", injected)).status, 503);
  assert.equal(bodies.length, 3, "Injected fault must not dispatch upstream");
  assert.equal((await post("/mcp/run", injected)).status, 200);
  assert.equal(bodies.length, 4);
});
