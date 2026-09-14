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

/**
 * Ascend NPU support for the sandbox, scoped to 910B hosts.
 *
 * Two facts drive every decision here, both established on a real 8-card 910B3
 * machine rather than inferred from documentation:
 *
 *  1. Once a process enters a mount namespace the driver switches to a
 *     container view and reports the cards visible under the caller's `/dev`
 *     instead of the machine's physical card count. Binding the host's whole
 *     `/dev` therefore offers every card at once, and the enumeration is
 *     all-or-nothing: one card that cannot be claimed fails the whole call
 *     with `DRV_ERROR_RESOURCE_OCCUPIED`. The sandbox must be given a fresh
 *     `/dev` holding only the cards it may use.
 *  2. Because of that same all-or-nothing behaviour, whether a card works is
 *     not knowable from the host listing. `npu-smi` on the host happily
 *     reports cards that a sandbox cannot open, so each card is probed by
 *     launching a throwaway sandbox that binds only that card.
 *
 * The sandbox always sees its cards numbered from 0 regardless of their host
 * index, so code inside can target device 0 without knowing the machine.
 */

import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  NpuDeviceMapping,
  NpuDeviceSelection,
  NpuDeviceStatus,
  NpuInventory,
  RejectedNpuDevice,
} from "@sciencediscovery/schema";
import { npuDeviceMapping, resolveNpuSelection } from "@sciencediscovery/schema";
import { procMountArguments, type SandboxProcMode } from "@sciencediscovery/sandbox-capability";

const execFileAsync = promisify(execFile);

/** Host management nodes every Ascend workload needs alongside its cards. */
export const NPU_MANAGEMENT_DEVICES = ["/dev/davinci_manager", "/dev/devmm_svm", "/dev/hisi_hdc"] as const;

/** Candidate `npu-smi` locations; 910B images ship it in one of these. */
const NPU_SMI_CANDIDATES = ["/usr/local/bin/npu-smi", "/usr/local/sbin/npu-smi", "/usr/bin/npu-smi"] as const;

/** Where a host Python usually is; only used to read the driver through DCMI. */
const NPU_PYTHON_CANDIDATES = ["/usr/bin/python3", "/usr/local/bin/python3"] as const;

/** Ascend install roots. Overridable for hosts that relocate the toolkit. */
const ASCEND_ROOT = "/usr/local/Ascend";
const ASCEND_TOOLKIT = `${ASCEND_ROOT}/ascend-toolkit/latest`;
/** The driver's install record; the sandbox needs it or the driver warns. */
const ASCEND_INSTALL_INFO = "/etc/ascend_install.info";

/**
 * The Ascend 910 series is what this supports: 910A, 910B, 910C and their
 * variants. Other chips are listed but never offered — notably 310 development
 * boards, whose driver differs enough that pretending to support them would be
 * a promise this code cannot keep.
 */
const SUPPORTED_CHIP_PATTERN = /910/u;

/** A cold probe spawns bubblewrap and npu-smi; generous but still bounded. */
export const NPU_PROBE_TIMEOUT_MS = 20_000;

/** Inventory is re-probed at most this often: probing costs one sandbox per card. */
export const NPU_INVENTORY_TTL_MS = 60_000;

export interface NpuHostTools {
  /** Absolute path to `npu-smi`, or undefined when the host has no Ascend tooling. */
  npuSmiPath?: string;
  /** Host Python used to read the driver through DCMI; absent falls back to npu-smi. */
  pythonPath?: string;
  /** Ascend toolkit root used for the sandbox library and Python paths. */
  toolkitPath: string;
}

export interface NpuProbeContext extends NpuHostTools {
  bwrapPath: string;
  disableUserns: boolean;
  procMode: SandboxProcMode;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Locate the host's Ascend tooling. Absent tooling is a normal, non-Ascend host. */
export async function resolveNpuHostTools(env: NodeJS.ProcessEnv = process.env): Promise<NpuHostTools> {
  const toolkitPath = env.SCIENCE_AGENT_ASCEND_TOOLKIT?.trim() || ASCEND_TOOLKIT;
  // The host Python is only used to read the driver through DCMI. An Ascend
  // host has one because CANN itself needs one, but a machine without it still
  // works: npu-smi answers the same questions.
  const configuredPython = env.SCIENCE_AGENT_NPU_PYTHON_PATH?.trim();
  let pythonPath: string | undefined;
  for (const candidate of configuredPython ? [configuredPython] : NPU_PYTHON_CANDIDATES) {
    if (await isExecutable(candidate)) { pythonPath = candidate; break; }
  }
  const configured = env.SCIENCE_AGENT_NPU_SMI_PATH?.trim();
  if (configured) {
    return { npuSmiPath: await isExecutable(configured) ? configured : undefined, ...(pythonPath ? { pythonPath } : {}), toolkitPath };
  }
  for (const candidate of NPU_SMI_CANDIDATES) {
    if (await isExecutable(candidate)) return { npuSmiPath: candidate, ...(pythonPath ? { pythonPath } : {}), toolkitPath };
  }
  return { ...(pythonPath ? { pythonPath } : {}), toolkitPath };
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `| 0     910B3               | OK            | 102.8       45     0    / 0  |` */
const DEVICE_HEAD_PATTERN = /^(\d+)\s+(\S.*?)\s*$/u;
/** `| 0                         | 0000:C1:00.0  | 0     0 / 0     3445 / 65536 |` */
const CHIP_ROW_PATTERN = /^(\d+)$/u;
const HEAD_METRICS_PATTERN = /^(\S+)\s+(\S+)\s+/u;
const CHIP_METRICS_PATTERN = /^(\S+)\s+(\S+)\s*\/\s*(\S+)\s+(\S+)\s*\/\s*(\S+)\s*$/u;

/**
 * Parse the `npu-smi info` table. The table pairs rows: a board row carrying
 * the NPU id, chip name, health, power and temperature, then a chip row
 * carrying the bus id, AI core load and memory. Anything that does not parse
 * is skipped rather than failing the whole inventory — an unfamiliar column
 * layout must not hide the cards that did parse.
 */
export function parseNpuSmiInfo(text: string): NpuDeviceStatus[] {
  const devices: NpuDeviceStatus[] = [];
  let card: { health: string; id: number; name: string; powerWatts?: number; temperatureCelsius?: number } | undefined;
  for (const line of text.split("\n")) {
    // `npu-smi info` prints a second table of running processes below the
    // devices, and its rows start with the same "<npu> <chip>" shape. Without
    // this stop every process would be listed as another card.
    if (line.includes("Process id")) break;
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const chipRow = CHIP_ROW_PATTERN.exec(cells[0] ?? "");
    if (chipRow) {
      // One row per chip, not per card: a card with two dies prints two of
      // these under one head row, and each is its own device.
      if (!card) continue;
      const metrics = CHIP_METRICS_PATTERN.exec(cells[2] ?? "");
      devices.push({
        cardId: card.id,
        chipId: Number(chipRow[1]),
        chipName: card.name,
        health: card.health,
        hostIndex: card.id,
        sandboxUsable: false,
        ...(cells[1] ? { busId: cells[1] } : {}),
        ...(card.powerWatts === undefined ? {} : { powerWatts: card.powerWatts }),
        ...(card.temperatureCelsius === undefined ? {} : { temperatureCelsius: card.temperatureCelsius }),
        ...(metrics ? {
          aiCorePercent: parseNumber(metrics[1]),
          hbmTotalMb: parseNumber(metrics[5]),
          hbmUsedMb: parseNumber(metrics[4]),
        } : {}),
      });
      continue;
    }
    const head = DEVICE_HEAD_PATTERN.exec(cells[0] ?? "");
    if (!head) continue;
    const hostIndex = Number(head[1]);
    if (!Number.isSafeInteger(hostIndex)) continue;
    // A card name always carries letters ("910B3"); a bare number here means
    // the row belongs to some other table rather than the device listing.
    if (!/[A-Za-z]/u.test(head[2] ?? "")) continue;
    const metrics = HEAD_METRICS_PATTERN.exec(cells[2] ?? "");
    card = {
      health: cells[1] ?? "",
      id: hostIndex,
      name: head[2] ?? "",
      powerWatts: parseNumber(metrics?.[1]),
      temperatureCelsius: parseNumber(metrics?.[2]),
    };
  }
  return devices;
}

/**
 * One row of `npu-smi info -m`: which board a chip sits on, and the device
 * number the driver gave it.
 */
export interface NpuChipMapping {
  cardId: number;
  chipId: number;
  chipName: string;
  /** The `N` in `/dev/davinciN`. */
  logicId: number;
}

/**
 * Parse `npu-smi info -m`, which is the only place the machine states the
 * relationship between a card, a chip on it, and the device node the driver
 * exposes:
 *
 * ```
 * NPU ID    Chip ID    Chip Logic ID    Chip Name
 * 0         0          0                Ascend 910B3
 * 0         1          -                Mcu
 * ```
 *
 * Two things make this worth a separate call rather than reading the pretty
 * table. A card can carry more than one compute die — a 910C carries two — and
 * only this table says which device node each one is; assuming the card number
 * is the device number binds the wrong die. And a card also carries chips that
 * are not compute devices at all (the `Mcu` above), which have no logic id and
 * must not become entries an operator can tick.
 */
export function parseNpuSmiMapping(text: string): NpuChipMapping[] {
  const rows: NpuChipMapping[] = [];
  for (const line of text.split("\n")) {
    const cells = line.trim().split(/\s{2,}/u).map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    const [card, chip, logic, ...name] = cells;
    const cardId = Number(card);
    const chipId = Number(chip);
    const logicId = Number(logic);
    if (!Number.isSafeInteger(cardId) || !Number.isSafeInteger(chipId)) continue;
    // A non-compute chip has no device node: its logic id prints as "-".
    if (!Number.isSafeInteger(logicId)) continue;
    const chipName = name.join(" ").trim();
    if (!chipName || !/[A-Za-z]/u.test(chipName)) continue;
    rows.push({ cardId, chipId, chipName, logicId });
  }
  return rows;
}

/** Host path of a card's character device. */
export function npuDevicePath(hostIndex: number): string {
  return `/dev/davinci${hostIndex}`;
}

/**
 * The library and Python paths CANN needs inside the sandbox. `--clearenv`
 * wipes the host's `set_env.sh` exports, so the launch has to restate them.
 * `driver/lib64/common` matters as much as the other two driver directories:
 * `libascend_hal.so` links `libc_sec.so`, which lives only there, and leaving
 * it out fails the load with a message that names neither NPU nor CANN.
 */
export interface NpuSandboxEnvironment {
  ASCEND_AICPU_PATH: string;
  ASCEND_HOME_PATH: string;
  ASCEND_OPP_PATH: string;
  ASCEND_TOOLKIT_HOME: string;
  LD_LIBRARY_PATH: string;
  TOOLCHAIN_HOME: string;
}

export function npuSandboxEnvironment(tools: NpuHostTools): NpuSandboxEnvironment {
  const toolkit = tools.toolkitPath;
  return {
    ASCEND_AICPU_PATH: toolkit,
    ASCEND_HOME_PATH: toolkit,
    ASCEND_OPP_PATH: `${toolkit}/opp`,
    ASCEND_TOOLKIT_HOME: toolkit,
    LD_LIBRARY_PATH: [
      `${ASCEND_ROOT}/driver/lib64`,
      `${ASCEND_ROOT}/driver/lib64/common`,
      `${ASCEND_ROOT}/driver/lib64/driver`,
      `${toolkit}/lib64`,
      `${toolkit}/lib64/plugin/opskernel`,
      `${toolkit}/lib64/plugin/nnengine`,
    ].join(":"),
    TOOLCHAIN_HOME: `${toolkit}/toolkit`,
  };
}

/** Python search path CANN's TBE operator compiler needs, appended to any existing one. */
export function npuSandboxPythonPath(tools: NpuHostTools): string[] {
  return [
    `${tools.toolkitPath}/python/site-packages`,
    `${tools.toolkitPath}/opp/built-in/op_impl/ai_core/tbe`,
  ];
}

/**
 * `--dev-bind` arguments that expose exactly the selected cards, renumbered so
 * the sandbox always counts from 0. Callers must have already placed a fresh
 * `--dev /dev` on the command line: binding onto the host's `/dev` would offer
 * every card and fail the driver's all-or-nothing enumeration.
 */
export function npuDeviceBindArguments(
  selection: NpuDeviceSelection,
  availableManagementDevices: readonly string[] = NPU_MANAGEMENT_DEVICES,
): string[] {
  const mapping = npuDeviceMapping(selection);
  if (mapping.length === 0) return [];
  const args: string[] = [];
  for (const { hostIndex, sandboxIndex } of mapping) {
    args.push("--dev-bind", npuDevicePath(hostIndex), npuDevicePath(sandboxIndex));
  }
  for (const device of availableManagementDevices) {
    args.push("--dev-bind", device, device);
  }
  return args;
}

/** Management nodes this host actually has; 910B ships all three, older stacks fewer. */
export async function availableNpuManagementDevices(): Promise<string[]> {
  const present: string[] = [];
  for (const device of NPU_MANAGEMENT_DEVICES) {
    if (await exists(device)) present.push(device);
  }
  return present;
}

/**
 * The throwaway sandbox used to answer "can this one card be opened here?".
 * It mirrors the real launch's isolation — same namespaces, same dropped
 * capabilities, same fresh `/dev` — because a weaker probe would pass on cards
 * the real launch then rejects.
 */
export function npuSandboxProbeArguments(options: {
  context: NpuProbeContext;
  hostIndex: number;
  managementDevices: readonly string[];
}): string[] {
  const { context } = options;
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--unshare-user",
    ...(context.disableUserns ? ["--disable-userns"] : []),
    "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    ...procMountArguments(context.procMode),
    "--dev", "/dev",
    ...npuDeviceBindArguments([options.hostIndex], options.managementDevices),
    "--tmpfs", "/tmp",
    "--clearenv",
    "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
    "--setenv", "LD_LIBRARY_PATH", npuSandboxEnvironment(context).LD_LIBRARY_PATH,
    context.npuSmiPath ?? "npu-smi",
    "info",
  ];
}

/**
 * `npu-smi info` doubles as the probe binary: it is present on every Ascend
 * host, needs no interpreter, and exercises the same driver enumeration a
 * framework would. Exit 0 means the card opened; anything else means it did
 * not, and its first meaningful line explains why.
 */
export async function probeNpuDeviceInSandbox(options: {
  context: NpuProbeContext;
  hostIndex: number;
  managementDevices: readonly string[];
}): Promise<{ usable: boolean; reason?: string }> {
  if (!options.context.npuSmiPath) {
    return { reason: "npu-smi is not installed on this machine.", usable: false };
  }
  if (!await exists(npuDevicePath(options.hostIndex))) {
    return { reason: `${npuDevicePath(options.hostIndex)} does not exist on this machine.`, usable: false };
  }
  try {
    await execFileAsync(options.context.bwrapPath, npuSandboxProbeArguments(options), {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: NPU_PROBE_TIMEOUT_MS,
    });
    return { usable: true };
  } catch (error) {
    return { reason: npuProbeFailureReason(error, options.hostIndex), usable: false };
  }
}

/**
 * Turn a failed probe into something an operator can act on. The driver's own
 * wording ("because the device is used") is the useful part; the surrounding
 * log-level noise is not.
 */
export function npuProbeFailureReason(error: unknown, hostIndex: number): string {
  const streams = error as { stderr?: unknown; stdout?: unknown } | null;
  const text = [streams?.stderr, streams?.stdout]
    .filter((stream): stream is string => typeof stream === "string")
    .join("\n");
  const meaningful = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("+") && !line.startsWith("|")
      && !line.startsWith("DrvMngGetConsoleLogLevel"));
  if (meaningful) return `NPU ${hostIndex} cannot be opened inside the sandbox: ${meaningful}`;
  const message = error instanceof Error ? error.message : String(error);
  return `NPU ${hostIndex} cannot be opened inside the sandbox: ${message}`;
}

/**
 * List the machine's cards and probe each one. Cards are probed concurrently:
 * each probe is an independent short-lived sandbox, and a machine with eight
 * cards would otherwise spend most of a minute on a status refresh.
 *
 * `only` narrows both the listing and the probing to the given host indices,
 * which is what an execution needs: it must know about the cards it asked for
 * right now, and re-probing the seven it did not ask for would cost seconds
 * and could disturb cards another Session is using.
 */
export async function collectNpuInventory(options: {
  bwrapPath: string;
  disableUserns: boolean;
  only?: readonly number[];
  procMode: SandboxProcMode;
  tools?: NpuHostTools;
}): Promise<NpuInventory> {
  const capturedAt = new Date().toISOString();
  const tools = options.tools ?? await resolveNpuHostTools();
  if (!tools.npuSmiPath) return { capturedAt, devices: [], supported: false };
  const context: NpuProbeContext = {
    bwrapPath: options.bwrapPath,
    disableUserns: options.disableUserns,
    npuSmiPath: tools.npuSmiPath,
    procMode: options.procMode,
    toolkitPath: tools.toolkitPath,
  };
  let devices: NpuDeviceStatus[];
  try {
    // The driver's own interface first; npu-smi is the fallback for machines
    // without a usable Python or an older driver.
    devices = await readDcmiDevices(tools.pythonPath) ?? await readNpuSmiDevices(tools.npuSmiPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { capturedAt, devices: [], error: `Could not read NPU status: ${message}`, supported: true };
  }
  await probeListedDevices(
    options.only ? devices.filter((device) => options.only!.includes(device.hostIndex)) : devices,
    context,
  );
  return {
    capturedAt,
    devices: options.only ? devices.filter((device) => options.only!.includes(device.hostIndex)) : devices,
    supported: true,
  };
}

/**
 * The driver's own interface, asked through a few lines of Python.
 *
 * `npu-smi` is a client of this library, and scraping its output is two steps
 * removed from the machine: a column layout that shifts between CANN releases,
 * on top of a table that cannot even say which device node a chip owns without
 * a second call. DCMI answers all of it directly — cards, chips per card, the
 * logic id that *is* the device number, chip name, health, load — and it does
 * so per chip, so a two-die card needs no special case.
 *
 * It is reached with `ctypes` rather than a compiled addon on purpose: a native
 * addon would have to be built per architecture, shipped inside a single-file
 * Runner it cannot be loaded from, and kept in step with a driver ABI. A short
 * script run by the host's Python costs none of that, and measured on an 8-card
 * 910B3 it reads the whole machine in under half a second — the same work takes
 * about fifteen seconds through per-card `npu-smi` queries.
 *
 * Structure layouts are mirrored by hand here, so this stays to scalar returns
 * and one small stable struct, checks every return code, and leaves npu-smi as
 * the fallback rather than trusting a guess.
 */
const DCMI_INVENTORY_SCRIPT = `
import ctypes, json, sys

LIB = "/usr/local/Ascend/driver/lib64/driver/libdcmi.so"
NAME_LEN = 32

class ChipInfo(ctypes.Structure):
    _fields_ = [("chip_type", ctypes.c_ubyte * NAME_LEN), ("chip_name", ctypes.c_ubyte * NAME_LEN),
                ("chip_ver", ctypes.c_ubyte * NAME_LEN), ("aicore_cnt", ctypes.c_uint),
                ("npu_name", ctypes.c_ubyte * NAME_LEN)]

class HbmInfo(ctypes.Structure):
    _fields_ = [("memory_size", ctypes.c_ulonglong), ("freq", ctypes.c_uint),
                ("memory_usage", ctypes.c_ulonglong), ("temp", ctypes.c_int),
                ("bandwith_util_rate", ctypes.c_uint)]

def text(buffer):
    return bytes(buffer).split(b"\\x00")[0].decode("utf8", "replace")

def main():
    lib = ctypes.CDLL(LIB)
    if lib.dcmi_init() != 0:
        raise SystemExit("dcmi_init failed")
    count = ctypes.c_int(0)
    cards = (ctypes.c_int * 64)()
    if lib.dcmi_get_card_num_list(ctypes.byref(count), cards, 64) != 0:
        raise SystemExit("dcmi_get_card_num_list failed")
    chips = []
    for card in list(cards)[:count.value]:
        per_card = ctypes.c_int(0)
        if lib.dcmi_get_device_num_in_card(card, ctypes.byref(per_card)) != 0:
            continue
        for chip in range(per_card.value):
            logic = ctypes.c_int(-1)
            if lib.dcmi_get_device_logic_id(ctypes.byref(logic), card, chip) != 0:
                continue
            entry = {"cardId": card, "chipId": chip, "hostIndex": logic.value}
            info = ChipInfo()
            if lib.dcmi_get_device_chip_info_v2(card, chip, ctypes.byref(info)) == 0:
                entry["chipName"] = text(info.chip_name)
            health = ctypes.c_uint(0)
            if lib.dcmi_get_device_health(card, chip, ctypes.byref(health)) == 0:
                entry["health"] = "OK" if health.value == 0 else "Alarm"
            for code, key in ((2, "aiCorePercent"), (6, "hbmPercent")):
                rate = ctypes.c_uint(0)
                if lib.dcmi_get_device_utilization_rate(card, chip, code, ctypes.byref(rate)) == 0:
                    entry[key] = rate.value
            temperature = ctypes.c_int(0)
            if lib.dcmi_get_device_temperature(card, chip, ctypes.byref(temperature)) == 0:
                entry["temperatureCelsius"] = temperature.value
            power = ctypes.c_int(0)
            if lib.dcmi_get_device_power_info(card, chip, ctypes.byref(power)) == 0:
                # The driver answers in tenths of a watt.
                entry["powerDeciwatts"] = power.value
            hbm = HbmInfo()
            if lib.dcmi_get_device_hbm_info(card, chip, ctypes.byref(hbm)) == 0:
                entry["hbmTotalMb"] = hbm.memory_size
                entry["hbmUsedMb"] = hbm.memory_usage
            chips.append(entry)
    json.dump(chips, sys.stdout)

main()
`;

/** What the DCMI script reports for one chip. */
interface DcmiChip {
  aiCorePercent?: number;
  cardId: number;
  chipId: number;
  chipName?: string;
  hbmPercent?: number;
  hbmTotalMb?: number;
  hbmUsedMb?: number;
  health?: string;
  hostIndex: number;
  /** Tenths of a watt, which is the unit the driver answers in. */
  powerDeciwatts?: number;
  temperatureCelsius?: number;
}

/**
 * Read the machine through DCMI, or return undefined so the caller falls back.
 *
 * Every reason this can fail is a normal machine state — no Python, no driver
 * library, a driver too old for one of these calls — and none of them should
 * turn into an error an operator has to read. npu-smi answers the same question
 * more slowly.
 */
export async function readDcmiDevices(
  pythonPath: string | undefined,
): Promise<NpuDeviceStatus[] | undefined> {
  if (!pythonPath) return undefined;
  let payload: string;
  try {
    const result = await execFileAsync(pythonPath, ["-c", DCMI_INVENTORY_SCRIPT], {
      encoding: "utf8", maxBuffer: 1024 * 1024, timeout: NPU_PROBE_TIMEOUT_MS,
    });
    payload = result.stdout;
  } catch {
    return undefined;
  }
  let chips: DcmiChip[];
  try {
    chips = JSON.parse(payload) as DcmiChip[];
  } catch {
    return undefined;
  }
  if (!Array.isArray(chips) || chips.length === 0) return undefined;
  return chips.map((chip) => ({
    cardId: chip.cardId,
    chipId: chip.chipId,
    chipName: chip.chipName ?? "",
    health: chip.health ?? "",
    hostIndex: chip.hostIndex,
    sandboxUsable: false,
    ...(chip.aiCorePercent === undefined ? {} : { aiCorePercent: chip.aiCorePercent }),
    ...(chip.hbmPercent === undefined ? {} : { hbmPercent: chip.hbmPercent }),
    ...(chip.hbmTotalMb === undefined ? {} : { hbmTotalMb: chip.hbmTotalMb }),
    ...(chip.hbmUsedMb === undefined ? {} : { hbmUsedMb: chip.hbmUsedMb }),
    ...(chip.powerDeciwatts === undefined ? {} : { powerWatts: chip.powerDeciwatts / 10 }),
    ...(chip.temperatureCelsius === undefined ? {} : { temperatureCelsius: chip.temperatureCelsius }),
  }));
}

/**
 * The machine's chips and their readings, from `npu-smi`.
 *
 * Identity comes from `npu-smi info -m` and readings from `npu-smi info`,
 * joined on (card, chip). The pretty table alone cannot answer "which device
 * node is this": it prints the card number, which is the device number only on
 * hardware that puts one chip on a card. Reading identity from the mapping
 * table costs one extra half-second call and makes a two-die card two entries
 * that address themselves correctly.
 *
 * A chip the mapping table lists but the reading table does not still appears,
 * with no readings: it exists and can be bound, which matters more than its
 * temperature.
 */
async function readNpuSmiDevices(npuSmiPath: string): Promise<NpuDeviceStatus[]> {
  const run = async (args: string[]) => (await execFileAsync(npuSmiPath, args, {
    encoding: "utf8", maxBuffer: 1024 * 1024, timeout: NPU_PROBE_TIMEOUT_MS,
  })).stdout;
  const listing = await run(["info"]);
  const readings = parseNpuSmiInfo(listing);
  let mapping: NpuChipMapping[] = [];
  try {
    mapping = parseNpuSmiMapping(await run(["info", "-m"]));
  } catch {
    // An npu-smi too old for `-m` leaves the readings as the only source; on
    // one-chip cards that is exactly what it was before.
    return readings;
  }
  if (mapping.length === 0) return readings;
  const byCardChip = new Map(readings.map((device) => [`${device.cardId ?? device.hostIndex}:${device.chipId ?? 0}`, device]));
  return mapping.map((chip) => {
    const reading = byCardChip.get(`${chip.cardId}:${chip.chipId}`);
    return {
      ...reading,
      cardId: chip.cardId,
      chipId: chip.chipId,
      chipName: chip.chipName.replace(/^Ascend\s+/u, "") || reading?.chipName || "",
      health: reading?.health ?? "",
      // The device node follows the chip's logic id, never the card number.
      hostIndex: chip.logicId,
      sandboxUsable: false,
    } satisfies NpuDeviceStatus;
  });
}

/** Probe each listed card in its own throwaway sandbox, concurrently. */
async function probeListedDevices(devices: NpuDeviceStatus[], context: NpuProbeContext): Promise<void> {
  const managementDevices = await availableNpuManagementDevices();
  await Promise.all(devices.map(async (device) => {
    if (!SUPPORTED_CHIP_PATTERN.test(device.chipName)) {
      device.sandboxUsable = false;
      device.sandboxUnusableReason = `Only Ascend 910 series chips are supported; this one reports "${device.chipName}".`;
      return;
    }
    const probe = await probeNpuDeviceInSandbox({ context, hostIndex: device.hostIndex, managementDevices });
    device.sandboxUsable = probe.usable;
    if (probe.reason) device.sandboxUnusableReason = probe.reason;
  }));
}

/**
 * Everything a launch needs to expose NPU cards: the device binds, the CANN
 * environment, and the Python entries that must join any existing PYTHONPATH.
 * Shaped like `SandboxEgress` so the launch builder splices it the same way.
 */
export interface SandboxNpu {
  bindArgs: string[];
  env: NpuSandboxEnvironment;
  /** How the selected cards appear inside the sandbox, for provenance and logs. */
  mapping: NpuDeviceMapping[];
  pythonPath: string[];
}

/**
 * Resolve the device plumbing for one execution. An empty selection returns
 * undefined so the ordinary sandbox stays byte-for-byte unchanged on machines
 * and Sessions that do not use NPUs.
 */
export async function prepareSandboxNpu(
  selection: NpuDeviceSelection,
  tools?: NpuHostTools,
): Promise<SandboxNpu | undefined> {
  const mapping = npuDeviceMapping(selection);
  if (mapping.length === 0) return undefined;
  const resolved = tools ?? await resolveNpuHostTools();
  const managementDevices = await availableNpuManagementDevices();
  return {
    bindArgs: [
      ...npuDeviceBindArguments(mapping.map((entry) => entry.hostIndex), managementDevices),
      // Without this the driver prints "The driver package may not be
      // completely installed", which reads like a broken host but only means
      // it could not find its own install record inside the sandbox.
      ...(await exists(ASCEND_INSTALL_INFO)
        ? ["--ro-bind", ASCEND_INSTALL_INFO, ASCEND_INSTALL_INFO]
        : []),
    ],
    env: npuSandboxEnvironment(resolved),
    mapping,
    pythonPath: npuSandboxPythonPath(resolved),
  };
}

/**
 * An execution asked for cards this machine will not hand to a sandbox. Thrown
 * before the launch so the failure names the cards and the driver's reason,
 * rather than surfacing later as an unexplained framework error.
 */
export class NpuDevicesUnavailableError extends Error {
  readonly rejected: readonly RejectedNpuDevice[];

  constructor(rejected: readonly RejectedNpuDevice[]) {
    super(`Requested NPU cards are not usable on this machine: ${
      rejected.map((entry) => entry.reason).join(" ")
    }`);
    this.name = "NpuDevicesUnavailableError";
    this.rejected = rejected;
  }
}

/**
 * Validate an execution's requested cards and build the launch plumbing.
 *
 * The check is a fresh probe of exactly those cards, never the cached
 * inventory the status surface reads. On a shared host a card is claimed and
 * released by other tenants continuously, so a cached verdict up to a minute
 * old can wave through a card that is already gone — and the execution then
 * fails inside the framework with no card named, which is the outcome this
 * whole feature exists to prevent. An execution that asked for no card returns
 * before any of this, so ordinary runs never probe the machine.
 */
export async function resolveExecutionNpu(
  options: {
    bwrapPath: string;
    /** Test seam and injection point: read the state of exactly these cards. */
    npuDeviceProbe?: (requested: readonly number[]) => Promise<NpuInventory>;
  },
  requested: NpuDeviceSelection | undefined,
  probeProfile?: () => Promise<{ disableUserns: boolean; procMode: SandboxProcMode }>,
): Promise<SandboxNpu | undefined> {
  if (!requested || requested.length === 0) return undefined;
  const inventory = options.npuDeviceProbe
    ? await options.npuDeviceProbe(requested)
    : await collectNpuInventory({
      bwrapPath: options.bwrapPath,
      only: requested,
      ...(probeProfile ? await probeProfile() : { disableUserns: false, procMode: "new" as SandboxProcMode }),
    });
  const resolved = resolveNpuSelection(requested, inventory);
  if (resolved.rejected.length > 0) throw new NpuDevicesUnavailableError(resolved.rejected);
  return await prepareSandboxNpu(resolved.accepted);
}

/** Cache one inventory per Runner process so a status poll never re-probes every card. */
export class NpuInventoryCache {
  #inFlight: Promise<NpuInventory> | undefined;
  #value: NpuInventory | undefined;
  readonly #ttlMs: number;

  constructor(ttlMs: number = NPU_INVENTORY_TTL_MS) {
    this.#ttlMs = ttlMs;
  }

  /** Cached inventory, refreshed when stale. Concurrent callers share one probe. */
  async get(
    load: () => Promise<NpuInventory>,
    now: number = Date.now(),
  ): Promise<NpuInventory> {
    const cached = this.#value;
    if (cached && now - Date.parse(cached.capturedAt) < this.#ttlMs) return cached;
    this.#inFlight ??= load().then((value) => {
      this.#value = value;
      this.#inFlight = undefined;
      return value;
    }, (error: unknown) => {
      this.#inFlight = undefined;
      throw error;
    });
    return await this.#inFlight;
  }

  /** Drop the cached inventory so the next read re-probes. */
  invalidate(): void {
    this.#value = undefined;
  }
}

export type { NpuDeviceMapping };
