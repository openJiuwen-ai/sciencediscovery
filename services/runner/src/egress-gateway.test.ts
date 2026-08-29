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

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";

import type { SandboxNetworkAccess } from "@sciencediscovery/schema";

import {
  EGRESS_SOCKET_RELATIVE_BYTES,
  EgressGateway,
  EgressGatewayRegistry,
  EgressSocketPathTooLongError,
  MAX_UNIX_SOCKET_PATH_BYTES,
  isPrivateAddress,
} from "./egress-gateway.js";

const temporaryDirectories: string[] = [];

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sciencediscovery-egress-"));
  temporaryDirectories.push(directory);
  return directory;
}

after(async () => {
  for (const directory of temporaryDirectories) await rm(directory, { force: true, recursive: true });
});

/** A real data directory whose absolute path is exactly `bytes` long. */
async function dataDirectoryOfLength(bytes: number): Promise<string> {
  const root = await scratchDirectory();
  const fillerLength = bytes - root.length - 1;
  assert.ok(fillerLength > 0, `the scratch root is already ${root.length} bytes`);
  const directory = join(root, "d".repeat(fillerLength));
  await mkdir(directory, { recursive: true });
  assert.equal(Buffer.byteLength(directory), bytes);
  return directory;
}

/** The longest data directory that still leaves room for a socket. */
const FITTING_DATA_DIRECTORY_BYTES = MAX_UNIX_SOCKET_PATH_BYTES - EGRESS_SOCKET_RELATIVE_BYTES;

function access(overrides: Partial<SandboxNetworkAccess> = {}): SandboxNetworkAccess {
  return {
    allowPrivateNetwork: false,
    allowedDomains: ["example.org"],
    egressProxyPolicy: "inherit",
    mode: "domain-allowlist",
    revision: "test-revision",
    ...overrides,
  };
}

/** A target the gateway can actually reach: localhost, so it needs allowPrivateNetwork. */
async function localTarget(): Promise<{ close: () => Promise<void>; port: number; server: Server }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`ok ${request.url}`);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    close: () => new Promise<void>((resolveClose) => { server.close(() => resolveClose()); }),
    port,
    server,
  };
}

/** Speak the proxy protocol over the gateway's Unix socket, like the bridge does. */
function overSocket(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolvePayload, reject) => {
    const client = connect(socketPath);
    let received = "";
    client.on("connect", () => client.write(payload));
    client.on("data", (chunk) => { received += chunk.toString(); });
    client.on("error", reject);
    client.on("close", () => resolvePayload(received));
    setTimeout(() => client.destroy(), 2_000).unref();
  });
}

test("private, loopback and link-local addresses are classified as private", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1"]) {
    assert.equal(isPrivateAddress(address, 4), true, address);
  }
  for (const address of ["::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateAddress(address, 6), true, address);
  }
  assert.equal(isPrivateAddress("93.184.216.34", 4), false);
  assert.equal(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946", 6), false);
});

test("a host outside the allowed domains is denied before any connection", async () => {
  const directory = await scratchDirectory();
  const gateway = new EgressGateway(access(), join(directory, "egress.sock"));
  await gateway.listen();
  try {
    const decision = await gateway.decide("blocked.test", 443);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? "", /not in the sandbox network allowed domains/);
    const response = await overSocket(gateway.socketPath, "CONNECT blocked.test:443 HTTP/1.1\r\n\r\n");
    assert.match(response, /^HTTP\/1\.1 403 Forbidden/);
  } finally {
    await gateway.close();
  }
});

test("a CONNECT request with a malformed port is rejected as a bad request", async () => {
  const directory = await scratchDirectory();
  const gateway = new EgressGateway(access(), join(directory, "egress.sock"));
  await gateway.listen();
  try {
    for (const authority of ["example.org:", "example.org:0", "example.org:70000", "example.org:https"]) {
      const response = await overSocket(gateway.socketPath, `CONNECT ${authority} HTTP/1.1\r\n\r\n`);
      assert.match(response, /^HTTP\/1\.1 400 Bad Request/, authority);
    }
    // An omitted port still defaults to 443 and reaches the allowlist decision.
    const omitted = await overSocket(gateway.socketPath, "CONNECT blocked.test HTTP/1.1\r\n\r\n");
    assert.match(omitted, /^HTTP\/1\.1 403 Forbidden/);
  } finally {
    await gateway.close();
  }
});

test("an allowed domain that resolves to loopback is denied unless private access is on", async () => {
  const directory = await scratchDirectory();
  const resolveAddresses = async () => [{ address: "127.0.0.1", family: 4 }];
  const denied = new EgressGateway(access({ allowedDomains: ["mirror.test"] }), join(directory, "denied.sock"), {
    resolveAddresses,
  });
  await denied.listen();
  try {
    const decision = await denied.decide("mirror.test", 80);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? "", /private or loopback/);
  } finally {
    await denied.close();
  }

  const allowed = new EgressGateway(
    access({ allowPrivateNetwork: true, allowedDomains: ["mirror.test"] }),
    join(directory, "allowed.sock"),
    { resolveAddresses },
  );
  await allowed.listen();
  try {
    const decision = await allowed.decide("mirror.test", 80);
    assert.deepEqual(decision, { address: "127.0.0.1", allowed: true });
  } finally {
    await allowed.close();
  }
});

test("a public address is preferred over a private one for the same allowed domain", async () => {
  const directory = await scratchDirectory();
  const gateway = new EgressGateway(access({ allowedDomains: ["example.org"] }), join(directory, "egress.sock"), {
    resolveAddresses: async () => [
      { address: "10.0.0.7", family: 4 },
      { address: "93.184.216.34", family: 4 },
    ],
  });
  await gateway.listen();
  try {
    assert.equal((await gateway.decide("example.org", 443)).address, "93.184.216.34");
  } finally {
    await gateway.close();
  }
});

test("an allowed domain is forwarded and reaches the target", async () => {
  const directory = await scratchDirectory();
  const target = await localTarget();
  const gateway = new EgressGateway(
    access({ allowPrivateNetwork: true, allowedDomains: ["mirror.test"] }),
    join(directory, "egress.sock"),
    { resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }] },
  );
  await gateway.listen();
  try {
    const response = await overSocket(
      gateway.socketPath,
      `GET http://mirror.test:${target.port}/hello HTTP/1.1\r\nHost: mirror.test:${target.port}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(response, /^HTTP\/1\.1 200/);
    assert.match(response, /ok \/hello/);
  } finally {
    await gateway.close();
    await target.close();
  }
});

/**
 * A proxy that records what it was asked for and then reaches the local target,
 * whatever authority the request named. Standing in for a corporate proxy, it
 * makes both halves observable: what the gateway asked it to reach, and whether
 * it was asked at all.
 */
async function recordingProxy(forwardPort: number): Promise<{
  authorizations: (string | undefined)[];
  close: () => Promise<void>;
  connects: string[];
  port: number;
  requests: string[];
}> {
  const connects: string[] = [];
  const requests: string[] = [];
  const authorizations: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    authorizations.push(request.headers["proxy-authorization"] as string | undefined);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`proxied ${request.url}`);
  });
  server.on("connect", (request, clientSocket) => {
    connects.push(request.url ?? "");
    authorizations.push(request.headers["proxy-authorization"] as string | undefined);
    const upstream = connect({ host: "127.0.0.1", port: forwardPort }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", () => listening()));
  const address = server.address();
  return {
    authorizations,
    close: () => new Promise<void>((closed) => { server.closeAllConnections(); server.close(() => closed()); }),
    connects,
    port: typeof address === "object" && address ? address.port : 0,
    requests,
  };
}

test("an allowed domain leaves through the configured proxy, by name", async () => {
  const directory = await scratchDirectory();
  const target = await localTarget();
  const proxy = await recordingProxy(target.port);
  const gateway = new EgressGateway(
    access({ allowPrivateNetwork: true, allowedDomains: ["mirror.test"] }),
    join(directory, "egress.sock"),
    {
      proxy: { mode: "url", url: `http://re%40search:p%40ss@127.0.0.1:${proxy.port}` },
      resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }],
    },
  );
  await gateway.listen();
  try {
    // CONNECT: the tunnel is opened by the proxy, and the sandbox still gets
    // an end-to-end connection to the origin.
    const tunnelled = await overSocket(
      gateway.socketPath,
      `CONNECT mirror.test:${target.port} HTTP/1.1\r\n\r\n`
      + `GET /through HTTP/1.1\r\nHost: mirror.test\r\nConnection: close\r\n\r\n`,
    );
    assert.match(tunnelled, /^HTTP\/1\.1 200 Connection Established/);
    assert.match(tunnelled, /ok \/through/);
    assert.deepEqual(proxy.connects, [`mirror.test:${target.port}`]);

    // Absolute-form HTTP keeps its absolute URI and goes to the proxy instead
    // of the pinned address.
    const forwarded = await overSocket(
      gateway.socketPath,
      `GET http://mirror.test:${target.port}/plain HTTP/1.1\r\nHost: mirror.test:${target.port}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(forwarded, /^HTTP\/1\.1 200/);
    assert.match(forwarded, /proxied http:\/\/mirror\.test:\d+\/plain/);
    assert.deepEqual(proxy.requests, [`http://mirror.test:${target.port}/plain`]);

    // Credentials in the registry URL are presented to the proxy, and only there.
    const expected = `Basic ${Buffer.from("re@search:p@ss").toString("base64")}`;
    assert.deepEqual(proxy.authorizations, [expected, expected]);
  } finally {
    await gateway.close();
    await proxy.close();
    await target.close();
  }
});

test("a refused domain is answered by the gateway and never offered to the proxy", async () => {
  const directory = await scratchDirectory();
  const target = await localTarget();
  const proxy = await recordingProxy(target.port);
  const gateway = new EgressGateway(
    access({ allowPrivateNetwork: true, allowedDomains: ["mirror.test"] }),
    join(directory, "egress.sock"),
    {
      proxy: { mode: "url", url: `http://127.0.0.1:${proxy.port}` },
      resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }],
    },
  );
  await gateway.listen();
  try {
    const denied = await overSocket(gateway.socketPath, `CONNECT blocked.test:443 HTTP/1.1\r\n\r\n`);
    assert.match(denied, /^HTTP\/1\.1 403 Forbidden/);
    const deniedPlain = await overSocket(
      gateway.socketPath,
      "GET http://blocked.test/ HTTP/1.1\r\nHost: blocked.test\r\nConnection: close\r\n\r\n",
    );
    assert.match(deniedPlain, /^HTTP\/1\.1 403/);
    // The allowlist decision happens first, so the proxy never learns the
    // sandbox wanted blocked.test at all.
    assert.deepEqual(proxy.connects, []);
    assert.deepEqual(proxy.requests, []);
  } finally {
    await gateway.close();
    await proxy.close();
    await target.close();
  }
});

test("the outbound route is re-resolved on every acquire", async () => {
  const directory = await scratchDirectory();
  const target = await localTarget();
  const proxy = await recordingProxy(target.port);
  const registry = new EgressGatewayRegistry(directory, undefined, async () => [{ address: "127.0.0.1", family: 4 }]);
  const policy = access({ allowPrivateNetwork: true, allowedDomains: ["mirror.test"] });
  try {
    const direct = await registry.acquire(policy);
    assert.match(
      await overSocket(direct.socketPath, `GET http://mirror.test:${target.port}/a HTTP/1.1\r\nHost: m\r\nConnection: close\r\n\r\n`),
      /ok \/a/,
    );
    assert.deepEqual(proxy.requests, []);

    // Same revision, so the same gateway and socket — but a registry edit
    // applies to the next execution instead of waiting for a policy change.
    const viaProxy = await registry.acquire(policy, { mode: "url", url: `http://127.0.0.1:${proxy.port}` });
    assert.equal(viaProxy, direct);
    assert.match(
      await overSocket(viaProxy.socketPath, `GET http://mirror.test:${target.port}/b HTTP/1.1\r\nHost: m\r\nConnection: close\r\n\r\n`),
      /proxied http:/,
    );
    assert.deepEqual(proxy.requests, [`http://mirror.test:${target.port}/b`]);

    const backToDirect = await registry.acquire(policy, { mode: "direct" });
    assert.match(
      await overSocket(backToDirect.socketPath, `GET http://mirror.test:${target.port}/c HTTP/1.1\r\nHost: m\r\nConnection: close\r\n\r\n`),
      /ok \/c/,
    );
    assert.equal(proxy.requests.length, 1);
  } finally {
    await registry.close();
    await proxy.close();
    await target.close();
  }
});

test("an unusable proxy fails the allowed request instead of connecting around it", async () => {
  const directory = await scratchDirectory();
  const target = await localTarget();
  const gateway = new EgressGateway(
    access({ allowPrivateNetwork: true, allowedDomains: ["mirror.test"] }),
    join(directory, "egress.sock"),
    {
      proxy: { mode: "url", url: "socks5://127.0.0.1:1080" },
      resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }],
    },
  );
  await gateway.listen();
  try {
    const response = await overSocket(
      gateway.socketPath,
      `GET http://mirror.test:${target.port}/ HTTP/1.1\r\nHost: mirror.test\r\nConnection: close\r\n\r\n`,
    );
    assert.match(response, /^HTTP\/1\.1 502/);
    assert.match(response, /socks5 proxy/);
  } finally {
    await gateway.close();
    await target.close();
  }
});

test("malformed proxy credentials fail the request instead of killing the runner", async () => {
  const directory = await scratchDirectory();
  const target = await localTarget();
  // The registry keeps a custom URL as written, so a stray `%` can reach the
  // gateway. Decoding it used to throw where nothing could catch it: in
  // handleRequest, past the route guard, and in the CONNECT socket callback.
  const gateway = new EgressGateway(
    access({ allowPrivateNetwork: true, allowedDomains: ["mirror.test"] }),
    join(directory, "egress.sock"),
    {
      proxy: { mode: "url", url: "http://user%zz:p@127.0.0.1:1/" },
      resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }],
    },
  );
  const escaped: unknown[] = [];
  const onUncaught = (error: unknown) => escaped.push(error);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);
  await gateway.listen();
  try {
    const forwarded = await overSocket(
      gateway.socketPath,
      `GET http://mirror.test:${target.port}/ HTTP/1.1\r\nHost: mirror.test\r\nConnection: close\r\n\r\n`,
    );
    assert.match(forwarded, /^HTTP\/1\.1 502/);
    assert.match(forwarded, /not valid percent-encoding/);

    const tunnelled = await overSocket(gateway.socketPath, `CONNECT mirror.test:${target.port} HTTP/1.1\r\n\r\n`);
    assert.match(tunnelled, /^HTTP\/1\.1 502/);
    assert.match(tunnelled, /not valid percent-encoding/);

    // Both paths are handled without a catch above them, so anything that
    // escapes here would have taken the process down in production.
    await new Promise((settled) => setImmediate(settled));
    assert.deepEqual(escaped, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
    await gateway.close();
    await target.close();
  }
});

test("an IP literal target is rejected even when the allowlist looks permissive", async () => {
  const directory = await scratchDirectory();
  const gateway = new EgressGateway(
    access({ allowPrivateNetwork: true, allowedDomains: ["example.org"] }),
    join(directory, "egress.sock"),
  );
  await gateway.listen();
  try {
    const decision = await gateway.decide("127.0.0.1", 4310);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? "", /IP address/);
  } finally {
    await gateway.close();
  }
});

test("the registry reuses one gateway per policy revision and closes them together", async () => {
  const directory = await scratchDirectory();
  const registry = new EgressGatewayRegistry(directory);
  try {
    const first = await registry.acquire(access());
    const again = await registry.acquire(access());
    assert.equal(first, again);
    const other = await registry.acquire(access({ allowedDomains: ["other.test"], revision: "other-revision" }));
    assert.notEqual(first.socketPath, other.socketPath);
    assert.equal(first.socketPath, registry.socketPath("test-revision"));
  } finally {
    await registry.close();
  }
  await assert.rejects(registry.acquire({ ...access(), mode: "none" }), /domain-allowlist/);
});

test("a socket name is fixed length and per-revision, whatever the revision looks like", async () => {
  const directory = await scratchDirectory();
  const registry = new EgressGatewayRegistry(directory);
  const first = registry.socketPath("test-revision");
  const other = registry.socketPath("other-revision");
  // A revision reaches the runner over HTTP, so it may be any string; the name
  // it produces must stay short and must not walk out of the socket directory.
  const overlong = registry.socketPath("x".repeat(4_000));
  const traversal = registry.socketPath("../../escape");
  for (const path of [first, other, overlong, traversal]) {
    assert.match(basename(path), /^[0-9a-f]{16}$/);
    assert.equal(dirname(dirname(path)), directory);
  }
  assert.notEqual(first, other);
  assert.equal(first, registry.socketPath("test-revision"));
});

test("the longest data directory that fits creates the socket at exactly the reported path", async () => {
  const dataDir = await dataDirectoryOfLength(FITTING_DATA_DIRECTORY_BYTES);
  const registry = new EgressGatewayRegistry(dataDir);
  try {
    const gateway = await registry.acquire(access());
    assert.equal(Buffer.byteLength(gateway.socketPath), MAX_UNIX_SOCKET_PATH_BYTES);
    assert.equal(dirname(dirname(gateway.socketPath)), dataDir);
    // listen, chmod and rm all use this one string. A truncated bind would put
    // the socket somewhere else and leave this path missing.
    assert.equal((await stat(gateway.socketPath)).isSocket(), true);
    assert.deepEqual(await readdir(dirname(gateway.socketPath)), [basename(gateway.socketPath)]);
  } finally {
    await registry.close();
  }
});

test("a data directory one byte too long fails before libuv can truncate the path", async () => {
  const dataDir = await dataDirectoryOfLength(FITTING_DATA_DIRECTORY_BYTES + 1);
  const registry = new EgressGatewayRegistry(dataDir);
  try {
    await assert.rejects(registry.acquire(access()), (error: Error) => {
      assert.ok(error instanceof EgressSocketPathTooLongError, error.message);
      assert.match(error.message, new RegExp(`${MAX_UNIX_SOCKET_PATH_BYTES + 1} bytes`));
      assert.match(error.message, new RegExp(`${MAX_UNIX_SOCKET_PATH_BYTES}-byte Unix socket path limit`));
      assert.match(error.message, /shorten that directory by at least 1 byte/);
      return true;
    });
    // Fail-closed means nothing was created: no truncated socket, no directory.
    assert.deepEqual(await readdir(dataDir), []);
  } finally {
    await registry.close();
  }
});
