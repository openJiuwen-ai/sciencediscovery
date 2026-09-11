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
import { ConnectLogPanel, NpuDeviceSelector, RemoteHostManager, RemoteJobsPanel, RunnerResourceSummary } from "../src/RemoteCompute.js";
import { activityCardId } from "../src/session/run-activity.js";

const timestamp = "2026-07-15T00:00:00.000Z";
test("resource cards distinguish available workspace disk, low space, and unavailable readings", () => {
  const host = buildHost({ runnerStatus: { hostId: "host-1", state: "ready", resources: {
    capturedAt: timestamp, cpuCores: 4, loadAverage1m: 0.25,
    memoryTotalBytes: 4 * 1024 ** 3, memoryFreeBytes: 2 * 1024 ** 3, uptimeSeconds: 7200,
    workspaceDisk: { path: "/data/remote-workspaces", availableBytes: 20 * 1024 ** 3, totalBytes: 30 * 1024 ** 3 },
  } } });
  const render = () => renderToStaticMarkup(createElement(RunnerResourceSummary, { host }));
  assert.match(render(), /10.0 GiB \/ 30.0 GiB/);
  assert.match(render(), /\/data\/remote-workspaces/);
  assert.doesNotMatch(render(), /not a per-workspace quota|reclaimable caches|Host snapshot/);
  assert.doesNotMatch(render(), /Low workspace disk/);
  assert.match(render(), /aria-label="Disk used"[^>]*aria-valuenow="33.3"/);
  assert.match(render(), /aria-label="Memory used"[^>]*aria-valuenow="50"/);
  // Hundreds of GiB free on a multi-TiB disk is not low: the warning is an
  // absolute estimate (Runner + two base conda envs), not a percentage.
  host.runnerStatus!.resources!.workspaceDisk = { path: "/data/remote-workspaces", availableBytes: 599 * 1024 ** 3, totalBytes: 6003 * 1024 ** 3 };
  assert.doesNotMatch(render(), /Low workspace disk/);
  host.runnerStatus!.resources!.workspaceDisk = { path: "/data/remote-workspaces", availableBytes: 3 * 1024 ** 3, totalBytes: 6003 * 1024 ** 3 };
  const low = render();
  assert.match(low, /Low workspace disk space: 3\.0 GiB free, about 5\.0 GiB needed/);
  host.runnerStatus!.resources!.workspaceDisk = { path: "/data/remote-workspaces", availableBytes: 20 * 1024 ** 3, totalBytes: 30 * 1024 ** 3 };
  host.runnerStatus!.resources!.workspaceDisk!.availableBytes = 30 * 1024 ** 3;
  host.runnerStatus!.resources!.memoryFreeBytes = 4 * 1024 ** 3;
  assert.match(render(), /aria-label="Disk used"[^>]*aria-valuenow="0"/);
  assert.match(render(), /aria-label="Memory used"[^>]*aria-valuenow="0"/);
  host.runnerStatus!.resources!.memoryFreeBytes = 0;
  assert.match(render(), /aria-label="Memory used"[^>]*aria-valuenow="100"/);
  assert.doesNotMatch(render(), /Load is a queue average, not CPU utilization/);
  host.runnerStatus!.resources!.workspaceDisk!.availableBytes = 0;
  assert.match(render(), /role="alert"/);
  assert.match(render(), /30.0 GiB \/ 30.0 GiB/);
  assert.match(render(), /remote-resource-meter warning/);
  assert.match(render(), /aria-label="Disk used"[^>]*aria-valuenow="100"/);
  host.runnerStatus!.resources!.workspaceDisk!.totalBytes = 0;
  assert.doesNotMatch(render(), /aria-label="Disk used"/);
  assert.match(render(), /Disk used: unknown/);
  host.runnerStatus!.resources!.workspaceDisk = null;
  assert.match(render(), /Disk used: unknown/);
  assert.doesNotMatch(render(), /0.0 GiB \/ 0.0 GiB/);
  assert.doesNotMatch(render(), /aria-label="Disk used"/);
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
    assert.match(html, /Memory used: unknown/);
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
  assert.match(html, /class="secondary-button"[^>]*>Add Runner</);
  assert.doesNotMatch(html, /<form/);
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

/** A machine with no Ascend cards, which is what most of these tests are about. */
const noNpu = async () => ({ local: null, selections: {} });

async function renderHost(
  host: RemoteHostTarget,
  onCredentialEditStateChange?: (editing: boolean) => void,
): Promise<{ output: string; renderer: ReactTestRenderer }> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(RemoteHostManager, {
      client: { listRunners: async () => [host], listRunnerNpuDevices: noNpu } as ApiClient,
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
  await click("Add Runner");
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
  await click("Add Runner");
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
  assert.equal(header.findByProps({ className: "remote-host-actions" }).findAllByType("button").length, 5);
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
    listRunners: async () => [],
    listRunnerNpuDevices: noNpu,
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
  await click("Add Runner");
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
    listRunners: async () => [host],
    listRunnerNpuDevices: noNpu,
    remoteRunnerConnectLog: async () => ({ entries: [], hostId: host.id }),
    connectRunner: async () => {
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

/** One usable card and one the sandbox probe refused, as the 910B host reports. */
const NPU_INVENTORY = {
  capturedAt: timestamp,
  supported: true,
  devices: [
    { chipName: "910B3", health: "OK", hostIndex: 0, hbmUsedMb: 3445, hbmTotalMb: 65_536,
      aiCorePercent: 0, temperatureCelsius: 45, sandboxUsable: false,
      sandboxUnusableReason: "NPU 0 cannot be opened inside the sandbox: dcmi model initialized failed, because the device is used. ret is -8020" },
    { chipName: "910B3", health: "OK", hostIndex: 4, hbmUsedMb: 3418, hbmTotalMb: 65_536,
      aiCorePercent: 12, temperatureCelsius: 49, powerWatts: 68.4, sandboxUsable: true },
  ],
};

const npuClient = (calls: Array<{ devices: number[]; runnerId: string }> = []): ApiClient => ({
  setRunnerNpuDevices: async (runnerId: string, devices: number[]) => {
    calls.push({ devices, runnerId });
    return { devices, runnerId };
  },
} as unknown as ApiClient);

const renderNpu = (overrides: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(NpuDeviceSelector, {
  client: npuClient(), inventory: NPU_INVENTORY, onError: () => {}, onSelected: () => {},
  runnerId: "host-1", selected: [4], ...overrides,
} as never));

test("NPU cards list every card with its status and usage, including unusable ones", () => {
  const markup = renderNpu();
  // Both cards are listed: hiding the unusable one would leave the operator
  // wondering where NPU 0 went.
  assert.match(markup, /NPU 0 · 910B3/);
  assert.match(markup, /NPU 4 · 910B3/);
  assert.match(markup, /3\.4 \/ 64\.0 GiB/);
  assert.match(markup, /12% AI core/);
  assert.match(markup, /49 °C/);
  assert.match(markup, /68 W/);
  assert.match(markup, /2 on this machine · 1 usable in the sandbox/);
});

test("a card the sandbox probe refused cannot be ticked and says why on the row", () => {
  const markup = renderNpu();
  const unusableRow = /<li class="unusable">([\s\S]*?)<\/li>/.exec(markup)?.[1] ?? "";
  assert.match(unusableRow, /disabled=""/);
  assert.match(unusableRow, /because the device is used/);
  const usableRow = /<li class="">([\s\S]*?)<\/li>/.exec(markup)?.[1] ?? "";
  assert.doesNotMatch(usableRow, /disabled/);
  assert.match(usableRow, /checked=""/);
});

test("the checkbox and its card name stay on one reading line", () => {
  // One label wraps both, so the control can never wrap away from its name.
  assert.match(renderNpu(), /<label class="remote-npu-pick"><input type="checkbox"[^>]*\/><span class="remote-npu-name">NPU 0/);
});

test("the connect log panel lists every step with its timestamp", () => {
  const markup = renderToStaticMarkup(createElement(ConnectLogPanel, {
    entries: [
      { at: "2026-09-11T05:00:00.000Z", line: "Connecting to lab over SSH…" },
      { at: "2026-09-11T05:00:03.000Z", line: "Runner is ready (version 1.2.3)." },
    ],
    live: true,
  }));
  assert.match(markup, /role="log"/);
  assert.match(markup, /Connection progress/);
  assert.match(markup, /updating live/);
  assert.match(markup, /Connecting to lab over SSH/);
  assert.match(markup, /Runner is ready \(version 1\.2\.3\)\./);
  assert.match(markup, /remote-connect-log live/);
});

test("an idle connect log panel says it is waiting rather than showing nothing", () => {
  const markup = renderToStaticMarkup(createElement(ConnectLogPanel, { entries: [], live: true }));
  assert.match(markup, /Waiting for the first step/);
  assert.doesNotMatch(markup, /remote-connect-log-line/);
});

const clickButton = async (renderer: ReactTestRenderer, label: string) => {
  const button = renderer.root.findAllByType("button").find((node) => node.children.join("") === label);
  assert.ok(button, `no button labelled ${label}`);
  await act(async () => button.props.onClick());
};

test("ticking a card saves the selection against the Runner it belongs to", async () => {
  const calls: Array<{ devices: number[]; runnerId: string }> = [];
  let saved: number[] = [];
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(NpuDeviceSelector, {
      client: npuClient(calls), inventory: NPU_INVENTORY, onError: () => {},
      onSelected: (devices: number[]) => { saved = devices; }, runnerId: "host-1", selected: [],
    } as never));
  });
  const boxes = renderer!.root.findAllByType("input");
  await act(async () => { boxes[1]!.props.onChange({ target: { checked: true } }); });
  // Ticking is a draft: nothing is written until the operator says so, so a
  // four-card plan costs one write instead of four.
  assert.deepEqual(calls, []);
  assert.equal(renderer!.root.findAllByType("input")[1]!.props.checked, true, "the tick shows immediately");
  await clickButton(renderer!, "Save selection");
  assert.deepEqual(calls, [{ devices: [4], runnerId: "host-1" }]);
  assert.deepEqual(saved, [4]);
  // Saved: the actions disappear until something changes again.
  assert.equal(renderer!.root.findAllByType("button").length, 0);
});

test("a draft can be discarded and a rejected save keeps what was picked", async () => {
  const calls: Array<{ devices: number[]; runnerId: string }> = [];
  const errors: string[] = [];
  let renderer: ReactTestRenderer | undefined;
  const failing = {
    setRunnerNpuDevices: async (runnerId: string, devices: number[]) => {
      calls.push({ devices, runnerId });
      throw new Error("NPU 4 cannot be opened inside the sandbox");
    },
  } as unknown as ApiClient;
  await act(async () => {
    renderer = create(createElement(NpuDeviceSelector, {
      client: failing, inventory: NPU_INVENTORY, onError: (message: string) => errors.push(message),
      onSelected: () => {}, runnerId: "host-1", selected: [],
    } as never));
  });
  await act(async () => { renderer!.root.findAllByType("input")[1]!.props.onChange({ target: { checked: true } }); });
  await clickButton(renderer!, "Save selection");
  assert.deepEqual(errors, ["NPU 4 cannot be opened inside the sandbox"]);
  // The Runner refusing one card must not throw away what was picked.
  assert.equal(renderer!.root.findAllByType("input")[1]!.props.checked, true);
  await clickButton(renderer!, "Discard");
  assert.equal(renderer!.root.findAllByType("input")[1]!.props.checked, false);
  assert.equal(renderer!.root.findAllByType("button").length, 0, "a discarded draft leaves nothing to save");
  assert.equal(calls.length, 1);
});

test("the same control saves against the local Runner when that is the machine", async () => {
  // Local and remote must behave identically; only the Runner id differs.
  const calls: Array<{ devices: number[]; runnerId: string }> = [];
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(NpuDeviceSelector, {
      client: npuClient(calls), inventory: NPU_INVENTORY, onError: () => {},
      onSelected: () => {}, runnerId: "local", selected: [],
    } as never));
  });
  await act(async () => { renderer!.root.findAllByType("input")[1]!.props.onChange({ target: { checked: true } }); });
  await clickButton(renderer!, "Save selection");
  assert.deepEqual(calls, [{ devices: [4], runnerId: "local" }]);
});

test("a card that became unusable while ticked can still be unticked", async () => {
  // The card was usable when the operator ticked it and has since been claimed
  // by another tenant. Disabling its checkbox would leave the selection stuck
  // with a card every execution refuses.
  const calls: Array<{ devices: number[]; runnerId: string }> = [];
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(NpuDeviceSelector, {
      client: npuClient(calls), inventory: NPU_INVENTORY, onError: () => {},
      onSelected: () => {}, runnerId: "host-1", selected: [0, 4],
    } as never));
  });
  const unusable = renderer!.root.findAllByType("input")[0]!;
  assert.equal(unusable.props.checked, true);
  assert.equal(unusable.props.disabled, false, "a ticked card is always removable");
  await act(async () => { unusable.props.onChange({ target: { checked: false } }); });
  await clickButton(renderer!, "Save selection");
  assert.deepEqual(calls, [{ devices: [4], runnerId: "host-1" }]);
  // It says why it is unusable and what unticking it achieves.
  assert.match(JSON.stringify(renderer!.toJSON()), /untick it to run without it/);
});

test("an unusable card that is not ticked still cannot be ticked", () => {
  const markup = renderNpu({ selected: [] });
  const unusableRow = /<li class="unusable">([\s\S]*?)<\/li>/.exec(markup)?.[1] ?? "";
  assert.match(unusableRow, /disabled=""/);
});

test("a machine whose cards are all unusable says so instead of offering an empty tick list", () => {
  const inventory = { ...NPU_INVENTORY, devices: NPU_INVENTORY.devices.map((device) => ({ ...device, sandboxUsable: false })) };
  assert.match(renderNpu({ inventory }), /No card on this machine can currently be opened inside a sandbox/);
});

test("a machine without Ascend cards shows no NPU section at all", () => {
  assert.equal(renderNpu({ inventory: null }), "");
});

test("the Local Runner card offers this machine's own cards and saves them under `local`", async () => {
  // The 910B can be the machine the product runs on, so ticking its cards must
  // not require registering this machine as a remote one first.
  const calls: Array<{ devices: number[]; runnerId: string }> = [];
  const client = {
    listRunners: async () => [buildHost({ id: "local", alias: "local", connectionKind: "direct", runnerStatus: { hostId: "local", state: "ready" } })],
    listRunnerNpuDevices: async () => ({ local: NPU_INVENTORY, selections: { local: [] } }),
    setRunnerNpuDevices: async (runnerId: string, devices: number[]) => { calls.push({ devices, runnerId }); return { devices, runnerId }; },
  } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  await act(async () => { renderer = create(createElement(RemoteHostManager, { client, onError: () => {} })); });
  const localCard = renderer!.root.findAllByProps({ className: "remote-host-card ready" })[0]!;
  assert.ok(localCard.findAllByProps({ className: "remote-npu-name" }).some((node) => node.children.join("").includes("NPU 4 · 910B3")));
  const boxes = localCard.findAllByType("input");
  await act(async () => { boxes[1]!.props.onChange({ target: { checked: true } }); });
  await clickButton(renderer!, "Save selection");
  assert.deepEqual(calls, [{ devices: [4], runnerId: "local" }]);
  // The tick sticks after the save round-trip, so the operator sees what is stored.
  assert.equal(localCard.findAllByType("input")[1]!.props.checked, true);
  await act(async () => renderer!.unmount());
});
