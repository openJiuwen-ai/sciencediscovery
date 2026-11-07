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

/** How many decimals a size keeps. "adaptive" prints two decimals below ten
 *  units and one from ten up, so `1.50 KiB` and `12.3 MiB` read as they always
 *  have. */
export type ByteDecimals = "adaptive" | number;

const UNITS = ["KiB", "MiB", "GiB", "TiB"] as const;
const BASE = 1_024;

function decimalsFor(value: number, decimals: ByteDecimals): number {
  if (decimals !== "adaptive") return decimals;
  return value >= 10 ? 1 : 2;
}

/** A file size with the unit its *printed* value belongs to: a size one byte
 *  under 1 MiB reads `1.00 MiB`, never `1024.0 KiB`, because a KiB value cannot
 *  reach 1,024. Bytes stay bytes. */
export function formatByteSize(bytes: number, decimals: ByteDecimals = "adaptive"): string {
  if (bytes < BASE) return `${bytes} B`;
  let value = bytes / BASE;
  let unit = 0;
  // Pick the unit from the same rounded value that gets printed: unrounded
  // 1023.999 KiB is "1024.0" on screen, so it has to move on to MiB.
  const printed = (candidate: number): number => Number(candidate.toFixed(decimalsFor(candidate, decimals)));
  while (unit < UNITS.length - 1 && printed(value) >= BASE) {
    value /= BASE;
    unit += 1;
  }
  return `${value.toFixed(decimalsFor(value, decimals))} ${UNITS[unit]}`;
}
