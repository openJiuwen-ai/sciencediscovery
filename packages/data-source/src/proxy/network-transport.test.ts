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
  // A policy that names a proxy but no address is a fault, not permission to go direct.
  assert.throws(() => resolveRoute("https://external.test", { mode: "url", url: "" }, env), /without one/);
  // Only scheme, host and port reach the proxy: anything else would be dropped silently.
  assert.throws(() => resolveRoute("https://external.test", { mode: "url", url: "http://proxy:8080/path" }, env), /host and port/);
  assert.throws(() => resolveRoute("https://external.test", { mode: "url", url: "http://proxy:8080/?q=1" }, env), /host and port/);
  assert.equal(proxyProcessEnvironment({ mode: "direct" }, env).HTTPS_PROXY, undefined);
  // NO_PROXY entries are matched against bare hostnames, so `[::1]` never matches.
  const generated = proxyProcessEnvironment({ mode: "url", url: "http://proxy:8080" }, { no_proxy: "internal.test" });
  assert.equal(generated.NO_PROXY, "internal.test,localhost,127.0.0.1,::1");
  assert.equal(generated.no_proxy, generated.NO_PROXY);
  // A base that already lists the loopback entries (the Windows shell mirror)
  // must not get them duplicated when the child environment is built.
  const mirrored = proxyProcessEnvironment({ mode: "environment" }, { all_proxy: "socks5://127.0.0.1:7890", NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" });
  assert.equal(mirrored.NO_PROXY, "localhost,127.0.0.1,::1");
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
  t.after(() => { for (const socket of sockets) { socket.destroy(); } server.close(); });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const result = await withProxyFetch({ mode: "url", url: `${scheme}://127.0.0.1:${port}` }, async fetch =>
    (await fetch("http://external.invalid/data", { signal: AbortSignal.timeout(3000) })).text());
  assert.equal(result, "OK"); assert.equal(connections, 1);
});

// A 303 switches the method to GET; the original POST body and its framing
// headers must not reach the second hop (undici rejects a GET with a body).
test("a 303 redirect drops the request body and framing headers on the next hop", async t => {
  const requests: string[] = [];
  const server = createServer(socket => {
    socket.on("error", () => undefined);
    let seen = "";
    socket.on("data", bytes => {
      seen += bytes.toString();
      if (!seen.includes("\r\n\r\n")) return; // wait for the full head (no body expected beyond head assertions)
      requests.push(seen);
      if (requests.length === 1) {
        assert.match(seen, /^POST \/submit HTTP\/1\.1/);
        assert.match(seen, /content-length: 9/i);
        socket.end("HTTP/1.1 303 See Other\r\nLocation: /done\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      } else {
        assert.match(seen, /^GET \/done HTTP\/1\.1/);
        assert.doesNotMatch(seen, /content-length|content-type|transfer-encoding/i);
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nDONE");
      }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  const secondAddress = server.address();
  const port = typeof secondAddress === "object" && secondAddress !== null ? secondAddress.port : 0;
  const result = await withProxyFetch({ mode: "direct" }, async fetch =>
    (await fetch(`http://127.0.0.1:${port}/submit`, {
      body: "payload42",
      headers: { "content-type": "text/plain" },
      method: "POST",
      signal: AbortSignal.timeout(3000),
    })).text());
  assert.equal(result, "DONE");
  assert.equal(requests.length, 2);
});
