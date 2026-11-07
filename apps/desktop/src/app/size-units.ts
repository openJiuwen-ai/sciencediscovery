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

/** Scale `bytes` down by `base` while the value the caller would *print* still
 *  reaches the base, so a size never reads as "1024KB" or "1024 MiB": 1 MiB − 1
 *  byte is 1023.999 KB unrounded and 1024 once rounded, and it belongs in the
 *  next unit. `round` is the caller's own printed form at the level it is asked
 *  about, so the unit choice and the printed number can never disagree — a
 *  caller whose levels round differently (whole KB and MB, one decimal GB)
 *  reads each level's decision off that level's own number instead of forcing
 *  one rounding on all of them. */
export function scaledSize(
  bytes: number,
  round: (value: number, unit: number) => number,
  unitCount: number,
  base = 1024,
): { unit: number; value: number } {
  let value = bytes;
  let unit = 0;
  while (unit < unitCount - 1 && round(value, unit) >= base) {
    value /= base;
    unit += 1;
  }
  return { unit, value };
}
