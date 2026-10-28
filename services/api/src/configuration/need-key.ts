// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationCapabilityId, EffectiveRuntimeSettings } from "@sciencediscovery/schema";
import { filterEnabledMcpSources } from "@sciencediscovery/mcp-sources";
import type { ConfigurationSnapshot } from "./types.js";
import { digest } from "./validation.js";

/** A refusal applies to its task and relevant configuration need. Unrelated
 * model, Skill or reviewer edits must not invite the same connector card again. */
export function configurationNeedKey(input: { runId?: string; capabilityId: ConfigurationCapabilityId; target: string; snapshot: ConfigurationSnapshot }): string {
  const effective = input.snapshot.data.effective as EffectiveRuntimeSettings | undefined;
  const installed = input.snapshot.data.installedConnectorIds as string[] | undefined;
  const baseline = input.capabilityId === "connector.enable" ? {
    installed: installed?.includes(input.target) ?? false,
    enabled: effective?.enabledConnectorIds.includes(input.target) ?? false,
    permitted: effective ? filterEnabledMcpSources([input.target], effective.plugins).includes(input.target) : false,
    connectorCatalog: input.snapshot.resourceVersions.connectorCatalog,
    policies: input.snapshot.resourceVersions.policies,
  } : input.snapshot.resourceVersions;
  return digest({ runId: input.runId, capabilityId: input.capabilityId, target: input.target, baseline });
}
