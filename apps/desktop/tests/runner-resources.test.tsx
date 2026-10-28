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
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself is built with the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { NpuInventory, RemoteHostTarget, RunnerResources } from "../src/api/types.js";
import { TEXT } from "../src/text.js";
import {
  NpuDevicePanel,
  RunnerResourcePanel,
  SshConfigImport,
  SshKeyFileField,
} from "../src/views/settings/RunnerResources.js";
import { StubClient } from "./api-stub.js";

const GIB = 1024 ** 3;
const client = new StubClient().asClient();
const noop = () => {};

function resources(over: Partial<RunnerResources> = {}): RunnerResources {
  return {
    capturedAt: "2026-10-01T09:30:00.000Z",
    cpuCores: 64,
    loadAverage1m: 1.25,
    memoryFreeBytes: 16 * GIB,
    memoryTotalBytes: 64 * GIB,
    uptimeSeconds: 3 * 3600 + 20 * 60,
    workspaceDisk: { availableBytes: 90 * GIB, path: "/data/workspace", totalBytes: 100 * GIB },
    ...over,
  } as RunnerResources;
}

function host(over: Record<string, unknown> = {}): RemoteHostTarget {
  return {
    alias: "gpu-01",
    connectionKind: "direct",
    createdAt: "2026-10-01T08:00:00.000Z",
    id: "runner-1",
    runnerStatus: {
      hostId: "runner-1",
      resources: resources(),
      state: "ready",
    },
    ...over,
  } as unknown as RemoteHostTarget;
}

function inventory(over: Partial<NpuInventory> = {}): NpuInventory {
  return {
    capturedAt: "2026-10-01T09:30:00.000Z",
    devices: [
      { chipName: "910B3", health: "OK", hostIndex: 0, sandboxUsable: true },
      {
        chipName: "910B3",
        health: "OK",
        hostIndex: 1,
        sandboxUnusableReason: "device is claimed by another container",
        sandboxUsable: false,
      },
    ],
    supported: true,
    ...over,
  } as NpuInventory;
}

test("a connected Runner prints its disk, memory, cores, load and uptime", () => {
  const markup = renderToStaticMarkup(<RunnerResourcePanel host={host()} />);

  assert.equal((markup.match(/role="meter"/gu) ?? []).length, 2);
  assert.ok(markup.includes("/data/workspace"));
  // Meters report what is *in use*, so the disk reads 10 of 100 GiB rather than
  // echoing the 90 GiB of free space the API also sends.
  assert.ok(markup.includes("10.0 GiB / 100.0 GiB"));
  // 64 GiB total with 16 GiB free is 48 GiB in use.
  assert.ok(markup.includes("48.0 GiB / 64.0 GiB"));
  assert.match(markup, /<small>CPU 核数<\/small><strong>64<\/strong>/);
  assert.ok(markup.includes("1.25"));
  assert.match(markup, /3 <small>小时<\/small>/);
  // The captured time keeps its machine-readable datetime next to the local one.
  assert.match(markup, /<time dateTime="2026-10-01T09:30:00.000Z">/);
});

test("a machine without readings says so rather than drawing an empty meter", () => {
  const markup = renderToStaticMarkup(
    <RunnerResourcePanel
      host={host({ runnerStatus: { hostId: "runner-1", state: "ready" } })}
    />,
  );

  assert.ok(markup.includes(TEXT.settings.runtime.runner.resources.noMetrics));
  assert.doesNotMatch(markup, /role="meter"/);
});

test("a Runner that never connected does not claim to know its disk", () => {
  const markup = renderToStaticMarkup(
    <RunnerResourcePanel
      host={host({ runnerStatus: { hostId: "runner-1", state: "disconnected" } })}
    />,
  );

  assert.ok(markup.includes(TEXT.settings.runtime.runner.resources.diskUnknown));
  assert.doesNotMatch(markup, /role="meter"/);
});

test("a nearly full workspace disk raises the install warning", () => {
  const markup = renderToStaticMarkup(
    <RunnerResourcePanel
      host={host({
        runnerStatus: {
          hostId: "runner-1",
          resources: resources({ workspaceDisk: { availableBytes: 1 * GIB, path: "/data", totalBytes: 100 * GIB } }),
          state: "ready",
        },
      })}
    />,
  );

  assert.match(markup, /role="alert"/);
  assert.ok(markup.includes("工作区磁盘空间不足"));
});

test("an unreadable disk is an error line, not a zero-byte reading", () => {
  const markup = renderToStaticMarkup(
    <RunnerResourcePanel
      host={host({
        runnerStatus: {
          hostId: "runner-1",
          resources: resources({ workspaceDisk: null, workspaceDiskError: "df: permission denied" }),
          state: "ready",
        },
      })}
    />,
  );

  assert.ok(markup.includes("df: permission denied"));
  assert.equal((markup.match(/role="meter"/gu) ?? []).length, 1);
});

test("every NPU is listed, and an unusable one cannot be ticked", () => {
  const markup = renderToStaticMarkup(
    <NpuDevicePanel
      client={client}
      inventory={inventory()}
      onError={noop}
      onSelected={noop}
      runnerId="runner-1"
      selected={[0]}
    />,
  );

  assert.ok(markup.includes(TEXT.settings.runtime.runner.npu.count(2, 1)));
  assert.ok(markup.includes("NPU 0 · 910B3"));
  assert.ok(markup.includes("NPU 1 · 910B3"));
  assert.ok(markup.includes("device is claimed by another container"));
  // The selected card is ticked; the unusable one is present but disabled. Its
  // disabled attribute is written before the type one, so match the element.
  assert.match(markup, /<input type="checkbox" checked=""/);
  assert.match(markup, /<input disabled="" type="checkbox"/);
});

test("an empty inventory says none were reported, not that none exist", () => {
  const markup = renderToStaticMarkup(
    <NpuDevicePanel
      client={client}
      inventory={inventory({ devices: [] })}
      onError={noop}
      onSelected={noop}
      runnerId="runner-1"
      selected={[]}
    />,
  );

  assert.ok(markup.includes(TEXT.settings.runtime.runner.npu.none));
});

test("an inventory that failed to collect shows the driver's reason", () => {
  const markup = renderToStaticMarkup(
    <NpuDevicePanel
      client={client}
      inventory={inventory({ devices: [], error: "npu-smi not found" })}
      onError={noop}
      onSelected={noop}
      runnerId="runner-1"
      selected={[]}
    />,
  );

  assert.match(markup, /role="alert"[^>]*>npu-smi not found/);
});

test("the ssh_config import is one button until it is opened", () => {
  const markup = renderToStaticMarkup(
    <SshConfigImport client={client} onFailure={noop} onImported={noop} />,
  );

  assert.ok(markup.includes(TEXT.settings.runtime.runner.sshConfig.import));
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /ssh-config-list/);
});

test("the key browser is a path field with a browse control, not a file input", () => {
  const markup = renderToStaticMarkup(
    <SshKeyFileField
      client={client}
      label="私钥文件"
      onChange={noop}
      placeholder="/home/me/.ssh/id_ed25519"
      value=""
    />,
  );

  assert.ok(markup.includes("私钥文件"));
  assert.match(markup, /placeholder="\/home\/me\/\.ssh\/id_ed25519"/);
  assert.ok(markup.includes(TEXT.settings.runtime.runner.keyBrowser.browse));
  assert.doesNotMatch(markup, /type="file"/);
});
