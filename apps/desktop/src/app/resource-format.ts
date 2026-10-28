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
 * What a connected Runner's readings mean, kept pure.
 *
 * The page that renders these cannot be rendered in this repository — it has no
 * browser environment — so every judgement it makes about a number lives here,
 * where it can be tested directly. The recurring rule is that **a missing or
 * impossible reading is not a zero**: a machine whose disk size could not be
 * read must not be drawn as a machine with an empty disk, because the two call
 * for opposite reactions.
 */

import type { NpuDeviceStatus, NpuInventory, RunnerResources } from "../api/types.js";
import { TEXT } from "../text.js";

/** Bytes as `GiB`, one decimal, which is how operators talk about machine
 *  capacity — the workspace disk of a compute node is not quoted in MiB. */
export function resourceBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * What this machine must still fit before installs start failing: the Runner
 * itself (the SEA binary is ~120 MiB, plus the micromamba provisioner and its
 * package cache) and two base conda environments (the Python starter carries
 * numpy/pandas/scipy/matplotlib, roughly 2 GiB on disk each). Deliberately an
 * absolute estimate, not a percentage: on a multi-TiB disk a "10% left" rule
 * cries wolf with hundreds of GiB still free.
 */
const RUNNER_ESSENTIALS_BYTES = 1 * 1024 ** 3;
const BASE_CONDA_ENV_BYTES = 2 * 1024 ** 3;
export const REMOTE_DISK_REQUIRED_BYTES = RUNNER_ESSENTIALS_BYTES + 2 * BASE_CONDA_ENV_BYTES;

export interface ResourceMeter {
  /** Rounded to a tenth, so the bar and the number agree. */
  percent: number;
  tone: "info" | "success" | "warning";
  total: number;
  /** What is in use, not what is free. */
  value: number;
}

/**
 * A reading, or nothing at all.
 *
 * Everything about the bar is refused up front rather than clamped: a figure of
 * `NaN`, a zero total (which would divide by it), a negative use, or a use above
 * the total is not a full bar or an empty one — it is a reading that did not
 * arrive, and the caller says so instead of drawing it.
 */
export function resourceMeter(value: number, total: number, tone: ResourceMeter["tone"]): ResourceMeter | undefined {
  if (!Number.isFinite(value) || !Number.isFinite(total)) return undefined;
  if (total <= 0 || value < 0 || value > total) return undefined;
  return { percent: Math.round((value / total) * 1000) / 10, tone, total, value };
}

/** The workspace disk as the Runner reported it, or nothing when it could not
 *  read one. The warning tone is the low-space state; the caller adds the alert
 *  line, because only it knows how the page wants to say so. */
export function diskMeter(resources: RunnerResources): ResourceMeter | undefined {
  const disk = resources.workspaceDisk;
  if (!disk || typeof disk.availableBytes !== "number" || typeof disk.totalBytes !== "number") return undefined;
  const used = disk.totalBytes - disk.availableBytes;
  return resourceMeter(used, disk.totalBytes, isDiskLow(resources) ? "warning" : "success");
}

/** Whether the machine is close enough to full that an install may fail. The
 *  boundary itself is not low: exactly the required amount is exactly enough. */
export function isDiskLow(resources: RunnerResources): boolean {
  const available = resources.workspaceDisk?.availableBytes;
  return typeof available === "number" && available < REMOTE_DISK_REQUIRED_BYTES;
}

/** `3445 / 65536 MiB` as `3.4 / 64.0 GiB`, which is how operators talk about
 *  HBM. Undefined when the driver reported a ratio but not the pair, because a
 *  half-known capacity is not a quantity. */
export function npuMemory(usedMb: number | undefined, totalMb: number | undefined): string | undefined {
  if (usedMb === undefined || totalMb === undefined || totalMb <= 0) return undefined;
  return `${(usedMb / 1024).toFixed(1)} / ${(totalMb / 1024).toFixed(1)} GiB`;
}

/**
 * The HBM bar's width, from whichever reading the machine could give.
 *
 * The driver reports a percentage in a DCMI read and absolute MiB in an
 * `npu-smi` read, so a card may carry either. Undefined when it carries
 * neither — the card then gets an empty cell, which keeps the columns aligned.
 */
export function npuMemoryPercent(device: NpuDeviceStatus): number | undefined {
  if (device.hbmUsedMb !== undefined && device.hbmTotalMb) {
    return clampPercent((device.hbmUsedMb / device.hbmTotalMb) * 100);
  }
  return device.hbmPercent === undefined ? undefined : clampPercent(device.hbmPercent);
}

/** AI core utilisation as a width. Not clamped into a percentage that would
 *  imply a reading: a number outside 0–100 is dropped. */
export function npuAiCorePercent(device: NpuDeviceStatus): number | undefined {
  if (device.aiCorePercent === undefined) return undefined;
  return clampPercent(device.aiCorePercent);
}

/** A card is hot at 75 °C and warm at 60 °C — the thresholds the host's own
 *  alarms use, which is what makes them worth colouring at all. */
export function npuTemperatureTone(device: NpuDeviceStatus): "" | "hot" | "warm" {
  const temperature = device.temperatureCelsius;
  if (temperature === undefined) return "";
  if (temperature >= 75) return "hot";
  if (temperature >= 60) return "warm";
  return "";
}

/** Whether AI core utilisation is high enough to explain a slow run. */
export function npuAiCoreHigh(device: NpuDeviceStatus): boolean {
  const percent = npuAiCorePercent(device);
  return percent !== undefined && percent >= 85;
}

/**
 * How one card is named.
 *
 * A card that carries several dies is named per die, because each die is what
 * gets bound and what a rank runs on. Naming every card that way on hardware
 * with one die per card would only add noise.
 */
export function npuCardLabel(device: NpuDeviceStatus, multiChip: boolean): string {
  const card = device.cardId ?? device.hostIndex;
  return multiChip
    ? TEXT.settings.runtime.runner.npu.cardChip(card, device.chipId ?? 0, device.chipName, device.hostIndex)
    : TEXT.settings.runtime.runner.npu.card(device.chipName, device.hostIndex);
}

/** The cards an operator is allowed to tick: listed by the host *and* openable
 *  inside a sandbox. Derived here rather than imported from the schema, whose
 *  barrel must stay out of the browser bundle. */
export function usableNpuCards(inventory: NpuInventory): NpuDeviceStatus[] {
  return inventory.devices.filter((device) => device.sandboxUsable);
}

/** The cards on a machine that carry more than one die, keyed by card number. */
export function multiChipCards(inventory: NpuInventory): Set<number> {
  const perCard = new Map<number, number>();
  for (const device of inventory.devices) {
    const card = device.cardId ?? device.hostIndex;
    perCard.set(card, (perCard.get(card) ?? 0) + 1);
  }
  return new Set([...perCard].filter(([, count]) => count > 1).map(([card]) => card));
}

/** Whole hours of uptime, which is the resolution anyone asks this question at. */
export function uptimeHours(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.floor(seconds / 3600);
}

function clampPercent(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}
