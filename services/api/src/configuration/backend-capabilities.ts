// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/** DEV-CFG-10 / CFG-T26. An explicit host contract, never inferred from an RPC name/version. */
export interface BackendConfigurationCapabilities {
  protocolVersion: 1;
  backendId: string;
  baseline: { workswarmCommit: string | null; coreCommit: string | null; patches: string[] };
  control: { conditionalWrite: boolean; idempotentOperations: boolean; queryOperation: boolean };
  runtime: { durableInterrupt: boolean; exactResume: boolean; targetToolRefresh: boolean; durableWaitBinding: boolean };
  settings: Array<{ id: string; schemaVersion: number; scopes: string[]; activationModes: Array<"same_run" | "next_run" | "requires_restart"> }>;
  unavailableReasons: string[];
}

export const PINNED_JIUWENSWARM_BASELINE = {
  tag: "workswarm0.2.6",
  workswarmCommit: "70aa6715992d9cb2c3ec81ee35991d13747e5ce0",
  coreCommit: "ad0c9dfbbd577423cc60f73edffa0a4699cc53f9",
} as const;

export function unsupportedBackendCapabilities(backendId: string, reason: string): BackendConfigurationCapabilities {
  return {
    protocolVersion: 1, backendId,
    baseline: { workswarmCommit: null, coreCommit: null, patches: [] },
    control: { conditionalWrite: false, idempotentOperations: false, queryOperation: false },
    runtime: { durableInterrupt: false, exactResume: false, targetToolRefresh: false, durableWaitBinding: false },
    settings: [], unavailableReasons: [reason],
  };
}

export function parseBackendCapabilities(value: unknown): BackendConfigurationCapabilities {
  const fail = (): never => { throw new Error("Unsupported configuration backend capability contract"); };
  if (!value || typeof value !== "object") return fail();
  const v = value as BackendConfigurationCapabilities;
  if (v.protocolVersion !== 1 || typeof v.backendId !== "string" || !v.backendId || !v.baseline || !v.control || !v.runtime
    || !Array.isArray(v.settings) || !Array.isArray(v.unavailableReasons)) return fail();
  for (const hash of [v.baseline.workswarmCommit, v.baseline.coreCommit]) if (hash !== null && !/^[a-f0-9]{40}$/.test(hash)) return fail();
  if (!Array.isArray(v.baseline.patches) || !v.baseline.patches.every((p) => typeof p === "string" && p.length <= 160)) return fail();
  for (const flag of [v.control.conditionalWrite, v.control.idempotentOperations, v.control.queryOperation,
    v.runtime.durableInterrupt, v.runtime.exactResume, v.runtime.targetToolRefresh, v.runtime.durableWaitBinding]) if (typeof flag !== "boolean") return fail();
  const seen = new Set<string>();
  for (const setting of v.settings) {
    if (!setting || typeof setting.id !== "string" || !setting.id || seen.has(setting.id) || !Number.isInteger(setting.schemaVersion)
      || setting.schemaVersion < 1 || !Array.isArray(setting.scopes) || !setting.scopes.every((s) => typeof s === "string")
      || !Array.isArray(setting.activationModes) || !setting.activationModes.every((m) => ["same_run", "next_run", "requires_restart"].includes(m))) return fail();
    seen.add(setting.id);
  }
  if (!v.unavailableReasons.every((r) => typeof r === "string")) return fail();
  return structuredClone(v);
}

export function requireExternalControl(capabilities: BackendConfigurationCapabilities, settingId: string, scope: string): void {
  if (!capabilities.control.conditionalWrite || !capabilities.control.idempotentOperations || !capabilities.control.queryOperation)
    throw new Error("Backend lacks conditional writes, operation deduplication or authoritative operation queries");
  if (!capabilities.settings.some((s) => s.id === settingId && s.scopes.includes(scope)))
    throw new Error("Setting or scope is not registered by the backend");
}

export function requireSameRun(capabilities: BackendConfigurationCapabilities, settingId: string): void {
  if (!Object.values(capabilities.runtime).every(Boolean)
    || !capabilities.settings.some((s) => s.id === settingId && s.activationModes.includes("same_run")))
    throw new Error("Backend cannot durably resume this configuration interrupt in the same run");
}

export async function probeBackendCapabilities(options: { adapterUrl: string; adapterToken?: string; fetch?: typeof fetch }): Promise<BackendConfigurationCapabilities> {
  try {
    const response = await (options.fetch ?? fetch)(`${options.adapterUrl.replace(/\/+$/, "")}/agent/configuration/capabilities`, {
      headers: options.adapterToken ? { authorization: `Bearer ${options.adapterToken}` } : {},
      signal: AbortSignal.timeout(5_000), redirect: "error",
    });
    if (!response.ok) return unsupportedBackendCapabilities("jiuwenswarm", `Capability handshake unavailable (HTTP ${response.status})`);
    return parseBackendCapabilities(await response.json());
  } catch {
    return unsupportedBackendCapabilities("jiuwenswarm", "Capability handshake failed or returned an unsupported schema");
  }
}
