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
import test from "node:test";

import type { RemoteHostTarget, RemoteJob, RegisterRemoteHostRequest } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { ApiClient } from "../src/api.js";
import { ApiRequestError } from "../src/api/auth.js";
import { hostKeyFromError } from "../src/api/settings.js";
import { RemoteHostManager, RemoteJobsPanel, RunnerResourceSummary } from "../src/RemoteCompute.js";
import { activityCardId } from "../src/session/run-activity.js";

const timestamp = "2026-07-15T00:00:00.000Z";
test("resource cards distinguish available workspace disk, low space, and unavailable readings", () => {
  const host = buildHost({ runnerStatus: { hostId: "host-1", state: "ready", resources: {
    capturedAt: timestamp, cpuCores: 4, loadAverage1m: 0.25,
    memoryTotalBytes: 4 * 1024 ** 3, memoryFreeBytes: 2 * 1024 ** 3, uptimeSeconds: 7200,
    workspaceDisk: { path: "/data/remote-workspaces", availableBytes: 20 * 1024 ** 3, totalBytes: 30 * 1024 ** 3 },
  } } });
  const render = () => renderToStaticMarkup(createElement(RunnerResourceSummary, { host }));
  assert.match(render(), /20.0 GiB \/ 30.0 GiB/);
  assert.match(render(), /\/data\/remote-workspaces/);
  assert.doesNotMatch(render(), /not a per-workspace quota|reclaimable caches|Host snapshot/);
  assert.doesNotMatch(render(), /Low workspace disk/);
  assert.match(render(), /aria-label="Disk available"[^>]*aria-valuenow="66.7"/);
  assert.match(render(), /aria-label="Memory free"[^>]*aria-valuenow="50"/);
  assert.doesNotMatch(render(), /Load is a queue average, not CPU utilization/);
  host.runnerStatus!.resources!.workspaceDisk!.availableBytes = 0;
  assert.match(render(), /role="alert"/);
  assert.match(render(), /0.0 GiB \/ 30.0 GiB/);
  assert.match(render(), /remote-resource-meter warning/);
  assert.match(render(), /aria-label="Disk available"[^>]*aria-valuenow="0"/);
  host.runnerStatus!.resources!.workspaceDisk!.totalBytes = 0;
  assert.doesNotMatch(render(), /aria-label="Disk available"/);
  assert.match(render(), /Disk available: unknown/);
  host.runnerStatus!.resources!.workspaceDisk = null;
  assert.match(render(), /Disk available: unknown/);
  assert.doesNotMatch(render(), /0.0 GiB \/ 0.0 GiB/);
  assert.doesNotMatch(render(), /aria-label="Disk available"/);
  host.runnerStatus!.state = "disconnected";
  assert.match(render(), /connect Runner to measure/);
  assert.match(render(), /class="remote-host-resources" aria-label="Runner resources"/);
  assert.doesNotMatch(render(), /CPU:|GiB/);
  assert.doesNotMatch(render(), /role="meter"/);
});

test("resource meters do not turn invalid telemetry into a percentage", () => {
  for (const invalid of [NaN, Infinity, -1, 5 * 1024 ** 3]) {
    const host = buildHost({ runnerStatus: { hostId: "host-1", state: "ready", resources: {
      capturedAt: timestamp, cpuCores: 4, loadAverage1m: 0.25,
      memoryTotalBytes: 4 * 1024 ** 3, memoryFreeBytes: invalid, uptimeSeconds: 7200, workspaceDisk: null,
    } } });
    const html = renderToStaticMarkup(createElement(RunnerResourceSummary, { host }));
    assert.doesNotMatch(html, /role="meter"/);
    assert.match(html, /Memory free: unknown/);
  }
});
const noopToggle = () => undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("host-key failures surface only as structured trust prompts", () => {
  const untrusted = new ApiRequestError("Host key verification failed", 409, "SSH_HOST_KEY_UNTRUSTED", {
    hostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:abc" },
  });
  assert.deepEqual(hostKeyFromError(untrusted), {
    changed: false,
    hostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:abc" },
  });
  assert.equal(hostKeyFromError(new ApiRequestError("changed", 409, "SSH_HOST_KEY_CHANGED", {
    hostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:def" },
  }))?.changed, true);
  assert.equal(hostKeyFromError(new ApiRequestError("boom", 500)), undefined);
  assert.equal(hostKeyFromError(new Error("network")), undefined);
});

test("the machine catalog shows the list first and keeps add forms behind buttons", () => {
  const html = renderToStaticMarkup(createElement(RemoteHostManager, {
    client: {} as ApiClient,
    onError: () => undefined,
  }));

  assert.match(html, /No remote machines registered yet/);
  assert.match(html, /class="secondary-button"[^>]*>Add SSH machine</);
  assert.match(html, /class="secondary-button"[^>]*>Add self-deployed runner</);
  // No blank form competes with the list until the user asks for one.
  assert.doesNotMatch(html, /Probe and add/);
  assert.doesNotMatch(html, /Connect and add/);
});

function buildHost(overrides: Partial<RemoteHostTarget> = {}): RemoteHostTarget {
  return {
    alias: "research-node",
    connectionKind: "ssh",
    createdAt: timestamp,
    id: "host-1",
    runnerCommand: "sciencediscovery-runner",
    status: "ready",
    updatedAt: timestamp,
    ...overrides,
  };
}

async function renderHost(
  host: RemoteHostTarget,
  onCredentialEditStateChange?: (editing: boolean) => void,
): Promise<{ output: string; renderer: ReactTestRenderer }> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(RemoteHostManager, {
      client: { listRemoteHosts: async () => [host] } as ApiClient,
      onCredentialEditStateChange,
      onError: () => undefined,
    }));
  });
  return { output: JSON.stringify(renderer!.toJSON()), renderer: renderer! };
}

test("SSH add form groups connection login and runner details without hiding username", async () => {
  const { renderer } = await renderHost(buildHost());
  const click = async (name: string) => {
    const button = renderer.root.findAllByType("button").find((node) => node.children.join("") === name);
    assert.ok(button);
    await act(async () => button.props.onClick());
  };
  await click("Add SSH machine");
  const form = renderer.root.findByType("form");
  assert.deepEqual(form.findAllByType("legend").map((node) => node.children.join("")), ["1. Connection", "2. Login", "3. Runner details"]);
  const user = form.findByProps({ "aria-describedby": "ssh-add-username-help" });
  assert.equal(user.props.required, undefined, "A matching SSH config may supply User");
  assert.match(form.findByProps({ id: "ssh-add-username-help" }).children.join(""), /requires a username.*exact Host entry.*local username is not used automatically/);
  assert.equal(form.findAllByProps({ type: "password" }).length, 1, "Password is visible before expanding key settings");
  assert.equal(form.findByType("details").props.open, undefined);
  await act(async () => user.props.onChange({ target: { value: "scientist" } }));
  await click("SSH key (optional)");
  assert.equal(form.findByProps({ "aria-describedby": "ssh-add-username-help" }).props.value, "scientist");
  await click("Cancel");
  assert.equal(renderer.root.findAllByType("form").length, 0);
  await click("Add SSH machine");
  assert.equal(renderer.root.findByProps({ "aria-describedby": "ssh-add-username-help" }).props.value, "");
  await act(async () => renderer.unmount());
});

test("machine identity and actions lead the card, with metadata and public key below", async () => {
  const { renderer } = await renderHost(buildHost({
    runnerName: "Analysis", hostName: "192.0.2.40", port: 2222, username: "scientist",
    description: "Analysis", publicKey: "ssh-ed25519 public-test-data", hasPrivateKey: true,
  }));
  const header = renderer.root.findByProps({ className: "remote-host-card-header" });
  assert.equal(header.findByProps({ className: "remote-host-identity" }).findAllByType("span")[0]!.children.join(""), "192.0.2.40:2222");
  assert.equal(header.findByProps({ className: "remote-host-identity" }).findAllByType("span")[1]!.children.join(""), "user scientist");
  assert.equal(header.findByProps({ className: "remote-host-actions" }).findAllByType("button").length, 4);
  assert.equal(header.findAllByType("details").length, 0);
  assert.equal(renderer.root.findAllByProps({ className: "remote-host-description" }).length, 0);
  const details = renderer.root.findByProps({ className: "remote-host-card-details" });
  assert.ok(details.findByProps({ "aria-label": "Runner connection" }));
  assert.ok(details.findByProps({ "aria-label": "Runner resources" }));
  assert.equal(details.findByType("details").props.open, undefined);
  await act(async () => renderer.unmount());
});

test("direct runner identity uses endpoint and token authentication, never an SSH username", async () => {
  const { renderer } = await renderHost(buildHost({ connectionKind: "direct", endpoint: { host: "::1", port: 4311, protocol: "http" }, hasToken: true }));
  const identity = renderer.root.findByProps({ className: "remote-host-identity" });
  assert.equal(identity.findAllByType("span")[0]!.children.join(""), "[::1]:4311");
  assert.equal(identity.findAllByType("span")[1]!.children.join(""), "Token authentication");
  await act(async () => renderer.unmount());
});

test("an SSH authentication failure does not invent missing runner or Node capabilities", async () => {
  const editStates: boolean[] = [];
  const { output, renderer } = await renderHost(buildHost({
    capabilities: undefined,
    error: "SSH authentication failed for scientist@research-node:2222.\nServer offered: publickey, password.\nActually tried: none, password, publickey.\nStored credentials: password yes; key yes.",
    hasPassword: true,
    hasPrivateKey: true,
    status: "error",
    username: "scientist",
  }), (editing) => editStates.push(editing));

  const alert = renderer.root.findByProps({ role: "alert" });
  assert.match(alert.children.join(""), /scientist@research-node:2222/);
  assert.match(alert.children.join(""), /Server offered: publickey, password/);
  assert.match(alert.children.join(""), /Actually tried: none, password, publickey/);
  assert.equal(renderer.root.findAllByType("small").some((node) => node.children.join("").includes("SSH authentication failed")), false);
  assert.match(output, /user scientist/);
  assert.match(output, /password stored · key stored/);
  assert.doesNotMatch(output, /cannot deploy: no runner and no Node\.js 22\+ found/);
  assert.doesNotMatch(output, /OS unknown/);

  const credentials = renderer.root.findAllByType("button")
    .find((button) => button.children.join("") === "Credentials");
  assert.ok(credentials);
  await act(async () => credentials.props.onClick());
  const inputs = renderer.root.findAllByType("input");
  assert.equal(inputs[0]!.props.value, "scientist");
  assert.equal(inputs[1]!.props.value, "");
  assert.equal(inputs[1]!.props.placeholder, "Leave empty to keep the stored one");
  assert.equal(inputs[2]!.props.value, "");
  assert.equal(inputs[2]!.props.placeholder, "Leave empty to keep the stored key");
  assert.match(JSON.stringify(renderer.toJSON()), /Saved values stay hidden/);
  assert.deepEqual(editStates, [true]);
  await act(async () => renderer.unmount());
  assert.deepEqual(editStates, [true, false]);
});

test("a successfully probed Linux host without Node can connect without deployment prose", async () => {
  const { output, renderer } = await renderHost(buildHost({
    capabilities: {
      conda: false,
      containerRuntimes: [],
      cpuCores: 8,
      cuda: null,
      gpu: null,
      memoryBytes: 16 * 1024 ** 3,
      modules: false,
      nodeVersion: null,
      platform: "Linux",
      probedAt: timestamp,
      runnerCommandAvailable: false,
      scratchPaths: [],
      slurm: false,
    },
  }));

  assert.doesNotMatch(output, /SEA runner deployed automatically over SSH; remote Node.js is not required/);
  assert.equal(renderer.root.findAllByType("button").find((node) => node.children.join("") === "Connect runner")!.props.disabled, false);
  await act(async () => renderer.unmount());
});

test("remote Node version does not gate SEA deployment after a successful probe", async () => {
  for (const nodeVersion of [null, "v20.19.0", "invalid", "v22.19.0"]) {
    const { output, renderer } = await renderHost(buildHost({ capabilities: {
      platform: "Linux", nodeVersion, runnerCommandAvailable: false, conda: false, containerRuntimes: [],
      cpuCores: 1, cuda: null, gpu: null, memoryBytes: null, modules: false, probedAt: timestamp, scratchPaths: [], slurm: false,
    } }));
    assert.equal(renderer.root.findAllByType("button").find((node) => node.children.join("") === "Connect runner")!.props.disabled, false);
    assert.equal(output.includes("cannot deploy"), false);
    await act(async () => renderer.unmount());
  }
});

test("generated-key registration resumes trust by host id without resubmitting the consumed path", async () => {
  const errors: string[] = [];
  const registered: RegisterRemoteHostRequest[] = [];
  const trusted: string[] = [];
  const key = { algorithm: "ssh-ed25519", fingerprint: "SHA256:test" };
  let renderer: ReactTestRenderer;
  const client = {
    listRemoteHosts: async () => [],
    generateRemoteHostKey: async () => ({ privateKeyPath: "generated-once.key", publicKey: "ssh-ed25519 public-fixture" }),
    registerRemoteHost: async (body: RegisterRemoteHostRequest) => {
      registered.push(body);
      throw new ApiRequestError("Unknown host key", 409, "SSH_HOST_KEY_UNTRUSTED", { hostId: "saved-host", hostKey: key });
    },
    trustRemoteHostKey: async (id: string) => { trusted.push(id); return buildHost({ id, hasPrivateKey: true }); },
  } as unknown as ApiClient;
  await act(async () => { renderer = create(createElement(RemoteHostManager, { client, onError: (error) => errors.push(error) })); });
  const click = async (label: string) => {
    const button = renderer!.root.findAllByType("button").find((candidate) => candidate.children.join("") === label);
    assert.ok(button, label);
    await act(async () => button.props.onClick());
  };
  await click("Add SSH machine");
  await click("SSH key (optional)");
  await click("Generate a key pair");
  assert.match(JSON.stringify(renderer!.toJSON()), /public-fixture/);
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  assert.equal(registered[0]?.privateKeyPath, "generated-once.key");
  await click("Trust and continue");
  assert.deepEqual(trusted, ["saved-host"]);
  assert.equal(registered.length, 1);
  assert.deepEqual(errors, []);
  await act(async () => renderer!.unmount());
});

test("connect runner presents a changed host key and resumes from the settings trust action", async () => {
  const errors: string[] = [];
  let connects = 0;
  let trusts = 0;
  const host = buildHost();
  let renderer: ReactTestRenderer;
  const client = {
    listRemoteHosts: async () => [host],
    connectRemoteRunner: async () => {
      if (++connects === 1) throw new ApiRequestError("Host key changed", 409, "SSH_HOST_KEY_CHANGED", {
        hostId: host.id, hostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:new" },
      });
      return { hostId: host.id, state: "ready" };
    },
    trustRemoteHostKey: async () => { trusts++; return host; },
  } as unknown as ApiClient;
  await act(async () => { renderer = create(createElement(RemoteHostManager, { client, onError: (error) => errors.push(error) })); });
  const button = (label: string) => renderer!.root.findAllByType("button").find((candidate) => candidate.children.join("") === label)!;
  await act(async () => button("Connect runner").props.onClick());
  assert.match(JSON.stringify(renderer!.toJSON()), /Host key changed/);
  assert.match(JSON.stringify(renderer!.toJSON()), /SHA256:new/);
  await act(async () => button("Trust and continue").props.onClick());
  assert.equal(trusts, 1);
  assert.equal(connects, 2);
  assert.deepEqual(errors, []);
  await act(async () => renderer!.unmount());
});

function buildJob(overrides: Partial<RemoteJob> = {}): RemoteJob {
  return {
    card: {
      command: "python analysis.py --input /scratch/raw.parquet",
      inputPaths: ["/scratch/raw.parquet"],
      mode: "slurm",
      outputs: [{ disposition: "remote", path: "/scratch/model.bin" }],
      remoteWorkingDirectory: "/scratch/project",
      resources: { cpus: 8, gpus: 1, memoryMb: 32768, walltimeMinutes: 60 },
      targetAlias: "institution-hpc",
      targetId: "host-1",
    },
    createdAt: timestamp,
    id: "job-1",
    outputRecords: [{ disposition: "remote", path: "/scratch/model.bin", status: "pending" }],
    scriptReference: "pending:job-1",
    sessionId: "session-1",
    state: "awaiting_approval",
    updatedAt: timestamp,
    version: 1,
    ...overrides,
  };
}

function renderPanel(job: RemoteJob, expandedCards: Record<string, boolean> = {}) {
  return renderToStaticMarkup(createElement(RemoteJobsPanel, {
    busy: false,
    expandedCards,
    jobs: [job],
    onDecision: () => undefined,
    onRefresh: () => undefined,
    onToggleCard: noopToggle,
  }));
}

test("historical jobs cannot be approved or submitted again", () => {
  const html = renderPanel(buildJob());
  assert.match(html, /Historical job/);
  assert.doesNotMatch(html, /Allow once|Allow same type|>Deny</);
});

test("an explicit collapse wins over the awaiting-approval default", () => {
  const job = buildJob();
  const html = renderPanel(job, { [activityCardId("remote-job", job.id)]: false });

  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Allow once/);
});

test("finished jobs default to a collapsed summary", () => {
  const html = renderPanel(buildJob({ state: "completed" }));

  assert.match(html, /SLURM · institution-hpc/);
  assert.match(html, /8 CPU · 32768 MiB · 1 GPU/);
  assert.match(html, /aria-expanded="false"/);
  // Command and outputs stay folded away until expanded.
  assert.doesNotMatch(html, /python analysis\.py/);
  assert.doesNotMatch(html, /leave remote/);
});

test("an explicitly expanded finished job shows its details", () => {
  const job = buildJob({ state: "completed" });
  const html = renderPanel(job, { [activityCardId("remote-job", job.id)]: true });

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /\/scratch\/raw\.parquet/);
  assert.match(html, /leave remote/);
  assert.doesNotMatch(html, /Allow once/);
});

test("historical SLURM jobs have no active refresh action", () => {
  const job = buildJob({ state: "running" });
  const html = renderPanel(job, { [activityCardId("remote-job", job.id)]: true });

  assert.doesNotMatch(html, /Refresh SLURM status/);
});
