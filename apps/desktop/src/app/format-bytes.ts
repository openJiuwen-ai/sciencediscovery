// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { sizeInUnit } from "./size-units.js";

/**
 * Human size for a research package, by magnitude.
 *
 * The magnitude loop is `sizeInUnit`, shared with the attachment and upload limits, so
 * this file owns only the package's own spelling: KB/MB/GB with one decimal, exactly
 * like the saved-export rows beside it. The previous dialog printed every size in KiB,
 * which turned a ~910 MiB session into `933095.4 KiB` (#1024).
 */
export const PACKAGE_SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

// One decimal at every level: a size line is compared across cards, so the shape of
// the number should not change with its magnitude.
const print = (value: number): number => Number(value.toFixed(1));

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  const { unit, value } = sizeInUnit(Math.max(0, Math.round(bytes)), print, PACKAGE_SIZE_UNITS.length);
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${PACKAGE_SIZE_UNITS[unit]}`;
}
