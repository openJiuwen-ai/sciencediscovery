// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

const securityConsentCapabilities = [
  "security.network",
  "security.approval_mode",
  "security.default_approval",
  "security.automatic_configuration",
  "proxy.default",
] as const;

export type SecurityConsentCapability = typeof securityConsentCapabilities[number];

export function configurationNeedsSecurityConsent(capabilityId: string): capabilityId is SecurityConsentCapability {
  return securityConsentCapabilities.some(id => id === capabilityId);
}
