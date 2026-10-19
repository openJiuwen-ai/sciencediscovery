// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { SpecialistRuntime } from "@sciencediscovery/schema";

export class SpecialistRuntimeConfigError extends Error {
  readonly code = "SPECIALIST_RUNTIME_INVALID";
}

/** Fail closed: metadata is never an argv, environment or credential channel. */
export function normalizeSpecialistRuntime(value: unknown): SpecialistRuntime | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SpecialistRuntimeConfigError("Invalid Specialist runtime");
  const runtime = value as Record<string, unknown>;
  if (runtime.kind !== "native" && runtime.kind !== "codex") throw new SpecialistRuntimeConfigError("Unsupported Specialist runtime");
  const allowed = runtime.kind === "codex" ? ["kind", "model", "fallback", "timeoutSeconds", "reasoningEffort", "execution"] : ["kind"];
  if (Object.keys(runtime).some(key => !allowed.includes(key))) throw new SpecialistRuntimeConfigError("Unknown runtime option; use the secret channel for credentials");
  if (runtime.kind === "native") return { kind: "native" };
  if (runtime.model !== undefined && (typeof runtime.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(runtime.model))) {
    throw new SpecialistRuntimeConfigError("Invalid Codex model ID");
  }
  if (runtime.execution !== undefined && !["sandbox", "direct"].includes(runtime.execution as string)) throw new SpecialistRuntimeConfigError("Invalid execution mode");
  if (runtime.fallback !== undefined && typeof runtime.fallback !== "boolean") throw new SpecialistRuntimeConfigError("Invalid fallback option");
  if (runtime.timeoutSeconds !== undefined && (!Number.isSafeInteger(runtime.timeoutSeconds) || (runtime.timeoutSeconds as number) < 1 || (runtime.timeoutSeconds as number) > 86400)) throw new SpecialistRuntimeConfigError("Invalid runtime timeout (1-86400 seconds)");
  if (runtime.reasoningEffort !== undefined && !["minimal", "low", "medium", "high", "xhigh"].includes(runtime.reasoningEffort as string)) throw new SpecialistRuntimeConfigError("Invalid reasoning effort");
  return { kind: "codex", ...(runtime.execution ? { execution: runtime.execution as "sandbox" | "direct" } : {}), ...("fallback" in runtime ? { fallback: runtime.fallback as boolean } : {}),
    ...("timeoutSeconds" in runtime ? { timeoutSeconds: runtime.timeoutSeconds as number } : {}),
    ...("reasoningEffort" in runtime ? { reasoningEffort: runtime.reasoningEffort as "high" } : {}), ...(runtime.model ? { model: runtime.model as string } : {}) };
}
