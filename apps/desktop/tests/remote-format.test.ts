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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { ApiRequestError } from "../src/api/client.js";
import type { RemoteHostTarget } from "../src/api/types.js";
import {
  SSH_HOST_KEY_CHANGED_CODE,
  SSH_HOST_KEY_UNTRUSTED_CODE,
  allowlistHosts,
  hostDestination,
  hostKeyChanged,
  hostKeyFromError,
  hostKeyLine,
  hostKindLabel,
  projectRunnerIds,
  remoteHosts,
  reachabilityLabel,
  reachabilityTone,
  runnerUsable,
  storedCredentialLabels,
  toggleRunnerId,
} from "../src/app/remote-format.js";

function host(fields: Partial<RemoteHostTarget> & { id: string }): RemoteHostTarget {
  return {
    alias: fields.id,
    connectionKind: "ssh",
    createdAt: "2026-01-01T00:00:00.000Z",
    runnerCommand: "sciencediscovery-runner",
    status: "ready",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...fields,
  };
}

const LOCAL = host({ alias: "local", connectionKind: "direct", id: "local" });

test("an untrusted host key arrives as the question it is", () => {
  const untrusted = hostKeyFromError(
    new ApiRequestError("x", 409, SSH_HOST_KEY_UNTRUSTED_CODE, {
      hostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:abc" },
      hostId: "h1",
    }),
    "trainer",
  );
  assert.equal(untrusted?.changed, false);
  assert.equal(untrusted?.hostKey.fingerprint, "SHA256:abc");
  assert.equal(untrusted?.hostId, "h1");
  assert.equal(untrusted?.target, "trainer");

  const changed = hostKeyFromError(
    new ApiRequestError("x", 409, SSH_HOST_KEY_CHANGED_CODE, {
      hostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:def" },
    }),
    "trainer",
  );
  assert.equal(changed?.changed, true);
  // A changed key names the machine record less often than an untrusted one:
  // the add form's own retry supplies the id it created.
  assert.equal(changed?.hostId, undefined);
});

test("anything that is not a host-key rejection is not offered as one", () => {
  const cases: unknown[] = [
    new ApiRequestError("Runner refused", 503, undefined, {}),
    new ApiRequestError("x", 409, SSH_HOST_KEY_UNTRUSTED_CODE, {}),
    new ApiRequestError("x", 409, SSH_HOST_KEY_UNTRUSTED_CODE, { hostKey: { algorithm: "ssh-rsa" } }),
    new Error("socket closed"),
    undefined,
  ];
  for (const reason of cases) assert.equal(hostKeyFromError(reason, "t"), undefined);
});

test("a key already trusted under another name is reported as changed", () => {
  // The probe response carries the challenge the connection failed with, and
  // that challenge's flag is the only place the difference is stated.
  assert.equal(hostKeyChanged({ algorithm: "ssh-ed25519", fingerprint: "SHA256:a", changed: true }), true);
  assert.equal(hostKeyChanged({ algorithm: "ssh-ed25519", fingerprint: "SHA256:a", trusted: false }), false);
  assert.equal(hostKeyLine({ algorithm: "ssh-ed25519", fingerprint: "SHA256:a" }), "ssh-ed25519 · SHA256:a");
});

test("a machine is usable only when it is reachable and can run the Runner", () => {
  assert.equal(runnerUsable(LOCAL), true);
  assert.equal(runnerUsable(host({ id: "h", status: "error" })), false);
  assert.equal(runnerUsable(host({ id: "h", capabilities: { platform: "Linux" } })), true);
  // The deployed bundle is a Linux one, so a machine that answers as something
  // else cannot receive it.
  assert.equal(runnerUsable(host({ id: "h", capabilities: { platform: "Darwin" } })), false);
  assert.equal(runnerUsable(host({ id: "h", capabilities: { platform: "linux" } })), false);
  // A self-deployed Runner needs both an address and the token it was started
  // with; without the token there is nothing to authenticate with.
  const direct = { connectionKind: "direct" as const, endpoint: { host: "10.0.0.9", port: 4311, protocol: "http" as const } };
  assert.equal(runnerUsable(host({ id: "h", ...direct, hasToken: true })), true);
  assert.equal(runnerUsable(host({ id: "h", ...direct, hasToken: false })), false);
  assert.equal(runnerUsable(host({ id: "h", connectionKind: "direct", hasToken: true })), false);
});

test("the allowlist offers only machines a run could use", () => {
  const usable = host({ id: "ok", capabilities: { platform: "Linux" } });
  const broken = host({ id: "no", status: "error" });
  assert.deepEqual(allowlistHosts([LOCAL, usable, broken]).map((entry) => entry.id), ["local", "ok"]);
});

test("the remote page lists the machines that are not this one", () => {
  // The local Runner is synthesized by the server and always exists; a card for
  // it would be the one row no action on 远程 applies to.
  const one = host({ id: "h1" });
  assert.deepEqual(remoteHosts([LOCAL, one]).map((entry) => entry.id), ["h1"]);
  // With no remote machine registered the page has nothing to show, which its
  // own empty state says.
  assert.deepEqual(remoteHosts([LOCAL]), []);
});

test("a destination reads the way ssh would be given it", () => {
  // An SSH machine is reached by the address actually connected to, which is
  // not the name the user typed when an ssh_config entry resolved it.
  assert.equal(hostDestination(host({ alias: "trainer", hostName: "10.0.0.9" })), "10.0.0.9:22");
  assert.equal(hostDestination(host({ alias: "trainer", port: 2222 })), "trainer:2222");
  assert.equal(hostDestination(LOCAL), undefined);
  assert.equal(
    hostDestination(host({ connectionKind: "direct", endpoint: { host: "10.0.0.9", port: 4311, protocol: "http" } })),
    "10.0.0.9:4311",
  );
  // An IPv6 literal is bracketed so its own colons cannot be read as the port.
  assert.equal(hostDestination(host({ alias: "fe80::1" })), "[fe80::1]:22");
});

test("what a machine says about itself is labelled, and its kind named", () => {
  assert.equal(hostKindLabel(LOCAL), "本地");
  assert.equal(hostKindLabel(host({ id: "h" })), "SSH");
  assert.equal(
    hostKindLabel(host({ id: "h", connectionKind: "direct", endpoint: { host: "a", port: 1, protocol: "http" } })),
    "自部署",
  );
  assert.equal(reachabilityLabel(undefined), undefined);
  assert.equal(reachabilityLabel("offline"), "机器离线");
  // An unknown state is shown as it arrived rather than guessed at.
  assert.equal(reachabilityLabel("rebooting"), "rebooting");
  assert.equal(reachabilityTone("online"), "ok");
  assert.equal(reachabilityTone("offline"), "warn");
});

test("credential tags state what is stored, never what it is", () => {
  assert.deepEqual(storedCredentialLabels(host({ id: "h" })), []);
  assert.deepEqual(
    storedCredentialLabels(host({ hasPassword: true, hasPrivateKey: true, id: "h" })),
    ["已存密码", "已存私钥"],
  );
});

test("the allowed set falls back to the legacy list, which always included local", () => {
  assert.deepEqual(projectRunnerIds({ runnerIds: ["local", "h1"] }), ["local", "h1"]);
  assert.deepEqual(projectRunnerIds({ remoteRunnerHostIds: ["h1"] }), ["local", "h1"]);
  assert.deepEqual(projectRunnerIds({}), ["local"]);
  // An empty selection is a decision, not an absence: it forbids everything.
  assert.deepEqual(projectRunnerIds({ runnerIds: [] }), []);
});

test("toggling one machine leaves the rest of the selection alone", () => {
  assert.deepEqual(toggleRunnerId(["local"], "h1"), ["local", "h1"]);
  assert.deepEqual(toggleRunnerId(["local", "h1"], "h1"), ["local"]);
  assert.deepEqual(toggleRunnerId([], "local"), ["local"]);
  // The API rejects an empty id, so nothing is ever added that is not one.
  assert.deepEqual(toggleRunnerId(["local"], "  "), ["local"]);
});
