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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { SandboxNetworkAccess } from "@sciencediscovery/schema";

import { EgressGateway, EgressGatewayRegistry, isPrivateAddress } from "./egress-gateway.js";

const temporaryDirectories: string[] = [];

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sciencediscovery-egress-"));
  temporaryDirectories.push(directory);
  return directory;
}

after(async () => {
  for (const directory of temporaryDirectories) await rm(directory, { force: true, recursive: true });
});

function access(overrides: Partial<SandboxNetworkAccess> = {}): SandboxNetworkAccess {
  return {
    allowPrivateNetwork: false,
    allowedDomains: ["example.org"],
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
    assert.match(first.socketPath, /test-revision\.sock$/);
  } finally {
    await registry.close();
  }
  assert.throws(() => registry.acquire({ ...access(), mode: "none" }), /domain-allowlist/);
});
