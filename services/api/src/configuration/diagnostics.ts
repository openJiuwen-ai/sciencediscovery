// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { CONFIGURATION_AGENT_DESCRIPTORS } from "./agent-metadata.js";
/** Structured classifications only: raw tool text and natural-language keywords are not evidence. */
export function configurationDiagnostic(code: string) {
  const capabilityIds = Object.entries(CONFIGURATION_AGENT_DESCRIPTORS).filter(([, descriptor]) => descriptor.diagnostics.includes(code)).map(([id]) => id);
  return { code, capabilityIds, instruction: capabilityIds.length
    ? "Inspect the exact target and current effective settings before proposing. A diagnostic is not user authorization. Existing defaults and previously declined needs must be respected."
    : "No registered configuration remedy for this failure. Network errors, empty results, rate limits and unknown failures do not prove missing credentials, proxy configuration or inadequate quotas. Continue safe work or report the actual blocker." };
}
