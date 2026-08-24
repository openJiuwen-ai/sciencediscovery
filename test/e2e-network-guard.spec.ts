// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { expect } from "@playwright/test";

import { test } from "./helpers/e2e.ts";

async function webSocketOutcome(page: import("@playwright/test").Page, url: string): Promise<string> {
  return page.evaluate((target) => new Promise<string>((resolve) => {
    const socket = new WebSocket(target);
    const timeout = window.setTimeout(() => resolve("timeout"), 5_000);
    socket.addEventListener("open", () => {
      window.clearTimeout(timeout);
      resolve("open");
      socket.close();
    }, { once: true });
    socket.addEventListener("close", (event) => {
      window.clearTimeout(timeout);
      resolve(`close:${event.code}:${event.reason}`);
    }, { once: true });
  }), url);
}

/**
 * E2E-META
 * Purpose: The automatic mocked-test guard blocks non-local HTTP(S) and
 *   WebSocket requests while preserving local HTTP and WebSocket access.
 * Steps:
 *   1. Start one local HTTP/WebSocket server.
 *   2. Assert an HTTPS navigation is blocked and local HTTP still responds.
 *   3. Assert a non-local WebSocket is policy-closed and local WebSocket opens.
 * Environment: Pinned Chromium only; no running ScienceDiscovery stack or test
 *   data is required.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — example.invalid is attempted only to prove that the
 *   route is intercepted before any network access.
 * Credentials: none
 * CostSideEffects: none — no external request or persistent data mutation.
 */
test("mocked browser traffic cannot leave localhost", { tag: "@mocked" }, async ({ page }) => {
  const sockets = new Set<Duplex>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("local-http-ok");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;

  try {
    const externalHttp = "https://example.invalid/e2e-egress-probe";
    const failedRequest = page.waitForEvent("requestfailed", (request) => request.url() === externalHttp);
    await expect(page.goto(externalHttp)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
    expect((await failedRequest).failure()?.errorText).toContain("ERR_BLOCKED_BY_CLIENT");

    await page.goto(`http://127.0.0.1:${port}/health`);
    await expect(page.getByText("local-http-ok")).toBeVisible();

    await expect(webSocketOutcome(page, "wss://example.invalid/e2e-egress-probe")).resolves.toBe(
      "close:1008:Non-local WebSocket blocked by mocked E2E policy",
    );
    await expect(webSocketOutcome(page, `ws://127.0.0.1:${port}/local`)).resolves.toBe("open");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
