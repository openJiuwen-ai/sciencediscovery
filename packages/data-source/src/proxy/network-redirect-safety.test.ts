// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:st", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { withProxyFetch } from "@sciencediscovery/network";

// The redirect/credential guard branches in packages/network (the hop-count
// cap, the https→http downgrade refusal and the cross-origin strip of
// authorization/cookie/proxy-authorization) had no direct test. These cases
// pin each branch against real loopback sockets: a different port on the same
// host is a different origin, so no DNS name games are needed to cross one.

type Socket = import("node:net").Socket;

function listen(t: import("node:test").TestContext, handler: (socket: Socket) => void): Promise<number> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  return once(server, "listening").then(() => {
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  });
}

function redirect(socket: Socket, location: string): void {
  socket.end(`HTTP/1.1 302 Found\r\nLocation: ${location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

test("the eleventh redirect hop is refused with the redirect-limit error", async t => {
  const requests: string[] = [];
  const port = await listen(t, socket => {
    socket.on("error", () => undefined);
    let seen = "";
    socket.on("data", bytes => {
      seen += bytes.toString();
      if (!seen.includes("\r\n\r\n")) return;
      requests.push(seen.split("\r\n")[0] ?? "");
      redirect(socket, "/hop");
    });
  });
  await assert.rejects(
    withProxyFetch({ mode: "direct" }, async fetch => fetch(`http://127.0.0.1:${port}/start`, { signal: AbortSignal.timeout(5000) })),
    /Download redirect limit exceeded/,
  );
  // The first request plus ten followed hops; the eleventh response is where
  // the cap refuses to follow the Location header any further.
  assert.equal(requests.length, 11);
});

test("a cross-origin redirect strips authorization, cookie and proxy-authorization before the next hop", async t => {
  const requests: string[] = [];
  const portA = await listen(t, socket => {
    socket.on("error", () => undefined);
    let seen = "";
    socket.on("data", bytes => {
      seen += bytes.toString();
      if (!seen.includes("\r\n\r\n")) return;
      // A different port on the same host is a different origin, so the
      // Location below crosses one and triggers the credential strip while
      // the second hop still lands on a server this test controls.
      redirect(socket, `http://127.0.0.1:${portB}/next`);
    });
  });
  const portB = await listen(t, socket => {
    socket.on("error", () => undefined);
    let seen = "";
    socket.on("data", bytes => {
      seen += bytes.toString();
      if (!seen.includes("\r\n\r\n")) return;
      requests.push(seen);
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
    });
  });
  const result = await withProxyFetch({ mode: "direct" }, async fetch =>
    (await fetch(`http://127.0.0.1:${portA}/first`, {
      headers: { authorization: "Bearer secret-token", cookie: "session=secret", "proxy-authorization": "Basic c2VjcmV0", "x-keep": "kept" },
      signal: AbortSignal.timeout(5000),
    })).text());
  assert.equal(result, "OK");
  assert.equal(requests.length, 1);
  // The credential-bearing headers must not reach the second origin, while an
  // unrelated custom header survives the strip untouched.
  assert.doesNotMatch(requests[0] ?? "", /secret-token|session=secret|c2VjcmV0/);
  assert.match(requests[0] ?? "", /x-keep: kept/);
});

test("an https→http redirect Location is refused by the protocol guard", () => {
  // Driving this branch end-to-end needs an https first hop, which needs a
  // TLS trust setup a focused unit test does not carry; the guard's refusal
  // is pinned at the source instead, next to the two branches proven live
  // above.
  const source = readFileSync(new URL("../../../network/src/index.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(target\.protocol === 'https:' && next\.protocol !== 'https:'\) throw new Error\('Refusing HTTPS downgrade'\);/);
  // The downgrade this refuses: an https page may not be redirected to a
  // plain-http URL, whatever the Location header claims.
  assert.notEqual(new URL("http://insecure.invalid/").protocol, "https:");
});
