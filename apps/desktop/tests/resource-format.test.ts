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

import { createTest } from "../../../test/support/tagged/compat.mjs";

import type { NpuDeviceStatus, NpuInventory, RunnerResources } from "../src/api/types.js";
import {
  diskMeter,
  isDiskLow,
  multiChipCards,
  npuAiCoreHigh,
  npuAiCorePercent,
  npuCardLabel,
  npuMemory,
  npuMemoryPercent,
  npuTemperatureTone,
  REMOTE_DISK_REQUIRED_BYTES,
  resourceBytes,
  resourceMeter,
  uptimeHours,
  usableNpuCards,
} from "../src/app/resource-format.js";

const { describe, it } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

const GIB = 1024 ** 3;

function resources(overrides: Partial<RunnerResources> = {}): RunnerResources {
  return {
    capturedAt: "2026-10-20T00:00:00.000Z",
    cpuCores: 8,
    loadAverage1m: 0.5,
    memoryFreeBytes: 4 * GIB,
    memoryTotalBytes: 16 * GIB,
    uptimeSeconds: 3600 * 5,
    workspaceDisk: { availableBytes: 100 * GIB, path: "/work", totalBytes: 200 * GIB },
    ...overrides,
  };
}

function device(overrides: Partial<NpuDeviceStatus> = {}): NpuDeviceStatus {
  return { chipName: "910B3", health: "OK", hostIndex: 0, sandboxUsable: true, ...overrides };
}

describe("readings in units an operator uses", () => {
  it("reports bytes as GiB with one decimal", () => {
    assert.equal(resourceBytes(1.5 * GIB), "1.5 GiB");
    assert.equal(resourceBytes(0), "0.0 GiB");
  });

  it("reports HBM as used and total when both are known", () => {
    assert.equal(npuMemory(3445, 65536), "3.4 / 64.0 GiB");
  });

  it("reports nothing when one half of the pair is missing", () => {
    assert.equal(npuMemory(3445, undefined), undefined);
    assert.equal(npuMemory(undefined, 65536), undefined);
    // A zero capacity is not a quantity; dividing by it is the reason to check.
    assert.equal(npuMemory(0, 0), undefined);
  });

  it("reports uptime in whole hours", () => {
    assert.equal(uptimeHours(3600 * 5 + 59), 5);
    assert.equal(uptimeHours(-1), 0);
  });
});

describe("a meter refuses what it cannot draw", () => {
  it("rounds to a tenth, so the bar and the number agree", () => {
    assert.equal(resourceMeter(1, 3, "info")?.percent, 33.3);
  });

  it("takes an empty and a full reading as readings", () => {
    assert.equal(resourceMeter(0, 10, "info")?.percent, 0);
    assert.equal(resourceMeter(10, 10, "info")?.percent, 100);
  });

  it("refuses a reading it cannot draw instead of drawing it as zero", () => {
    assert.equal(resourceMeter(Number.NaN, 10, "info"), undefined);
    assert.equal(resourceMeter(1, Number.NaN, "info"), undefined);
    // A zero total would be divided by; a use above the total is impossible.
    assert.equal(resourceMeter(1, 0, "info"), undefined);
    assert.equal(resourceMeter(-1, 10, "info"), undefined);
    assert.equal(resourceMeter(11, 10, "info"), undefined);
  });
});

describe("the workspace disk", () => {
  it("measures what is used, not what is free", () => {
    const meter = diskMeter(resources());
    assert.equal(meter?.value, 100 * GIB);
    assert.equal(meter?.percent, 50);
  });

  it("says nothing at all when the machine reported no disk", () => {
    assert.equal(diskMeter(resources({ workspaceDisk: null })), undefined);
  });

  it("is not low at exactly the required amount, and low below it", () => {
    const exact = resources({
      workspaceDisk: { availableBytes: REMOTE_DISK_REQUIRED_BYTES, path: "/work", totalBytes: 200 * GIB },
    });
    assert.equal(isDiskLow(exact), false);
    const below = resources({
      workspaceDisk: { availableBytes: REMOTE_DISK_REQUIRED_BYTES - 1, path: "/work", totalBytes: 200 * GIB },
    });
    assert.equal(isDiskLow(below), true);
    assert.equal(diskMeter(below)?.tone, "warning");
    assert.equal(diskMeter(exact)?.tone, "success");
  });
});

describe("NPU readings", () => {
  it("takes HBM from the absolute pair when the reader could get it", () => {
    assert.equal(npuMemoryPercent(device({ hbmTotalMb: 1024, hbmUsedMb: 512 })), 50);
  });

  it("falls back to the driver's own ratio", () => {
    assert.equal(npuMemoryPercent(device({ hbmPercent: 12.5 })), 12.5);
  });

  it("prefers the pair over the ratio when the card carries both", () => {
    assert.equal(npuMemoryPercent(device({ hbmPercent: 90, hbmTotalMb: 1024, hbmUsedMb: 256 })), 25);
  });

  it("has no width when the card reported neither form", () => {
    assert.equal(npuMemoryPercent(device()), undefined);
    assert.equal(npuAiCorePercent(device()), undefined);
  });

  it("drops a reading outside 0–100 rather than clamping it into one", () => {
    assert.equal(npuAiCorePercent(device({ aiCorePercent: 140 })), 100);
    assert.equal(npuAiCorePercent(device({ aiCorePercent: Number.NaN })), undefined);
  });

  it("calls a card high at 85% AI core and not below", () => {
    assert.equal(npuAiCoreHigh(device({ aiCorePercent: 85 })), true);
    assert.equal(npuAiCoreHigh(device({ aiCorePercent: 84.9 })), false);
    assert.equal(npuAiCoreHigh(device()), false);
  });

  it("calls a card hot at 75 °C and warm at 60 °C", () => {
    assert.equal(npuTemperatureTone(device({ temperatureCelsius: 74 })), "warm");
    assert.equal(npuTemperatureTone(device({ temperatureCelsius: 75 })), "hot");
    assert.equal(npuTemperatureTone(device({ temperatureCelsius: 59 })), "");
    assert.equal(npuTemperatureTone(device()), "");
  });

  it("names a die separately only on a card that carries several", () => {
    const die = device({ cardId: 3, chipId: 1, chipName: "910C", hostIndex: 7 });
    assert.equal(npuCardLabel(die, true), "NPU 3 · die 1 · 910C（设备 7）");
    assert.equal(npuCardLabel(device({ chipName: "910B3", hostIndex: 4 }), false), "NPU 4 · 910B3");
  });

  it("finds the cards carrying more than one die", () => {
    const inventory: NpuInventory = {
      capturedAt: "2026-10-20T00:00:00.000Z",
      devices: [
        device({ cardId: 0, chipId: 0, hostIndex: 0 }),
        device({ cardId: 0, chipId: 1, hostIndex: 1 }),
        device({ cardId: 1, chipId: 0, hostIndex: 2 }),
      ],
      supported: true,
    };
    assert.deepEqual([...multiChipCards(inventory)], [0]);
  });

  it("counts only the cards a sandbox could actually open", () => {
    const inventory: NpuInventory = {
      capturedAt: "2026-10-20T00:00:00.000Z",
      devices: [device(), device({ hostIndex: 1, sandboxUsable: false })],
      supported: true,
    };
    assert.equal(usableNpuCards(inventory).length, 1);
  });
});
