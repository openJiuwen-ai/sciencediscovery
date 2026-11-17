// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** 生成只供本地 HTTPS 夹具使用的临时证书，不关闭客户端 TLS 校验。 */
export async function createMcpTestTls() {
  const dir = await mkdtemp(join(tmpdir(), "mcp-tls-"));
  try {
    const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-subj", "/CN=mcp-fixture.invalid", "-addext", "subjectAltName=DNS:mcp-fixture.invalid", "-keyout", key, "-out", cert]);
    return { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** 启动独立的本地 SDK MCP 服务，返回地址和等待退出的清理方法。 */
export async function startMcpFixture(transport: "http" | "sse") {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../fixtures/mcp-echo.mjs", import.meta.url)), `--${transport}`, "0"],
    { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MCP fixture startup timeout")), 10_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.stderr.once("data", (data) => { clearTimeout(timer); resolve(JSON.parse(String(data)).port); });
    });
    return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => {
      child.once("exit", () => resolve()); child.kill();
    }) };
  } catch (error) { child.kill(); throw error; }
}

/** 仅向给定本地服务转发的记录代理，远端测试域名不经过 DNS 或公网。 */
export async function startMcpProxy(origin: string) {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const target = new URL(request.url ?? "/", origin);
    const upstream = httpRequest(new URL(target.pathname + target.search, origin), {
      method: request.method, headers: { ...request.headers, host: new URL(origin).host }, agent: false,
    }, (received) => {
      response.writeHead(received.statusCode ?? 502, received.headers);
      received.pipe(response);
    });
    upstream.on("error", () => { response.writeHead(502).end(); });
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("connect", (request, downstream, head) => {
    requests.push(`CONNECT ${request.url}`);
    const target = new URL(origin);
    const upstream = connect(Number(target.port), target.hostname, () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      downstream.pipe(upstream); upstream.pipe(downstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => downstream.destroy());
    downstream.on("error", () => upstream.destroy());
    downstream.on("close", () => upstream.destroy());
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP proxy did not bind");
  return { url: `http://127.0.0.1:${address.port}`, requests, close: async () => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}
