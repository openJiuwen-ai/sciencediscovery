// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { SpecialistRuntime } from "@sciencediscovery/schema";

/** Fail closed: metadata is never an argv, environment or credential channel. */
export function normalizeSpecialistRuntime(value: unknown): SpecialistRuntime | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Specialist runtime");
  const runtime = value as Record<string, unknown>;
  if (runtime.kind !== "native" && runtime.kind !== "codex") throw new Error("Unsupported Specialist runtime");
  const allowed = runtime.kind === "codex" ? ["kind", "model"] : ["kind"];
  if (Object.keys(runtime).some(key => !allowed.includes(key))) throw new Error("Runtime accepts only kind and Codex model; use the secret channel for credentials");
  if (runtime.kind === "native") return { kind: "native" };
  if (runtime.model !== undefined && (typeof runtime.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(runtime.model))) {
    throw new Error("Invalid Codex model ID");
  }
  return { kind: "codex", ...(runtime.model ? { model: runtime.model as string } : {}) };
}
