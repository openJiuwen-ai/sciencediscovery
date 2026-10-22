// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/** Optional, adapter-authored evidence. It is data, never execution authority. */
export type RecoveryCapability = "supported" | "unsupported" | "unknown";
export interface RecoveryFile {
  path: string;
  sha256: string;
  size: number;
}
export interface RecoveryObject extends RecoveryFile {
  id: string;
  role: "result" | "checkpoint" | "diagnostic";
  state: "complete" | "partial" | "invalid" | "unknown";
  /** Semantic completeness is declared by the adapter, not inferred from existence. */
  validation: { status: "verified" | "failed" | "unverified"; validatorId?: string };
}
export interface RecoveryPoint {
  id: string;
  mode: "resume" | "reuse_results";
  /** Descriptive adapter entry, not a shell command to execute. */
  entryPointId: string;
  /** Bind the explicitly requested continuation command and directory. */
  codeDigest: string;
  cwd: string;
  requiredObjectIds: string[];
  requiredInputs: Array<RecoveryFile & { name: string; kind: "input" | "configuration" | "program" }>;
  /** Unautomatable prerequisites block continuation; they cannot be waived by a caller. */
  prerequisites: string[];
}
export interface RecoveryMetadata {
  schemaVersion: 1;
  /** Adapter copies SCIENCEDISCOVERY_EXECUTION_ID; stale sidecars are rejected. */
  executionId: string;
  adapter: { id: string; version: string };
  workUnits: Array<{ id: string; state: "completed" | "failed" | "partial" | "unknown" | "not_started" }>;
  failure?: { workUnitId?: string; reason: string };
  objects: RecoveryObject[];
  continuation: { capability: RecoveryCapability; reason?: string; points: RecoveryPoint[] };
}
/** Object identity is explicitly Runner-store scoped, never an API-local CAS ref. */
export interface RecoveryObjectReference {
  storeId: string;
  pool: "data" | "agent-state";
  objectId: `sha256:${string}`;
  size: number;
  mediaType: string;
}
export interface RecoveryManifest extends Omit<RecoveryMetadata, "objects"> {
  execution: {
    executionId: string;
    sessionId: string;
    agentId: string;
    workspaceKey: string;
    environmentRevisionId: string;
    processTerminated: true;
    exitCode: number;
  };
  producedAt: string;
  objects: Array<RecoveryObject & { ref?: RecoveryObjectReference; integrity: "verified" | "invalid" | "unverified" }>;
}
export interface ExecutionRecovery {
  schemaVersion: 1;
  capability: RecoveryCapability;
  reason?: string;
  /** Present only after publication with the original WorkspaceExecution. */
  manifestRef?: RecoveryObjectReference;
  manifest?: RecoveryManifest;
}
export interface RecoveryContext {
  parentExecutionId: string;
  recoveryPointId: string;
  manifestDigest: `sha256:${string}`;
  /** Same owner + token + request => the same new execution; changed request => conflict. */
  attemptToken: string;
}
export interface ShellRecoveryOptions {
  /** Workspace-relative JSON written by the adapter. Collection is opt-in. */
  recoveryMetadataPath?: string;
  recoveryContext?: RecoveryContext;
}
export const unknownRecovery = (reason = "NOT_REPORTED"): ExecutionRecovery => ({ schemaVersion: 1, capability: "unknown", reason });
export const RECOVERY_METADATA_MAX_BYTES = 1024 * 1024;
export const RECOVERY_OBJECT_MAX_BYTES = 64 * 1024 * 1024;
export const RECOVERY_TOTAL_MAX_BYTES = 256 * 1024 * 1024;

export function recoveryRelativePath(value: unknown, allowRoot = false): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1000
    && !value.includes("\\") && !value.includes("\0") && !value.startsWith("/")
    && (allowRoot && value === "." || value.split("/").every(part => part !== "" && part !== "." && part !== ".."));
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4000;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const list = (value: unknown, max = 1000): value is unknown[] => Array.isArray(value) && value.length <= max;
const file = (value: unknown): value is Record<string, unknown> => object(value) && recoveryRelativePath(value.path) && digest(value.sha256)
  && Number.isSafeInteger(value.size) && Number(value.size) >= 0 && Number(value.size) <= RECOVERY_OBJECT_MAX_BYTES;
const member = (value: unknown, choices: string[]) => typeof value === "string" && choices.includes(value);
const unique = (values: unknown[]) => new Set(values).size === values.length;

/** Reject malformed/oversized data without executing adapters, commands or URLs. */
export function parseRecoveryMetadata(value: unknown): RecoveryMetadata {
  const reject = (): never => { throw new Error("INVALID_RECOVERY_METADATA"); };
  if (!object(value) || value.schemaVersion !== 1 || !text(value.executionId)) return reject();
  if (!object(value.adapter) || !text(value.adapter.id) || !text(value.adapter.version)
    || !list(value.workUnits) || !list(value.objects) || !object(value.continuation)) return reject();
  const states = ["completed", "failed", "partial", "unknown", "not_started"];
  if (!value.workUnits.every(unit => object(unit) && text(unit.id) && member(unit.state, states))) return reject();
  if (!unique(value.workUnits.map(unit => (unit as Record<string, unknown>).id))) return reject();
  if (value.failure !== undefined && (!object(value.failure) || !text(value.failure.reason)
    || (value.failure.workUnitId !== undefined && !value.workUnits.some(unit => (unit as Record<string, unknown>).id === (value.failure as Record<string, unknown>).workUnitId)))) return reject();
  if (!value.objects.every(item => file(item) && text(item.id) && member(item.role, ["result", "checkpoint", "diagnostic"])
    && member(item.state, ["complete", "partial", "invalid", "unknown"]) && object(item.validation)
    && member(item.validation.status, ["verified", "failed", "unverified"])
    && (item.validation.validatorId === undefined || text(item.validation.validatorId))
    && (item.validation.status !== "verified" || text(item.validation.validatorId)))) return reject();
  if (!unique(value.objects.map(item => (item as Record<string, unknown>).id))) return reject();
  const continuation = value.continuation;
  if (!member(continuation.capability, ["supported", "unsupported", "unknown"]) || !list(continuation.points, 100)
    || (continuation.reason !== undefined && !text(continuation.reason))) return reject();
  if (continuation.capability === "supported" ? continuation.points.length === 0 : continuation.points.length !== 0 || !text(continuation.reason)) return reject();
  if (!continuation.points.every(point => object(point) && text(point.id) && text(point.entryPointId)
    && member(point.mode, ["resume", "reuse_results"]) && digest(point.codeDigest) && recoveryRelativePath(point.cwd, true)
    && list(point.requiredObjectIds) && point.requiredObjectIds.every(id => text(id) && (value.objects as unknown[]).some(item => (item as Record<string, unknown>).id === id))
    && unique(point.requiredObjectIds) && list(point.requiredInputs) && point.requiredInputs.every(input => file(input) && text(input.name)
      && member(input.kind, ["input", "configuration", "program"]))
    && list(point.prerequisites, 100) && point.prerequisites.every(text))) return reject();
  if (!unique(continuation.points.map(point => (point as Record<string, unknown>).id))) return reject();
  // Returning a projection drops caller-supplied trusted fields and arbitrary nested data.
  const parsed = value as unknown as RecoveryMetadata;
  return {
    schemaVersion: 1, executionId: parsed.executionId, adapter: { id: parsed.adapter.id, version: parsed.adapter.version },
    workUnits: parsed.workUnits.map(({ id, state }) => ({ id, state })),
    ...(parsed.failure ? { failure: { reason: parsed.failure.reason, ...(parsed.failure.workUnitId ? { workUnitId: parsed.failure.workUnitId } : {}) } } : {}),
    objects: parsed.objects.map(({ id, role, path, sha256, size, state, validation }) => ({ id, role, path, sha256, size, state,
      validation: { status: validation.status, ...(validation.validatorId ? { validatorId: validation.validatorId } : {}) } })),
    continuation: { capability: parsed.continuation.capability, ...(parsed.continuation.reason ? { reason: parsed.continuation.reason } : {}),
      points: parsed.continuation.points.map(({ id, mode, entryPointId, codeDigest, cwd, requiredObjectIds, requiredInputs, prerequisites }) => ({
        id, mode, entryPointId, codeDigest, cwd, requiredObjectIds, prerequisites,
        requiredInputs: requiredInputs.map(({ name, kind, path, sha256, size }) => ({ name, kind, path, sha256, size })),
      })) },
  };
}

export function assertRecoveryContext(value: unknown): asserts value is RecoveryContext {
  if (!object(value) || !text(value.parentExecutionId) || !text(value.recoveryPointId)
    || typeof value.manifestDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.manifestDigest)
    || typeof value.attemptToken !== "string" || !/^[A-Za-z0-9_:.-]{1,160}$/.test(value.attemptToken)) {
    throw new Error("INVALID_RECOVERY_CONTEXT");
  }
}
