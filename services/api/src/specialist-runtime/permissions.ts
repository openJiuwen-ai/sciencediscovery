// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { AgentPermissionRuntimeBindings } from "@sciencediscovery/governance";

/** External children share the live permission cell, but never inherit a
 * native backend's claim that its own approval engine already authorized code. */
export function routeSpecialistPermissions(
  native: AgentPermissionRuntimeBindings["requestPermission"],
  platform: AgentPermissionRuntimeBindings["requestPermission"],
  externalExecutions: ReadonlySet<string>,
): AgentPermissionRuntimeBindings["requestPermission"] {
  return (action, resource, summary, context) =>
    (context?.executionId && externalExecutions.has(context.executionId) ? platform : native)(action, resource, summary, context);
}
