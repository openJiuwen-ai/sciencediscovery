// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { AgentShellExecutionResult } from "@sciencediscovery/schema";

/** Runner publication receipts are installation-local; output evidence is portable. */
export function portableShellResult(result: AgentShellExecutionResult): Omit<AgentShellExecutionResult, "workspaceSnapshot" | "workspaceVersion"> {
  const { workspaceSnapshot: _snapshot, workspaceVersion: _version, ...portable } = result;
  return portable;
}
