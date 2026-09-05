// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { CasStore, type ObjectRef, type Pool } from "@sciencediscovery/cas";
import type { CasObjectRef } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";

/** Capture authoritative domain tables. Legacy execution blobs become strong State Pool refs. */
export function versioningAuthorities(store: SessionStore, sessionId: string, runId: string): () => Promise<unknown> {
  const legacy = new CasStore(store.dataDir);
  const retained = new Map<string, Promise<ObjectRef>>();
  const retain = (ref: CasObjectRef, pool: Pool = "agent-state") => {
    const key = `${pool}:${ref.hash}:${ref.size}`;
    let saved = retained.get(key);
    if (!saved) { saved = legacy.retain(ref, pool); retained.set(key, saved); }
    return saved;
  };
  return async () => {
    const session = store.getSession(sessionId);
    const executions = await Promise.all((await store.listExecutionRuns(sessionId))
      .filter((execution) => execution.turnId === runId).map(async (execution) => ({
        ...execution,
        code: await retain(execution.code), stdout: await retain(execution.stdout), stderr: await retain(execution.stderr),
        envSnapshot: execution.envSnapshot ? await retain(execution.envSnapshot) : null,
      })));
    return {
      session: session ? { id: session.id, projectId: session.projectId } : null,
      permission: store.getSessionPermissionEpoch(sessionId) ?? null,
      plans: store.listSessionPlans(sessionId),
      artifacts: await Promise.all(store.listArtifacts(sessionId).map(async (artifact) => ({
        ...artifact, versions: await Promise.all(store.listArtifactVersions(sessionId, artifact.id).map(async (version) => ({
          ...version, content: await retain(version.content, "data"),
        }))),
      }))),
      environments: store.listEnvironments(),
      environmentRevisions: store.listEnvironmentRevisions(),
      children: store.listSubagents(sessionId),
      reviews: await store.listReviews(sessionId),
      artifactReviews: await store.listArtifactReviews(sessionId),
      executions,
    };
  };
}
