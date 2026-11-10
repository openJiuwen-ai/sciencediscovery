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
 * The unit a size reads in, picked from the number the caller will print rather
 * than from the unrounded value.
 *
 * 1 MiB - 1 byte is 1023.999 KB unrounded but 1024 once rounded to whole KB, and no
 * level may print its own base, so that size belongs in the next unit. Reading the
 * unit off the unrounded value is what printed "1024KB", "1024MB" and "1024 MiB":
 * the ladder stopped at a unit whose printed number had already reached the base.
 *
 * `print` is the caller's own rounding at one level, so the unit and the printed
 * number can never disagree, and callers whose levels round differently each get
 * the decision their own number makes.
 */
export function sizeInUnit(
  bytes: number,
  print: (value: number) => number,
  unitCount: number,
  base = 1024,
): { unit: number; value: number } {
  let value = bytes;
  let unit = 0;
  while (unit < unitCount - 1 && print(value) >= base) {
    value /= base;
    unit += 1;
  }
  return { unit, value };
}
