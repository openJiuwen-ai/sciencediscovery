// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface RunnerExecutable { path: string; id: string; architecture: "x64" | "arm64"; size: number; }

export async function loadRunnerExecutable(architecture: string): Promise<RunnerExecutable> {
  const arch = architecture === "x86_64" || architecture === "x64" ? "x64"
    : architecture === "aarch64" || architecture === "arm64" ? "arm64" : undefined;
  if (!arch) throw new Error(`No Runner SEA binary is available for Linux architecture ${architecture || "unknown"}`);
  const path = join(dirname(createRequire(import.meta.url).resolve("@sciencediscovery/runner")), "sea", `linux-${arch}`, "sciencediscovery-runner");
  let metadata: { id: string; size: number; architecture: string };
  try { metadata = JSON.parse(await readFile(`${path}.json`, "utf8")); }
  catch { throw new Error(`This installation is missing its Linux ${arch} Runner SEA artifact. Build or install the Runner binaries on the application machine; remote Node is not required.`); }
  if (!/^[a-f0-9]{64}$/.test(metadata.id) || metadata.architecture !== arch || metadata.size !== (await stat(path)).size) throw new Error("Runner SEA artifact metadata is invalid; rebuild the application artifacts");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== metadata.id) throw new Error("Runner SEA artifact checksum mismatch; rebuild the application artifacts");
  return { ...metadata, architecture: arch, path };
}
