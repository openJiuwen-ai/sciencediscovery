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
 * Ascend NPU cards a Runner can hand to a sandbox.
 *
 * The product concept is "which cards on this machine can my sandboxed code
 * actually use". That is deliberately narrower than "which cards the host
 * lists": on a shared Ascend host the driver refuses cards that are already
 * claimed elsewhere, and it refuses them only once the caller is inside a
 * mount namespace. A card `npu-smi` happily reports on the host can therefore
 * be unusable in the sandbox, so every card carries a separately probed
 * `sandboxUsable` verdict and only usable cards may be selected.
 *
 * Pure contract + selection logic: this module is bundled into the browser and
 * must stay free of Node built-ins.
 */

/** Sandbox device numbering always starts here, whatever the host index is. */
export const NPU_SANDBOX_FIRST_INDEX = 0;

/** One Ascend card as the Runner sees it on the host. */
export interface NpuDeviceStatus {
  /** AI core utilisation percent, as `npu-smi` reports it. */
  aiCorePercent?: number;
  /** PCIe address, useful when operators correlate with `lspci`. */
  busId?: string;
  /** Chip name, for example `910B3`. Only 910B cards are supported today. */
  chipName: string;
  /** `npu-smi` health word, for example `OK` or `Alarm`. */
  health: string;
  /** On-chip memory in use, in MiB. */
  hbmUsedMb?: number;
  /** On-chip memory capacity, in MiB. */
  hbmTotalMb?: number;
  /** Host device index: the `N` in `/dev/davinciN` and the NPU ID `npu-smi` prints. */
  hostIndex: number;
  /** Board power draw in watts. */
  powerWatts?: number;
  /**
   * Whether a sandbox can actually open this card, established by launching a
   * throwaway sandbox that binds only this card. Never inferred from the host
   * listing: the host can open cards the sandbox cannot.
   */
  sandboxUsable: boolean;
  /** Why the sandbox probe refused the card. Present only when unusable. */
  sandboxUnusableReason?: string;
  /** Board temperature in degrees Celsius. */
  temperatureCelsius?: number;
}

/** Everything the Runner knows about this machine's NPU cards. */
export interface NpuInventory {
  capturedAt: string;
  devices: NpuDeviceStatus[];
  /** Set when the inventory could not be collected at all. */
  error?: string;
  /** False when the machine has no Ascend tooling; `devices` is then empty. */
  supported: boolean;
}

/**
 * Host indices an operator selected for sandbox use. Order is irrelevant: the
 * sandbox numbering is derived by sorting, so the same set always produces the
 * same device layout.
 */
export type NpuDeviceSelection = readonly number[];

/** How one selected card appears inside the sandbox. */
export interface NpuDeviceMapping {
  /** `/dev/davinciN` on the host. */
  hostIndex: number;
  /** `/dev/davinciM` inside the sandbox, always counting from 0. */
  sandboxIndex: number;
}

/** A card the operator asked for that the Runner will not hand to a sandbox. */
export interface RejectedNpuDevice {
  hostIndex: number;
  reason: string;
}

export interface ResolvedNpuSelection {
  /** Host indices that survived validation, ascending. */
  accepted: number[];
  /** Host index to sandbox index, in sandbox order. */
  mapping: NpuDeviceMapping[];
  rejected: RejectedNpuDevice[];
}

/**
 * The local machine's Runner, addressed the same way a remote one is. A
 * selection has to be storable for it too: the machine that hosts the product
 * can itself carry the NPUs, and an operator must be able to tick its cards
 * without registering it as a remote machine.
 */
export const LOCAL_RUNNER_ID = "local";

/**
 * Which cards each Runner may hand to its sandboxes, keyed by Runner id
 * (`local`, or a registered machine's id). Keyed rather than embedded in the
 * machine record because the local Runner has no machine record, and one
 * storage keeps both paths behaving identically.
 */
export type NpuDeviceSelections = Readonly<Record<string, number[]>>;

/** The cards a Runner may use, or an empty selection when it uses none. */
export function npuSelectionFor(
  selections: NpuDeviceSelections | undefined,
  runnerId: string,
): number[] {
  return selections?.[runnerId] ?? [];
}

/** Cards an operator is allowed to tick: listed by the host *and* sandbox-usable. */
export function selectableNpuDevices(inventory: NpuInventory | undefined): NpuDeviceStatus[] {
  return (inventory?.devices ?? []).filter((device) => device.sandboxUsable);
}

/**
 * Renumber a set of host cards into sandbox device numbers. Sorting first is
 * what makes the mapping stable and makes `/dev/davinci0` exist for every
 * non-empty selection, which is what frameworks expect when they default to
 * device 0.
 */
export function npuDeviceMapping(selection: NpuDeviceSelection): NpuDeviceMapping[] {
  const unique = [...new Set(selection)].sort((left, right) => left - right);
  return unique.map((hostIndex, position) => ({
    hostIndex,
    sandboxIndex: NPU_SANDBOX_FIRST_INDEX + position,
  }));
}

/**
 * Keep only cards this machine currently offers to sandboxes, and say why the
 * rest were dropped. Rejecting here rather than at launch time is the point:
 * an operator learns a card is unusable while ticking the box, not when an
 * execution fails half an hour later.
 */
export function resolveNpuSelection(
  requested: NpuDeviceSelection,
  inventory: NpuInventory | undefined,
): ResolvedNpuSelection {
  const accepted: number[] = [];
  const rejected: RejectedNpuDevice[] = [];
  const seen = new Set<number>();
  const byIndex = new Map((inventory?.devices ?? []).map((device) => [device.hostIndex, device]));
  for (const hostIndex of [...requested].sort((left, right) => left - right)) {
    if (seen.has(hostIndex)) continue;
    seen.add(hostIndex);
    const device = byIndex.get(hostIndex);
    if (!device) {
      rejected.push({ hostIndex, reason: npuDeviceMissingReason(hostIndex, inventory) });
      continue;
    }
    if (!device.sandboxUsable) {
      rejected.push({
        hostIndex,
        reason: device.sandboxUnusableReason
          ?? `NPU ${hostIndex} cannot be opened inside the sandbox on this machine.`,
      });
      continue;
    }
    accepted.push(hostIndex);
  }
  return { accepted, mapping: npuDeviceMapping(accepted), rejected };
}

function npuDeviceMissingReason(hostIndex: number, inventory: NpuInventory | undefined): string {
  if (!inventory || !inventory.supported) {
    return `This machine reports no Ascend NPU cards, so NPU ${hostIndex} cannot be selected.`;
  }
  return `NPU ${hostIndex} is no longer present on this machine.`;
}

/** Human-facing summary of a card's on-chip memory, or undefined when unknown. */
export function npuMemorySummary(device: NpuDeviceStatus): string | undefined {
  if (device.hbmUsedMb === undefined || device.hbmTotalMb === undefined) return undefined;
  return `${device.hbmUsedMb} / ${device.hbmTotalMb} MiB`;
}

/** What the settings surface needs to render NPU selection for every Runner. */
export interface NpuRunnerSelectionsResponse {
  /** The local machine's cards, or null when it has none or could not be read. */
  local: NpuInventory | null;
  selections: NpuDeviceSelections;
}
