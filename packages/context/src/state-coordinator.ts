// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ComponentState } from "./state-view.js";
import { canonicalState } from "./state-view.js";

/** Serialize authoritative commands and snapshot reads, not tool execution or model I/O. */
export class StateCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }
  command<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      // Advance even after partial failure: an observation must not alias the old revision.
      try { return await work(); } finally { this.revision++; }
    });
  }
  capture<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<{ revision: string; value: T }> {
    return this.exclusive(async () => { signal?.throwIfAborted(); return { revision: String(this.revision), value: structuredClone(await read()) }; });
  }
}

/** Pure migration of a captured value. Persistence still goes through its owner command. */
export function migrateComponentState(state: ComponentState, target: number,
  migrations: ReadonlyMap<number, (value: unknown) => unknown>): ComponentState {
  if (!Number.isSafeInteger(target) || target < 1 || !Number.isSafeInteger(state.schemaVersion) || state.schemaVersion < 1) throw new Error("Invalid state schema version");
  if (state.schemaVersion > target) throw new Error("State downgrade is unsupported");
  let next = structuredClone(state);
  while (next.schemaVersion < target) {
    const migrate = migrations.get(next.schemaVersion);
    if (!migrate) throw new Error(`Missing state migration: ${next.id}@${next.schemaVersion}`);
    next = { ...next, schemaVersion: next.schemaVersion + 1, value: structuredClone(migrate(next.value)) };
    canonicalState(next);
  }
  return next;
}
