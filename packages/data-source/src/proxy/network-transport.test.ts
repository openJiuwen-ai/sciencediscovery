// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:st", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { proxyProcessEnvironment, resolveRoute, withProxyFetch, redactNetworkError } from "@sciencediscovery/network";

test("routes preserve explicit policy, bypass loopback and never expose error credentials", () => {
  const env = { http_proxy: "http://user:secret@proxy:8080", HTTPS_PROXY: "socks5://proxy:1080", no_proxy: "internal.test,[::1]" };
  assert.deepEqual(resolveRoute("http://external.test", { mode: "environment" }, env), { mode: "url", url: env.http_proxy });
  assert.deepEqual(resolveRoute("https://external.test", { mode: "environment" }, env), { mode: "url", url: env.HTTPS_PROXY });
  for (const host of ["localhost", "127.0.0.2", "[::1]", "[::ffff:127.0.0.1]", "internal.test"]) {
    assert.deepEqual(resolveRoute(`http://${host}`, { mode: "environment" }, env), { mode: "direct" });
  }
  assert.deepEqual(resolveRoute("https://example.test", { mode: "direct" }, env), { mode: "direct" });
  assert.throws(() => resolveRoute("https://external.test", { mode: "url", url: "invalid://secret" }), /Proxy URL/);
  assert.equal(proxyProcessEnvironment({ mode: "direct" }, env).HTTPS_PROXY, undefined);
  assert.doesNotMatch(redactNetworkError(new Error("request failed https://user:password@host/path?token=private", { cause: Object.assign(new Error("no route"), { code: "ECONNREFUSED" }) })), /password|private/);
  assert.match(redactNetworkError(Object.assign(new Error("failed"), { code: "ECONNREFUSED" })), /ECONNREFUSED/);
});

for (const scheme of ["http", "socks5"]) test(`actual ${scheme} proxy route handles download without target DNS`, async t => {
  let connections = 0;
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => undefined);
    let stage = scheme === "http" ? 1 : 0;
    socket.on("data", bytes => {
      if (stage === 0) { socket.write(Buffer.from([5,0])); stage = 1; return; }
      if (stage === 1) {
        connections++;
        if (scheme === "http") {
          assert.match(bytes.toString(), /GET http:\/\/external.invalid\/data/);
          socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK"); return;
        }
        else socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,80]));
        stage = 2; return;
      }
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const port = (server.address() as import("node:net").AddressInfo).port;
  const result = await withProxyFetch({ mode: "url", url: `${scheme}://127.0.0.1:${port}` }, async fetch =>
    (await fetch("http://external.invalid/data", { signal: AbortSignal.timeout(3000) })).text());
  assert.equal(result, "OK"); assert.equal(connections, 1);
});
