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

import { mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

import type { CompatibilityLog } from "./environment.js";

type PathStatus = "missing" | "directory" | "other";

async function pathStatus(path: string): Promise<PathStatus> {
  try {
    return (await stat(path)).isDirectory() ? "directory" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export interface DirectoryMigration {
  label: string;
  legacyPath: string;
  targetPath: string;
  log: CompatibilityLog;
}

/** Move a legacy default directory once, while never replacing a new target. */
export async function migrateLegacyDirectory(options: DirectoryMigration): Promise<void> {
  const { label, legacyPath, targetPath, log } = options;
  let legacyStatus: PathStatus;
  let targetStatus: PathStatus;
  try {
    legacyStatus = await pathStatus(legacyPath);
    if (legacyStatus === "missing") return;
    targetStatus = await pathStatus(targetPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`[compat] Failed to inspect legacy ${label} from ${legacyPath} to ${targetPath}: ${reason}`);
    throw error;
  }
  if (legacyStatus !== "directory") {
    log(`[compat] Skipped importing legacy ${label} from ${legacyPath} to ${targetPath}: source is not a directory.`);
    return;
  }
  if (targetStatus !== "missing") {
    log(`[compat] Skipped importing legacy ${label} from ${legacyPath} to ${targetPath}: target already exists.`);
    return;
  }

  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await rename(legacyPath, targetPath);
  } catch (error) {
    // A concurrent launcher may have won the migration race.
    if (await pathStatus(targetPath) !== "missing") {
      log(`[compat] Skipped importing legacy ${label} from ${legacyPath} to ${targetPath}: target already exists.`);
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    log(`[compat] Failed to import legacy ${label} from ${legacyPath} to ${targetPath}: ${reason}`);
    throw error;
  }
  log(`[compat] Imported legacy ${label} from ${legacyPath} to ${targetPath}.`);
}
