// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { CasStore, publishWorkspaceFile, VersionStore } from "@sciencediscovery/cas";
import { normalizeWorkspaceRelativePath } from "@sciencediscovery/workspace";
import type { SessionStore } from "../store.js";

/** Project-scoped immutable input -> the caller's local execution workspace. */
export async function materializeArtifact(store: SessionStore, input: {
  sessionId: string; workspaceRoot: string; sourcePathPrefix?: string; subagentId?: string;
  artifactId: string; version: number; path: string; signal?: AbortSignal;
}) {
  store.assertSessionWritable(input.sessionId);
  const session = store.getSession(input.sessionId)!;
  const artifact = store.getProjectArtifact(session.projectId, input.artifactId);
  if (!artifact || artifact.deletedAt) throw new Error("Artifact not found in this Project");
  const version = store.listProjectArtifactVersions(session.projectId, artifact.id).find(v => v.version === input.version);
  if (!version) throw new Error("Artifact version not found");
  const path = normalizeWorkspaceRelativePath(input.workspaceRoot, input.path);
  const copied = await publishWorkspaceFile({
    root: input.workspaceRoot, path, chunks: new CasStore(store.dataDir).stream(version.content.hash),
    expectedHash: version.content.hash, expectedBytes: version.content.size,
    reuseIdentical: true, versions: new VersionStore(store.dataDir), signal: input.signal,
    verifySource: async () => {
      store.assertSessionWritable(input.sessionId);
      const current = store.getProjectArtifact(session.projectId, artifact.id);
      if (!current || current.deletedAt) throw new Error("Artifact not found in this Project");
    },
  });
  await store.recordWorkspaceFileRevision(input.sessionId, {
    path: input.sourcePathPrefix ? `${input.sourcePathPrefix}/${path}` : path,
    mode: "write", origin: "system", artifactVersionId: version.id,
    contentHash: copied.sha256, size: copied.bytes, modifiedAt: new Date().toISOString(),
    ...(input.subagentId ? { subagentId: input.subagentId } : {}),
    originMeta: { kind: "artifact-materialization", artifactId: artifact.id, versionId: version.id },
  });
  return { artifact_id: artifact.id, version: version.version, version_id: version.id,
    path, sha256: copied.sha256, size: copied.bytes };
}
