// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:st", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { testProxyConnectivity } from "./proxy-connectivity.js";

test("proxy diagnostic reports authentication failures without credentials or external access", async context => {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.once("data", () => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  context.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const port = (server.address() as import("node:net").AddressInfo).port;
  const result = await testProxyConnectivity({ mode: "url", url: `http://username:supersecret@127.0.0.1:${port}`, noProxy: "" });
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /username|supersecret/);
  assert.match(result.message, /407|Proxy|proxy/);
});

test("proxy diagnostic rejects invalid policies before networking", async () => {
  for (const input of [null, { mode: "unknown" }, { mode: "url", url: "bad" }, { mode: "direct", noProxy: "host\nvalue" }]) {
    await assert.rejects(testProxyConnectivity(input));
  }
});
