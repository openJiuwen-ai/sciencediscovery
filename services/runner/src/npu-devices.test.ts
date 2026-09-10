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
import { describe, test } from "node:test";

import {
  npuDeviceMapping,
  resolveNpuSelection,
  selectableNpuDevices,
  type NpuDeviceStatus,
  type NpuInventory,
} from "@sciencediscovery/schema";

import { buildSandboxLaunch } from "./executor.js";
import {
  NpuInventoryCache,
  npuDeviceBindArguments,
  npuDevicePath,
  npuProbeFailureReason,
  npuSandboxEnvironment,
  npuSandboxProbeArguments,
  npuSandboxPythonPath,
  parseNpuSmiInfo,
  prepareSandboxNpu,
  resolveExecutionNpu,
  type NpuProbeContext,
} from "./npu-devices.js";

/** Verbatim `npu-smi info` output from the 8-card 910B3 host used for validation. */
const NPU_SMI_910B3 = `+------------------------------------------------------------------------------------------------+
| npu-smi 25.5.1                   Version: 25.5.1                                               |
+---------------------------+---------------+----------------------------------------------------+
| NPU   Name                | Health        | Power(W)    Temp(C)           Hugepages-Usage(page)|
| Chip                      | Bus-Id        | AICore(%)   Memory-Usage(MB)  HBM-Usage(MB)        |
+===========================+===============+====================================================+
| 0     910B3               | OK            | 102.8       45                0    / 0             |
| 0                         | 0000:C1:00.0  | 0           0    / 0          3445 / 65536         |
+===========================+===============+====================================================+
| 5     910B3               | OK            | 100.8       44                0    / 0             |
| 0                         | 0000:02:00.0  | 12          0    / 0          60156/ 65536         |
+===========================+===============+====================================================+
+---------------------------+---------------+----------------------------------------------------+
| NPU     Chip              | Process id    | Process name             | Process memory(MB)      |
+===========================+===============+====================================================+
| 5       0                 | 2290156       | VLLMEngineCore           | 56630                   |
+===========================+===============+====================================================+
`;

const CONTEXT: NpuProbeContext = {
  bwrapPath: "/usr/bin/bwrap",
  disableUserns: true,
  npuSmiPath: "/usr/local/bin/npu-smi",
  procMode: "new",
  toolkitPath: "/usr/local/Ascend/ascend-toolkit/latest",
};

describe("npu-smi parsing", () => {
  test("reads each card's identity, health and usage from the paired rows", () => {
    const devices = parseNpuSmiInfo(NPU_SMI_910B3);
    assert.equal(devices.length, 2);
    assert.deepEqual(devices[0], {
      aiCorePercent: 0,
      busId: "0000:C1:00.0",
      chipName: "910B3",
      health: "OK",
      hbmTotalMb: 65_536,
      hbmUsedMb: 3445,
      hostIndex: 0,
      powerWatts: 102.8,
      sandboxUsable: false,
      temperatureCelsius: 45,
    });
    assert.equal(devices[1]?.hostIndex, 5);
    assert.equal(devices[1]?.aiCorePercent, 12);
    assert.equal(devices[1]?.hbmUsedMb, 60_156);
  });

  test("never reports a card as sandbox-usable straight from the host listing", () => {
    // The host lists cards the sandbox cannot open; usability is probed separately.
    assert.ok(parseNpuSmiInfo(NPU_SMI_910B3).every((device) => !device.sandboxUsable));
  });

  test("skips rows it cannot parse instead of losing the whole table", () => {
    const devices = parseNpuSmiInfo(`${NPU_SMI_910B3}| garbage row without metrics |\n| not-a-number  x | y | z |\n`);
    assert.deepEqual(devices.map((device) => device.hostIndex), [0, 5]);
  });

  test("stops at the process table instead of listing processes as cards", () => {
    // npu-smi prints running processes in a second table whose rows start with
    // the same "<npu> <chip>" shape; parsing them would invent phantom cards.
    const devices = parseNpuSmiInfo(NPU_SMI_910B3);
    assert.deepEqual(devices.map((device) => device.hostIndex), [0, 5]);
    assert.ok(devices.every((device) => /[A-Za-z]/u.test(device.chipName)));
  });

  test("returns nothing for output that holds no device rows", () => {
    assert.deepEqual(parseNpuSmiInfo("dcmi model initialized failed\n"), []);
  });
});

describe("device binds and sandbox numbering", () => {
  test("renumbers the selection from 0 in host order", () => {
    const args = npuDeviceBindArguments([6, 4], ["/dev/davinci_manager"]);
    assert.deepEqual(args, [
      "--dev-bind", "/dev/davinci4", "/dev/davinci0",
      "--dev-bind", "/dev/davinci6", "/dev/davinci1",
      "--dev-bind", "/dev/davinci_manager", "/dev/davinci_manager",
    ]);
  });

  test("gives the same layout however the operator ordered the boxes", () => {
    assert.deepEqual(npuDeviceBindArguments([7, 4, 5], []), npuDeviceBindArguments([5, 7, 4], []));
  });

  test("collapses a repeated card instead of binding it twice", () => {
    // Two names for one card fails the driver's enumeration, so never emit that.
    assert.deepEqual(npuDeviceBindArguments([4, 4], []), ["--dev-bind", "/dev/davinci4", "/dev/davinci0"]);
  });

  test("emits nothing at all when no card was selected", () => {
    assert.deepEqual(npuDeviceBindArguments([], ["/dev/davinci_manager"]), []);
  });

  test("binds only the management nodes this host actually has", () => {
    const args = npuDeviceBindArguments([0], ["/dev/davinci_manager", "/dev/hisi_hdc"]);
    assert.ok(args.includes("/dev/hisi_hdc"));
    assert.ok(!args.includes("/dev/devmm_svm"));
  });

  test("names the host device by index", () => {
    assert.equal(npuDevicePath(13), "/dev/davinci13");
  });
});

describe("sandbox probe argv", () => {
  const probeArgs = npuSandboxProbeArguments({
    context: CONTEXT,
    hostIndex: 6,
    managementDevices: ["/dev/davinci_manager", "/dev/devmm_svm", "/dev/hisi_hdc"],
  });

  test("gives the probed card the sandbox's device 0", () => {
    const at = probeArgs.indexOf("/dev/davinci6");
    assert.equal(probeArgs[at + 1], "/dev/davinci0");
  });

  test("mounts a fresh /dev before binding any card", () => {
    // Binding onto the host's /dev would expose every card and fail enumeration.
    assert.ok(probeArgs.indexOf("--dev") < probeArgs.indexOf("--dev-bind"));
    assert.equal(probeArgs[probeArgs.indexOf("--dev") + 1], "/dev");
    assert.ok(!probeArgs.includes("--dev-bind /dev /dev"));
  });

  test("probes under the same isolation a real execution uses", () => {
    for (const option of ["--unshare-all", "--unshare-user", "--cap-drop", "--disable-userns"]) {
      assert.ok(probeArgs.includes(option), `probe must keep ${option}`);
    }
    assert.equal(probeArgs[probeArgs.indexOf("--cap-drop") + 1], "ALL");
  });

  test("omits --disable-userns when the host's bubblewrap cannot apply it", () => {
    const args = npuSandboxProbeArguments({
      context: { ...CONTEXT, disableUserns: false },
      hostIndex: 0,
      managementDevices: [],
    });
    assert.ok(!args.includes("--disable-userns"));
  });

  test("runs npu-smi as the probe so no interpreter is required", () => {
    assert.deepEqual(probeArgs.slice(-2), ["/usr/local/bin/npu-smi", "info"]);
  });

  test("carries the driver library path the loader needs", () => {
    const value = probeArgs[probeArgs.lastIndexOf("LD_LIBRARY_PATH") + 1] ?? "";
    assert.ok(value.includes("/usr/local/Ascend/driver/lib64/common"));
  });
});

describe("sandbox environment", () => {
  test("includes driver/lib64/common, without which libascend_hal fails to load", () => {
    // libascend_hal.so links libc_sec.so, which lives only in common/.
    const paths = npuSandboxEnvironment(CONTEXT).LD_LIBRARY_PATH.split(":");
    assert.ok(paths.includes("/usr/local/Ascend/driver/lib64/common"));
    assert.ok(paths.includes("/usr/local/Ascend/driver/lib64/driver"));
    assert.ok(paths.includes("/usr/local/Ascend/ascend-toolkit/latest/lib64"));
  });

  test("points the operator compiler at the toolkit's Python packages", () => {
    assert.deepEqual(npuSandboxPythonPath(CONTEXT), [
      "/usr/local/Ascend/ascend-toolkit/latest/python/site-packages",
      "/usr/local/Ascend/ascend-toolkit/latest/opp/built-in/op_impl/ai_core/tbe",
    ]);
  });

  test("follows a relocated toolkit", () => {
    const env = npuSandboxEnvironment({ toolkitPath: "/opt/ascend/latest" });
    assert.equal(env.ASCEND_TOOLKIT_HOME, "/opt/ascend/latest");
    assert.equal(env.ASCEND_OPP_PATH, "/opt/ascend/latest/opp");
  });
});

describe("prepareSandboxNpu", () => {
  test("stays out of the launch entirely when nothing was selected", async () => {
    assert.equal(await prepareSandboxNpu([], CONTEXT), undefined);
  });

  test("reports how the selected cards appear inside the sandbox", async () => {
    const npu = await prepareSandboxNpu([5, 4], CONTEXT);
    assert.deepEqual(npu?.mapping, [
      { hostIndex: 4, sandboxIndex: 0 },
      { hostIndex: 5, sandboxIndex: 1 },
    ]);
  });
});

describe("probe failure reasons", () => {
  test("surfaces the driver's own explanation, not the log-level noise", () => {
    const error = Object.assign(new Error("Command failed"), {
      stderr: "DrvMngGetConsoleLogLevel failed. (ret=4)\n"
        + "dcmi model initialized failed, because the device is used. ret is -8020\n",
    });
    assert.equal(
      npuProbeFailureReason(error, 0),
      "NPU 0 cannot be opened inside the sandbox: dcmi model initialized failed, because the device is used. ret is -8020",
    );
  });

  test("falls back to the process error when the probe printed nothing", () => {
    assert.match(npuProbeFailureReason(new Error("spawn ENOENT"), 3), /NPU 3 .*spawn ENOENT/u);
  });
});

describe("inventory cache", () => {
  const inventory = (capturedAt: string) => ({ capturedAt, devices: [], supported: true });

  test("serves a fresh inventory instead of re-probing every card", async () => {
    const cache = new NpuInventoryCache(60_000);
    let loads = 0;
    const load = async () => { loads += 1; return inventory(new Date(1_000).toISOString()); };
    await cache.get(load, 1_000);
    await cache.get(load, 2_000);
    assert.equal(loads, 1);
  });

  test("re-probes once the inventory is older than the cache window", async () => {
    const cache = new NpuInventoryCache(1_000);
    let loads = 0;
    const load = async () => { loads += 1; return inventory(new Date(loads * 1_000).toISOString()); };
    await cache.get(load, 1_000);
    await cache.get(load, 9_000);
    assert.equal(loads, 2);
  });

  test("re-probes after an explicit refresh", async () => {
    const cache = new NpuInventoryCache(60_000);
    let loads = 0;
    const load = async () => { loads += 1; return inventory(new Date(1_000).toISOString()); };
    await cache.get(load, 1_000);
    cache.invalidate();
    await cache.get(load, 1_100);
    assert.equal(loads, 2);
  });

  test("lets a failed probe be retried rather than caching the failure", async () => {
    const cache = new NpuInventoryCache(60_000);
    await assert.rejects(cache.get(async () => { throw new Error("probe failed"); }, 1_000));
    const recovered = await cache.get(async () => inventory(new Date(2_000).toISOString()), 2_000);
    assert.equal(recovered.supported, true);
  });
});

describe("which cards an operator may tick", () => {
  const device = (hostIndex: number, overrides: Partial<NpuDeviceStatus> = {}): NpuDeviceStatus => ({
    chipName: "910B3",
    health: "OK",
    hostIndex,
    sandboxUsable: true,
    ...overrides,
  });
  const inventory = (devices: NpuDeviceStatus[]): NpuInventory => ({
    capturedAt: "2026-09-10T00:00:00.000Z",
    devices,
    supported: true,
  });

  test("offers only the cards the sandbox probe could open", () => {
    const listed = inventory([
      device(0, { sandboxUsable: false, sandboxUnusableReason: "already claimed" }),
      device(4),
      device(6),
    ]);
    assert.deepEqual(selectableNpuDevices(listed).map((entry) => entry.hostIndex), [4, 6]);
  });

  test("offers nothing on a machine without Ascend cards", () => {
    assert.deepEqual(selectableNpuDevices(undefined), []);
    assert.deepEqual(selectableNpuDevices({ capturedAt: "", devices: [], supported: false }), []);
  });

  test("refuses a card the sandbox cannot open and says why", () => {
    const listed = inventory([
      device(0, { sandboxUsable: false, sandboxUnusableReason: "NPU 0 cannot be opened: device is used" }),
      device(4),
    ]);
    const resolved = resolveNpuSelection([0, 4], listed);
    assert.deepEqual(resolved.accepted, [4]);
    assert.deepEqual(resolved.rejected, [
      { hostIndex: 0, reason: "NPU 0 cannot be opened: device is used" },
    ]);
  });

  test("renumbers what survived so the sandbox still starts at 0", () => {
    const listed = inventory([device(0, { sandboxUsable: false }), device(5), device(7)]);
    const resolved = resolveNpuSelection([7, 5, 0], listed);
    assert.deepEqual(resolved.mapping, [
      { hostIndex: 5, sandboxIndex: 0 },
      { hostIndex: 7, sandboxIndex: 1 },
    ]);
  });

  test("refuses a card that has since disappeared from the machine", () => {
    const resolved = resolveNpuSelection([9], inventory([device(4)]));
    assert.deepEqual(resolved.accepted, []);
    assert.match(resolved.rejected[0]?.reason ?? "", /no longer present/u);
  });

  test("explains an NPU selection on a machine that has no NPUs", () => {
    const resolved = resolveNpuSelection([0], { capturedAt: "", devices: [], supported: false });
    assert.match(resolved.rejected[0]?.reason ?? "", /no Ascend NPU cards/u);
  });

  test("accepts a repeated tick once", () => {
    const resolved = resolveNpuSelection([4, 4], inventory([device(4)]));
    assert.deepEqual(resolved.accepted, [4]);
    assert.deepEqual(resolved.rejected, []);
  });

  test("maps an empty selection to an empty layout", () => {
    assert.deepEqual(npuDeviceMapping([]), []);
  });
});

describe("sandbox launch with NPU cards", () => {
  const npuLaunch = async (selection: number[]) => buildSandboxLaunch({
    chdir: "/workspace",
    disableUserns: true,
    environmentBinds: [],
    hostInterpreterMasks: [],
    hostRuntimeSupport: { bindArgs: [], env: {} },
    language: "python",
    npu: await prepareSandboxNpu(selection, CONTEXT),
    pathEnv: "/usr/bin",
    procMode: "new",
    workspaceBindArgs: ["--bind", "/data/workspace", "/workspace"],
  });

  test("binds the selected cards onto a fresh /dev, renumbered from 0", async () => {
    const args = (await npuLaunch([6, 4])).args;
    const devAt = args.indexOf("--dev");
    assert.equal(args[devAt + 1], "/dev");
    // Ordering matters: the binds must land on the fresh tmpfs, not the host /dev.
    assert.ok(devAt < args.indexOf("--dev-bind"));
    assert.equal(args[args.indexOf("/dev/davinci4") + 1], "/dev/davinci0");
    assert.equal(args[args.indexOf("/dev/davinci6") + 1], "/dev/davinci1");
  });

  test("never exposes a host card the operator did not select", async () => {
    // Only the bind sources name host cards; the destinations are the sandbox's
    // own renumbered nodes, so /dev/davinci0 legitimately appears as a target.
    const args = (await npuLaunch([4])).args;
    const boundHostDevices = args
      .map((arg, at) => (args[at - 1] === "--dev-bind" ? arg : undefined))
      .filter((arg): arg is string => arg !== undefined && arg.startsWith("/dev/davinci")
        && /\d$/u.test(arg));
    assert.deepEqual(boundHostDevices, ["/dev/davinci4"]);
  });

  test("keeps the sandbox byte-for-byte unchanged when no card was selected", async () => {
    const withoutNpu = (await npuLaunch([])).args;
    assert.ok(!withoutNpu.some((arg) => arg.startsWith("/dev/davinci")));
    assert.ok(!withoutNpu.includes("ASCEND_TOOLKIT_HOME"));
  });

  test("keeps the sandbox's isolation while the cards are bound", async () => {
    const args = (await npuLaunch([4])).args;
    for (const option of ["--unshare-all", "--unshare-user", "--die-with-parent", "--new-session"]) {
      assert.ok(args.includes(option), `expected ${option}`);
    }
    assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
    assert.equal(args.at(-2), "--seccomp");
  });

  test("restates the CANN environment that --clearenv would otherwise wipe", async () => {
    const launch = await npuLaunch([4]);
    assert.equal(launch.env.ASCEND_TOOLKIT_HOME, "/usr/local/Ascend/ascend-toolkit/latest");
    assert.ok(launch.env.LD_LIBRARY_PATH?.includes("/usr/local/Ascend/driver/lib64/common"));
    assert.ok(launch.env.PYTHONPATH?.includes("/opp/built-in/op_impl/ai_core/tbe"));
  });

  test("adds the operator compiler to PYTHONPATH rather than replacing it", async () => {
    const launch = buildSandboxLaunch({
      chdir: "/workspace",
      disableUserns: true,
      environmentBinds: [],
      hostInterpreterMasks: [],
      hostRuntimeSupport: { bindArgs: [], env: {} },
      language: "python",
      npu: await prepareSandboxNpu([4], CONTEXT),
      pathEnv: "/usr/bin",
      procMode: "new",
      pythonPathEnv: "/env/site-packages",
      workspaceBindArgs: [],
    });
    assert.ok(launch.env.PYTHONPATH?.startsWith("/env/site-packages:"));
    assert.ok(launch.env.PYTHONPATH?.includes("/python/site-packages"));
  });
});

describe("validating a selection at launch time", () => {
  const inventory = (devices: NpuDeviceStatus[]) => async () => ({
    capturedAt: "2026-09-10T00:00:00.000Z",
    devices,
    supported: true,
  });
  const usable = (hostIndex: number): NpuDeviceStatus => ({
    chipName: "910B3", health: "OK", hostIndex, sandboxUsable: true,
  });

  test("skips the inventory entirely for an execution that wants no card", async () => {
    let consulted = false;
    const npu = await resolveExecutionNpu({
      bwrapPath: "/usr/bin/bwrap",
      npuInventory: async () => { consulted = true; throw new Error("must not be consulted"); },
    }, undefined);
    assert.equal(npu, undefined);
    assert.equal(consulted, false);
  });

  test("builds the device plumbing for cards that are still usable", async () => {
    const npu = await resolveExecutionNpu({
      bwrapPath: "/usr/bin/bwrap",
      npuInventory: inventory([usable(4), usable(6)]),
    }, [6, 4]);
    assert.deepEqual(npu?.mapping, [
      { hostIndex: 4, sandboxIndex: 0 },
      { hostIndex: 6, sandboxIndex: 1 },
    ]);
  });

  test("fails the execution by name when a card stopped being usable", async () => {
    // A shared machine can lose a card between the tick and the run; failing
    // here beats failing deep inside the framework with no card named.
    await assert.rejects(
      resolveExecutionNpu({
        bwrapPath: "/usr/bin/bwrap",
        npuInventory: inventory([
          { chipName: "910B3", health: "OK", hostIndex: 4, sandboxUsable: false,
            sandboxUnusableReason: "NPU 4 cannot be opened inside the sandbox: device is used" },
        ]),
      }, [4]),
      (error: Error) => {
        assert.equal(error.name, "NpuDevicesUnavailableError");
        assert.match(error.message, /NPU 4 cannot be opened inside the sandbox: device is used/u);
        return true;
      },
    );
  });

  test("refuses the whole execution rather than quietly running on fewer cards", async () => {
    await assert.rejects(resolveExecutionNpu({
      bwrapPath: "/usr/bin/bwrap",
      npuInventory: inventory([usable(4)]),
    }, [4, 5]), /NPU 5/u);
  });
});
