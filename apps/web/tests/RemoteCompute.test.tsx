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

import type { RemoteHostTarget, RemoteJob } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { ApiClient } from "../src/api.js";
import { ApiRequestError } from "../src/api/auth.js";
import { hostKeyFromError } from "../src/api/settings.js";
import { RemoteHostManager, RemoteJobsPanel } from "../src/RemoteCompute.js";
import { activityCardId } from "../src/session/run-activity.js";

const timestamp = "2026-07-15T00:00:00.000Z";
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

test("an SSH authentication failure does not invent missing runner or Node capabilities", async () => {
  const editStates: boolean[] = [];
  const { output, renderer } = await renderHost(buildHost({
    capabilities: undefined,
    error: "All configured authentication methods failed",
    hasPassword: true,
    hasPrivateKey: true,
    status: "error",
    username: "scientist",
  }), (editing) => editStates.push(editing));

  assert.match(output, /All configured authentication methods failed/);
  assert.match(output, /user scientist · password stored · key stored/);
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

test("a successfully probed Linux host without a runner or Node keeps the deployment warning", async () => {
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

  assert.match(output, /Linux · cannot deploy: no runner and no Node\.js 22\+ found/);
  await act(async () => renderer.unmount());
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

test("a job awaiting approval starts expanded so its decision buttons are visible", () => {
  const html = renderPanel(buildJob());

  assert.match(html, /SLURM · institution-hpc/);
  assert.match(html, /awaiting approval/);
  assert.match(html, /aria-expanded="true"/);
  // The approval entry point must not be folded away while the run is blocked.
  assert.match(html, /Allow once/);
  assert.match(html, /Allow same type/);
  assert.match(html, />Deny</);
  assert.equal(html.match(/class="secondary-button"/g)?.length, 2);
  assert.match(html, /class="danger-button"[^>]*>Deny</);
  assert.match(html, /python analysis\.py/);
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

test("running SLURM jobs use the secondary refresh action skeleton", () => {
  const job = buildJob({ state: "running" });
  const html = renderPanel(job, { [activityCardId("remote-job", job.id)]: true });

  assert.match(html, /class="secondary-button"[^>]*>Refresh SLURM status</);
});
