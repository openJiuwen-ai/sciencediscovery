// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { IdeaTreeGraph, IdeaTreeState } from "@sciencediscovery/schema";
import {
  IdeaTreePersistenceError, IdeaTreeRuntimeError,
  type IdeaTreeCommandContext, type IdeaTreePersistence,
} from "@sciencediscovery/idea-tree";

/** Scope comes from SessionStore; Agent arguments cannot choose filesystem paths. */
export function ideaTreeRepositoryForSession(
  options: { url: string; token?: string },
  scope: { projectId: string; sessionId: string },
): IdeaTreePersistence {
  async function call<T>(operation: string, params: object, context: IdeaTreeCommandContext = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${options.url.replace(/\/$/, "")}/idea-tree/command`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
        body: JSON.stringify({ ...scope, ...context, operation, params }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new IdeaTreePersistenceError("PERSISTENCE_UNAVAILABLE", `Idea Tree Python service is unavailable: ${String(error)}`);
    }
    const body = await response.json() as { result: T; detail?: { code?: string; message?: string } };
    if (!response.ok) {
      throw new IdeaTreeRuntimeError(body.detail?.code ?? "STORAGE_ERROR", body.detail?.message ?? `Idea Tree HTTP ${response.status}`);
    }
    return body.result;
  }
  return {
    key: `python:${scope.projectId}:${scope.sessionId}`, call,
    deleteAll: () => call<void>("deleteAll", {}),
    listTreeIds: () => call<string[]>("listTreeIds", {}),
    readTree: (treeId) => call<IdeaTreeState | null>("readTree", { treeId }),
    readGraph: (treeId) => call<IdeaTreeGraph | null>("readGraph", { treeId }),
  };
}
