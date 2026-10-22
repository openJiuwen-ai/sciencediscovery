// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { RefStore, VersionStore, workspaceHeadName, type AgentStateRef, type ObjectRef } from "@sciencediscovery/cas";
import { parseRecoveryMetadata, recoveryRelativePath, unknownRecovery, RECOVERY_METADATA_MAX_BYTES,
  RECOVERY_TOTAL_MAX_BYTES,
  type ExecutionRecovery, type ManagedExecution, type RecoveryManifest, type RecoveryObjectReference,
  type ShellExecutionRequest } from "@sciencediscovery/schema";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export const recoveryWorkspaceKey = (root: string) => hash(resolve(root));
const scoped = (storeId: string, { digest, ...ref }: ObjectRef): RecoveryObjectReference => ({ ...ref, storeId, objectId: digest });
const local = ({ objectId, storeId: _, ...ref }: RecoveryObjectReference): ObjectRef => ({ ...ref, digest: objectId });

/** No symlinks, devices, FIFOs, traversal or unbounded reads. Called under the workspace lease. */
export async function readRecoveryFile(root: string, path: string, limit: number): Promise<Buffer> {
  if (!recoveryRelativePath(path)) throw new Error("UNSAFE_RECOVERY_PATH");
  const canonicalRoot = await realpath(root);
  const parts = path.split("/");
  let parent = canonicalRoot;
  for (const part of parts.slice(0, -1)) {
    parent = resolve(parent, part);
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("UNSAFE_RECOVERY_PATH");
  }
  const target = resolve(canonicalRoot, path);
  if (await realpath(dirname(target)) !== parent) throw new Error("UNSAFE_RECOVERY_PATH");
  const info = await lstat(target, { bigint: true });
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit) || before.ino !== info.ino || before.dev !== info.dev) throw new Error("INVALID_RECOVERY_FILE");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("RECOVERY_FILE_CHANGED");
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(target, { bigint: true });
    if (pathAfter.ino !== before.ino || pathAfter.dev !== before.dev || pathAfter.ctimeNs !== before.ctimeNs
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || await realpath(dirname(target)) !== parent) throw new Error("RECOVERY_FILE_CHANGED");
    return bytes;
  } finally { await handle.close(); }
}

export async function collectExecutionRecovery(versions: VersionStore, storeId: string,
  request: ShellExecutionRequest, execution: ManagedExecution): Promise<{ recovery: ExecutionRecovery; ref?: AgentStateRef }> {
  if (!request.recoveryMetadataPath) return { recovery: unknownRecovery() };
  if (request.directAuthorization || request.explicitHandoff) return { recovery: unknownRecovery("EXECUTION_MODE_UNSUPPORTED") };
  // A thrown transport/admission/storage error is NOT evidence that a process failed.
  if (execution.state !== "failed" || !execution.result || !Number.isInteger(execution.result.exitCode)
    || execution.result.exitCode === 0) return { recovery: unknownRecovery("ORIGINAL_NOT_CONFIRMED_FAILED") };
  try {
    const candidate = parseRecoveryMetadata(JSON.parse((await readRecoveryFile(request.workspaceRoot,
      request.recoveryMetadataPath, RECOVERY_METADATA_MAX_BYTES)).toString("utf8")));
    if (candidate.executionId !== execution.id) throw new Error("RECOVERY_EXECUTION_MISMATCH");
    const dependencies: ObjectRef[] = [];
    let retained = 0;
    const objects: RecoveryManifest["objects"] = [];
    for (const item of candidate.objects) {
      if (item.state !== "complete" || item.validation.status !== "verified") {
        objects.push({ ...item, integrity: "unverified" });
        continue;
      }
      try {
        retained += item.size;
        if (retained > RECOVERY_TOTAL_MAX_BYTES) throw new Error("RECOVERY_QUOTA_EXCEEDED");
        const bytes = await readRecoveryFile(request.workspaceRoot, item.path, item.size);
        if (bytes.length !== item.size || hash(bytes) !== item.sha256) throw new Error("INVALID_CHECKPOINT");
        const ref = await versions.put("data", bytes, "application/octet-stream");
        dependencies.push(ref);
        objects.push({ ...item, integrity: "verified", ref: scoped(storeId, ref) });
      } catch { objects.push({ ...item, integrity: "invalid" }); }
    }
    const manifest: RecoveryManifest = { ...candidate, objects, producedAt: new Date().toISOString(),
      execution: { executionId: execution.id, sessionId: execution.sessionId, agentId: execution.agentId,
        workspaceKey: recoveryWorkspaceKey(request.workspaceRoot), environmentRevisionId: execution.result.environmentRevisionId,
        processTerminated: true, exitCode: execution.result.exitCode } };
    const ref = await versions.putRecord("ExecutionRecovery", manifest, dependencies);
    return { ref, recovery: { schemaVersion: 1, capability: candidate.continuation.capability,
      ...(candidate.continuation.reason ? { reason: candidate.continuation.reason } : {}),
      manifestRef: scoped(storeId, ref), manifest } };
  } catch (error) {
    return { recovery: unknownRecovery(error instanceof Error ? error.message : "INVALID_RECOVERY_METADATA") };
  }
}

/** Re-read rooted immutable evidence; never trust a caller's readiness/manifest claims. */
export async function validateExecutionRecovery(versions: VersionStore, storeId: string,
  request: ShellExecutionRequest, parent: ManagedExecution): Promise<string> {
  const context = request.recoveryContext!;
  if (request.directAuthorization || request.explicitHandoff) throw new Error("RECOVERY_EXECUTION_MODE_UNSUPPORTED");
  if (parent.state !== "failed" || !parent.version || !parent.result || parent.result.exitCode === 0
    || !Number.isInteger(parent.result.exitCode)) throw new Error("ORIGINAL_NOT_CONFIRMED_FAILED");
  const refs = await RefStore.open(versions);
  try {
    if (refs.publicationSequence(workspaceHeadName(request.workspaceRoot), parent.version) === undefined) {
      throw new Error("RECOVERY_EVIDENCE_NOT_PUBLISHED");
    }
  } finally { refs.close(); }
  const parentRecord = await versions.readRecord<{ executionId: string; sessionId: string; agentId: string; state: string;
    recoveryManifest?: AgentStateRef }>(parent.version, "WorkspaceExecution");
  const ref = parentRecord.value.recoveryManifest;
  if (parentRecord.value.executionId !== parent.id || parentRecord.value.sessionId !== request.permissionEpoch.sessionId
    || parentRecord.value.agentId !== request.agentId || parentRecord.value.state !== "failed" || !ref
    || ref.digest !== context.manifestDigest) throw new Error("RECOVERY_EVIDENCE_MISMATCH");
  await versions.validateClosure(parent.version);
  const manifest = (await versions.readRecord<RecoveryManifest>(ref, "ExecutionRecovery")).value;
  const identity = manifest.execution;
  if (identity.executionId !== parent.id || identity.sessionId !== request.permissionEpoch.sessionId
    || identity.agentId !== request.agentId || identity.workspaceKey !== recoveryWorkspaceKey(request.workspaceRoot)
    || identity.processTerminated !== true || identity.exitCode === 0 || identity.exitCode !== parent.result.exitCode
    || identity.environmentRevisionId !== parent.result.environmentRevisionId) throw new Error("RECOVERY_IDENTITY_MISMATCH");
  if (manifest.continuation.capability !== "supported") throw new Error("RECOVERY_NOT_SUPPORTED");
  const point = manifest.continuation.points.find(point => point.id === context.recoveryPointId);
  if (!point) throw new Error("RECOVERY_POINT_NOT_FOUND");
  if (point.codeDigest !== hash(request.code) || point.cwd !== (request.cwd ?? ".")) throw new Error("RECOVERY_REQUEST_CHANGED");
  if (point.prerequisites.length) throw new Error("RECOVERY_PREREQUISITES_UNVERIFIED");
  let checked = 0;
  for (const id of point.requiredObjectIds) {
    const item = manifest.objects.find(item => item.id === id);
    if (!item || item.state !== "complete" || item.validation.status !== "verified" || item.integrity !== "verified"
      || !item.ref || item.ref.storeId !== storeId) throw new Error("INVALID_CHECKPOINT");
    checked += item.size;
    if (checked > RECOVERY_TOTAL_MAX_BYTES) throw new Error("RECOVERY_QUOTA_EXCEEDED");
    const frozen = await versions.read(local(item.ref));
    const current = await readRecoveryFile(request.workspaceRoot, item.path, item.size);
    if (current.length !== item.size || hash(current) !== item.sha256 || !frozen.equals(current)) throw new Error("RECOVERY_OUTPUT_CHANGED");
  }
  for (const input of point.requiredInputs) {
    checked += input.size;
    if (checked > RECOVERY_TOTAL_MAX_BYTES) throw new Error("RECOVERY_QUOTA_EXCEEDED");
    const bytes = await readRecoveryFile(request.workspaceRoot, input.path, input.size);
    if (bytes.length !== input.size || hash(bytes) !== input.sha256) throw new Error("RECOVERY_PRECONDITION_CHANGED");
  }
  return identity.environmentRevisionId;
}
