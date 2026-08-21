// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

export type ContextAssemblyMode = "dynamic" | "legacy" | "shadow";

export function resolveContextAssemblyMode(
  env: NodeJS.ProcessEnv = process.env,
): ContextAssemblyMode {
  const value = env.SCIENCE_AGENT_CONTEXT_MODE?.trim().toLowerCase() || "legacy";
  if (value === "dynamic" || value === "legacy" || value === "shadow") return value;
  throw new Error("SCIENCE_AGENT_CONTEXT_MODE must be dynamic, legacy, or shadow");
}
