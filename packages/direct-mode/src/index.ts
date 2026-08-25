// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ExecutionModeDescriptor, ExecutionModePlugin } from "@sciencediscovery/execution-modes";
import type { RuntimeMessage } from "@sciencediscovery/runtime-core";
import type { AgentTool } from "@sciencediscovery/tools";

export const DIRECT_MODE_DESCRIPTOR: ExecutionModeDescriptor = Object.freeze({
  description: "Execute the request directly with the available tools, without maintaining a formal plan lifecycle.",
  id: "direct",
  label: "Direct",
});

/** Default unstructured execution: preserves the pre-mode capability set. */
export function createDirectMode<TMessage extends RuntimeMessage = RuntimeMessage>(
  tools: readonly AgentTool[],
): ExecutionModePlugin<TMessage> {
  return {
    descriptor: DIRECT_MODE_DESCRIPTOR,
    tools,
  };
}
