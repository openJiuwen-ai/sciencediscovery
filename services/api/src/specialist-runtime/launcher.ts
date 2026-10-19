// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { access } from "node:fs/promises";
import { prepareSpecialistLauncher } from "@sciencediscovery/runner";

/** Resolve the pinned SDK's optional CLI package, never an arbitrary PATH tool. */
export async function sandboxedCodex(workspaceRoot: string, privateRoot: string): Promise<string> {
  const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const cliRequire = createRequire(sdkRequire.resolve("@openai/codex/package.json"));
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "unsupported";
  const target = process.arch === "x64" ? "x86_64" : "aarch64";
  const root = dirname(cliRequire.resolve(`@openai/codex-linux-${arch}/package.json`));
  const vendor = join(root, "vendor", `${target}-unknown-linux-musl`);
  let binary = join(vendor, "bin", "codex");
  try { await access(binary); } catch { binary = join(vendor, "codex", "codex"); }
  return prepareSpecialistLauncher({ binary, workspaceRoot, privateRoot });
}
