// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { readFileSync } from "node:fs";

/** Read the identity shipped with this build, never the deployment's Git HEAD. */
export function readRunnerVersion(metadata: URL): string {
  try {
    const { version } = JSON.parse(readFileSync(metadata, "utf8")) as { version?: unknown };
    return typeof version === "string" && /^(?:[0-9a-f]{8}(?:-dirty)?|unknown)$/.test(version)
      ? version : "unknown";
  } catch {
    return "unknown";
  }
}

export const RUNNER_VERSION = readRunnerVersion(new URL("./build-info.json", import.meta.url));
