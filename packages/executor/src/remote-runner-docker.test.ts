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
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import type { RemoteHostTarget } from "@sciencediscovery/schema";

import { RemoteComputeClient } from "./remote-compute.js";
import { packRunnerBundle } from "./runner-bundle.js";

/**
 * End-to-end proof of the SSH path against a real OpenSSH server: the product
 * probes a machine that has no runner, deploys its own over SSH, connects
 * through the tunnel and uses the remote workspace.
 *
 * It builds and runs a container, so it is opt-in:
 *   SCIENCE_AGENT_DOCKER_SSH_TEST=1 node --test packages/executor/dist/remote-runner-docker.test.js
 */
const OPT_IN = process.env.SCIENCE_AGENT_DOCKER_SSH_TEST?.trim() === "1";
const IMAGE = "sciencediscovery-ssh-test";
const CONTAINER = `sciencediscovery-ssh-test-${process.pid}`;
const run = promisify(execFile);

// A plain Linux machine: an SSH server, a Node runtime, and the sandbox the
// runner needs. It deliberately has no ScienceDiscovery runner installed.
const DOCKERFILE = `FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server tar bubblewrap \\
  && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/sh scientist && mkdir -p /home/scientist/.ssh /run/sshd \\
  && chown -R scientist:scientist /home/scientist/.ssh && chmod 700 /home/scientist/.ssh
COPY authorized_keys /home/scientist/.ssh/authorized_keys
RUN chown scientist:scientist /home/scientist/.ssh/authorized_keys && chmod 600 /home/scientist/.ssh/authorized_keys
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
`;

async function startContainer(root: string): Promise<{ keyPath: string; port: number }> {
  const keyPath = resolve(root, "id_ed25519");
  await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "sciencediscovery-test"]);
  await run("cp", [`${keyPath}.pub`, resolve(root, "authorized_keys")]);
  await writeFile(resolve(root, "Dockerfile"), DOCKERFILE);
  await run("docker", ["build", "-t", IMAGE, root], { maxBuffer: 32 * 1024 * 1024 });
  await run("docker", ["run", "-d", "--name", CONTAINER, "-p", "127.0.0.1:0:22", IMAGE]);
  const { stdout: published } = await run("docker", ["port", CONTAINER, "22"]);
  const port = published.split("\n")[0]?.split(":").pop()?.trim();
  assert.ok(port, "the container did not publish its SSH port");
  // Wait for sshd rather than for a keyscan: nothing in this test reads the
  // user's known_hosts, so the only thing worth waiting for is a live port.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = await run("docker", ["exec", CONTAINER, "sh", "-c", "pgrep sshd >/dev/null && echo up"])
      .then(({ stdout }) => stdout.includes("up"))
      .catch(() => false);
    if (ready) break;
    await new Promise((wait) => setTimeout(wait, 500));
  }
  await chmod(keyPath, 0o600);
  return { keyPath, port: Number(port) };
}

test("a real SSH machine without a runner is deployed to, connected, and used", { skip: !OPT_IN }, async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "sd-ssh-docker-"));
  context.after(async () => {
    await run("docker", ["rm", "-f", CONTAINER]).catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  });
  await mkdir(root, { recursive: true });
  const { keyPath, port } = await startContainer(root);
  // The product logs in with credentials it holds itself and only trusts the
  // key it was told to trust: no ssh_config, no agent, no user known_hosts.
  const credentials = { privateKey: await readFile(keyPath, "utf8"), username: "scientist" };
  const untrusted = { credentials, destination: "127.0.0.1", port };
  const client = new RemoteComputeClient("/unused/ssh_config", async () => access);
  context.after(() => client.close());

  // An unknown key is refused, and comes back as something the settings page
  // can offer to trust.
  await assert.rejects(client.probe(untrusted), (error: Error) => {
    assert.equal(error.name, "SshHostKeyUntrustedError");
    return true;
  });
  const challenge = await client.readHostKey(untrusted);
  assert.match(challenge.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(challenge.changed, false);
  const access = { ...untrusted, trustedHostKey: { algorithm: challenge.algorithm, fingerprint: challenge.fingerprint } };

  const capabilities = await client.probe(access);
  assert.equal(capabilities.platform, "Linux");
  assert.equal(capabilities.runnerCommandAvailable, false, "the container must start without a runner installed");
  assert.match(capabilities.nodeVersion ?? "", /^v2[2-9]\./);

  const host: RemoteHostTarget = {
    alias: "127.0.0.1",
    capabilities,
    connectionKind: "ssh",
    createdAt: new Date().toISOString(),
    id: "docker-host",
    port,
    runnerCommand: "sciencediscovery-runner",
    status: "ready",
    updatedAt: new Date().toISOString(),
    username: "scientist",
  };
  const bundle = await packRunnerBundle();
  const connected = await client.connectRunner(host, { bundle, localVersion: "local-build" });
  assert.equal(connected.state, "ready", connected.error ?? "the runner did not become ready");
  assert.equal(connected.deployed, true);
  assert.ok(connected.remoteVersion);

  const runner = client.runnerClient(host.id);
  assert.equal((await runner.health()).platform, "linux");
  assert.equal((await runner.status()).status, "ok");

  // The remote workspace is the runner's own and survives reconnection.
  const workspaceKey = "project-docker/session-docker";
  await runner.deleteRemoteWorkspace(workspaceKey);
  await runner.writeRemoteWorkspaceFile(workspaceKey, "inputs/data.csv", Buffer.from("a,b\n1,2\n"));
  assert.deepEqual(
    (await runner.listRemoteWorkspaceFiles(workspaceKey)).map((file) => file.path),
    ["inputs/data.csv"],
  );

  // Reconnecting finds the deployment already installed, so nothing is sent.
  const reconnected = await client.connectRunner(host, { bundle, localVersion: "local-build" });
  assert.equal(reconnected.state, "ready", reconnected.error ?? "the runner did not reconnect");
  assert.equal(
    (await client.runnerClient(host.id).readRemoteWorkspaceFile(workspaceKey, "inputs/data.csv")).toString("utf8"),
    "a,b\n1,2\n",
  );

  // A second connection to the same machine: two per-connection sockets leave
  // them no address to collide on.
  const second: RemoteHostTarget = { ...host, id: "docker-host-second" };
  const connectedTwice = await client.connectRunner(second, { bundle, localVersion: "local-build" });
  assert.equal(connectedTwice.state, "ready", connectedTwice.error ?? "the second connection did not become ready");
  assert.equal((await client.runnerClient(second.id).status()).status, "ok");
  await client.disconnectRunner(second.id);

  // Disconnecting must leave no runner process behind on the machine.
  await client.disconnectRunner(host.id);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { stdout } = await run("docker", ["exec", CONTAINER, "sh", "-c", "ps -eo args | grep -c '[s]erver.js' || true"]);
    if (stdout.trim() === "0") return;
    await new Promise((wait) => setTimeout(wait, 250));
  }
  assert.fail("the remote runner kept running after the SSH connection ended");
});
