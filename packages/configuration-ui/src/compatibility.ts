// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/** UI-only server projections. These do not register or enable backend capabilities. */
export interface ConfigurationSecurityConsent {
  revision: number;
  targetDigest: string;
  statement: string;
  status: "required" | "confirmed";
}
export type SecurityConsentCapability = "security.network" | "security.approval_mode" | "security.default_approval"
  | "security.automatic_configuration" | "proxy.default";
export function configurationNeedsSecurityConsent(capabilityId: string): boolean {
  return ["security.network", "security.approval_mode", "security.default_approval", "security.automatic_configuration", "proxy.default"].includes(capabilityId);
}
export function configurationSecurityConsent(request: object): ConfigurationSecurityConsent | undefined {
  if (!("securityConsent" in request)) return undefined;
  const value = request.securityConsent;
  if (!value || typeof value !== "object") return undefined;
  if (!("revision" in value) || !Number.isSafeInteger(value.revision) || typeof value.revision !== "number"
    || !("targetDigest" in value) || typeof value.targetDigest !== "string" || !value.targetDigest.trim()
    || !("statement" in value) || typeof value.statement !== "string" || !value.statement.trim()
    || !("status" in value) || !["required", "confirmed"].includes(String(value.status))) return undefined;
  return value as ConfigurationSecurityConsent;
}
export function securityAcknowledgementText(capabilityId: string, copy: object, fallback: string): string {
  if (!Object.hasOwn(copy, capabilityId)) return fallback;
  const text = (copy as Record<string, unknown>)[capabilityId];
  return typeof text === "string" && text.length > 0 ? text : fallback;
}
