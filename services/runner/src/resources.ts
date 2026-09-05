// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0

import { mkdir, realpath, statfs } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem, uptime } from "node:os";
import { resolve } from "node:path";
import type { RunnerResources } from "@sciencediscovery/schema";

export async function collectRunnerResources(dataDir: string): Promise<RunnerResources> {
  const result: RunnerResources = {
    capturedAt: new Date().toISOString(),
    cpuCores: cpus().length,
    loadAverage1m: loadavg()[0] ?? 0,
    memoryTotalBytes: totalmem(),
    memoryFreeBytes: freemem(),
    uptimeSeconds: uptime(),
    workspaceDisk: null,
  };
  try {
    const root = resolve(await realpath(dataDir), "remote-workspaces");
    await mkdir(root, { recursive: true });
    if (await realpath(root) !== root) throw new Error("Workspace root must not be a symlink");
    // Measure the actual workspace mount, not dataDir or the host's root disk.
    // bavail excludes reserved blocks, unlike bfree. Do not scan users' files.
    const fs = await statfs(root);
    result.workspaceDisk = {
      path: root,
      totalBytes: fs.blocks * fs.bsize,
      availableBytes: Math.max(0, fs.bavail * fs.bsize),
    };
  } catch {
    result.workspaceDiskError = "Workspace filesystem metrics unavailable; check the Runner workspace directory and permissions.";
  }
  return result;
}
