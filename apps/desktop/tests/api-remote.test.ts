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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import * as remote from "../src/api/remote.js";
import { StubClient, json, split } from "./api-stub.js";

type RegisterBody = Parameters<typeof remote.registerRemoteHost>[1];
type CredentialsBody = Parameters<typeof remote.updateRemoteHostCredentials>[2];
type HostKeyBody = Parameters<typeof remote.trustRemoteHostKey>[2];

describe("registering a machine", () => {
  it("creates or updates through the same POST and encodes the record id", async () => {
    const create = { alias: "gpu-01", hostName: "10.0.0.9" } as unknown as RegisterBody;
    const update = { id: "host/one", alias: "gpu-01" } as unknown as RegisterBody;
    const stub = new StubClient().reply({}).reply({});
    const client = stub.asClient();

    await remote.registerRemoteHost(client, create);
    await remote.registerRemoteHost(client, update);

    assert.equal(stub.calls[0]!.path, "/api/remote-hosts");
    assert.equal(stub.calls[0]!.init.method, "POST");
    assert.deepEqual(json(stub.calls[0]!), create);
    assert.equal(stub.calls[1]!.path, "/api/remote-hosts");
    assert.deepEqual(json(stub.calls[1]!), update);
  });

  it("replaces credentials with PUT and accepts a host key separately", async () => {
    const credentials = { password: "secret", username: "root" } as unknown as CredentialsBody;
    const hostKey = { algorithm: "ssh-ed25519", fingerprint: "SHA256:abc" } as unknown as HostKeyBody;
    const stub = new StubClient().reply({}).reply({});
    const client = stub.asClient();

    await remote.updateRemoteHostCredentials(client, "host/one", credentials);
    await remote.trustRemoteHostKey(client, "host/one", hostKey);

    assert.equal(stub.calls[0]!.path, "/api/remote-hosts/host%2Fone/credentials");
    assert.equal(stub.calls[0]!.init.method, "PUT");
    assert.deepEqual(json(stub.calls[0]!), credentials);
    assert.equal(stub.calls[1]!.path, "/api/remote-hosts/host%2Fone/trust-host-key");
    assert.equal(stub.calls[1]!.init.method, "POST");
    // Only the two fields the server accepts are sent back.
    assert.deepEqual(json(stub.calls[1]!), hostKey);
  });

  it("deletes the record and everything it connected", async () => {
    const stub = new StubClient().reply({ deleted: "host/one" });

    await remote.deleteRemoteHost(stub.asClient(), "host/one");

    assert.equal(stub.calls[0]!.path, "/api/remote-hosts/host%2Fone");
    assert.equal(stub.calls[0]!.init.method, "DELETE");
  });
});

describe("keys and connection logs", () => {
  it("generates a key and reads the last connect log", async () => {
    const stub = new StubClient().reply({ privateKeyPath: "/tmp/key" }).reply({ lines: [] });
    const client = stub.asClient();

    await remote.generateRemoteHostKey(client);
    await remote.runnerConnectLog(client, "runner/one");

    assert.equal(stub.calls[0]!.path, "/api/remote-hosts/generate-key");
    assert.equal(stub.calls[0]!.init.method, "POST");
    assert.equal(stub.calls[1]!.path, "/api/runners/runner%2Fone/connect-log");
  });
});

describe("ssh_config import", () => {
  it("lists entries and resolves exactly the alias that was chosen", async () => {
    const stub = new StubClient().reply([]).reply({});
    const client = stub.asClient();

    await remote.listSshConfigHosts(client);
    await remote.resolveSshConfigHost(client, "gpu/01");

    assert.equal(stub.calls[0]!.path, "/api/remote-hosts/ssh-config");
    const resolved = split(stub.calls[1]!);
    assert.equal(resolved.pathname, "/api/remote-hosts/ssh-config");
    assert.equal(resolved.query.get("alias"), "gpu/01");
  });

  it("browses key files with an optional path and an explicit offset", async () => {
    const stub = new StubClient().reply({}).reply({});
    const client = stub.asClient();

    await remote.browseSshKeyFiles(client);
    await remote.browseSshKeyFiles(client, "~/.ssh", 50);

    const first = split(stub.calls[0]!);
    assert.equal(first.pathname, "/api/remote-hosts/key-files");
    assert.equal(first.query.get("path"), null);
    assert.equal(first.query.get("offset"), "0");
    const second = split(stub.calls[1]!);
    assert.equal(second.query.get("path"), "~/.ssh");
    assert.equal(second.query.get("offset"), "50");
  });
});

describe("failures", () => {
  it("keeps an untrusted host-key 409 distinguishable for the caller", async () => {
    const failure = new Error("SSH_HOST_KEY_UNTRUSTED");
    const stub = new StubClient().fail(failure);

    await assert.rejects(
      () => remote.registerRemoteHost(stub.asClient(), {} as unknown as RegisterBody),
      (reason: unknown) => reason === failure,
    );
  });
});
