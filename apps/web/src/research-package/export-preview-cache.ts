// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ApiClient } from "../api.js";
type Preview = Awaited<ReturnType<ApiClient["previewResearchPackage"]>>;
export type DefaultPreviews = Awaited<ReturnType<ApiClient["getResearchPackagePreviews"]>>;
type Client = Pick<ApiClient, "previewResearchPackage" | "getResearchPackagePreviews">;
type CacheState = { entries: Map<string, Promise<Preview>>; defaults: Map<string, DefaultPreviews>; pending: Map<string, Promise<DefaultPreviews>>; listeners: Set<() => void>; generations: Map<string, number>; sessionRevisions: Map<string, string> };
/** Per-client cache; results live until their evidence revision changes. */
export class ExportPreviewCache {
  private static states = new WeakMap<Client, CacheState>();
  private state: CacheState;
  constructor(private client: Client) {
    let state = ExportPreviewCache.states.get(client);
    if (!state) { state = { entries: new Map(), defaults: new Map(), pending: new Map(), listeners: new Set(), generations: new Map(), sessionRevisions: new Map() }; ExportPreviewCache.states.set(client, state); }
    this.state = state;
  }
  subscribe(listener: () => void) { this.state.listeners.add(listener); return () => { this.state.listeners.delete(listener); }; }
  peekDefaults(projectId: string, sessionId: string) { return this.state.defaults.get(JSON.stringify([projectId, sessionId])); }
  isSessionRevisionCurrent(projectId: string, sessionId: string, revision?: string) {
    if (revision === undefined) return true;
    return this.state.sessionRevisions.get(JSON.stringify([projectId, sessionId])) === revision;
  }
  notifySessionRevision(projectId: string, sessionId: string, revision?: string) {
    if (!revision) return;
    const key = JSON.stringify([projectId, sessionId]);
    const previous = this.state.sessionRevisions.get(key);
    if (previous === revision) return;
    this.state.sessionRevisions.set(key, revision);
    if (previous !== undefined) {
      this.state.generations.set(key, (this.state.generations.get(key) ?? 0) + 1);
      this.state.defaults.delete(key);
      this.state.pending.delete(key);
      for (const entryKey of this.state.entries.keys()) {
        try { const parts = JSON.parse(entryKey) as unknown[]; if (parts[0] === projectId && parts[1] === sessionId) this.state.entries.delete(entryKey); }
        catch { this.state.entries.delete(entryKey); }
      }
    }
    for (const listener of this.state.listeners) listener();
  }
  refreshDefaults(projectId: string, sessionId: string): Promise<DefaultPreviews> {
    const key = JSON.stringify([projectId, sessionId]);
    const pending = this.state.pending.get(key);
    if (pending) return pending;
    const generation = this.state.generations.get(key) ?? 0;
    const work = this.client.getResearchPackagePreviews(projectId, sessionId).then((result) => {
      if ((this.state.generations.get(key) ?? 0) === generation && this.state.defaults.get(key)?.revision !== result.revision) {
        this.state.defaults.set(key, result);
        if (this.state.defaults.size > 48) this.state.defaults.delete(this.state.defaults.keys().next().value!);
        for (const listener of this.state.listeners) listener();
      }
      return result;
    });
    this.state.pending.set(key, work);
    void work.finally(() => { if (this.state.pending.get(key) === work) this.state.pending.delete(key); }).catch(() => undefined);
    return work;
  }
  get(projectId: string, sessionId: string, level: "necessary" | "complete", paths?: string[], includeFullTrajectory = false, revision?: string, includeFullMemoryGraph = false) {
    const defaults = this.peekDefaults(projectId, sessionId);
    if (!paths && defaults && (!revision || revision === defaults.revision)) {
      if (level === "necessary") return Promise.resolve(defaults.necessary);
      if (includeFullMemoryGraph) return Promise.resolve(includeFullTrajectory ? defaults.completeWithTrajectoryAndMemoryGraph : defaults.completeWithMemoryGraph);
      return Promise.resolve(includeFullTrajectory ? defaults.completeWithTrajectory : defaults.complete);
    }
    const selected = paths ? [...new Set(paths)].sort() : undefined;
    const key = JSON.stringify([projectId, sessionId, revision, level, includeFullTrajectory, includeFullMemoryGraph, selected]);
    const cached = this.state.entries.get(key);
    if (cached) return cached;
    const work = this.client.previewResearchPackage(projectId, sessionId, level, selected, includeFullTrajectory, includeFullMemoryGraph);
    this.state.entries.set(key, work);
    void work.catch(() => { if (this.state.entries.get(key) === work) this.state.entries.delete(key); });
    if (this.state.entries.size > 96) this.state.entries.delete(this.state.entries.keys().next().value!);
    return work;
  }
}
