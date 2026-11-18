// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * Human size for a research package, by magnitude.
 *
 * One decimal from KB up — a size line is read to judge "can I copy this", not to
 * count bytes — and plain bytes below 1 KB. 1024-based, and spelled exactly like the
 * saved-export rows beside it so one dialog never shows two spellings of the same
 * unit. The previous dialog printed every size in KiB, which turned a ~910 MiB
 * session into `933095.4 KiB` and made the number unreadable (#1024).
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  const value = Math.max(0, Math.round(bytes));
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(1)} ${units[unit]}`;
}
