// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/** JSON snapshots only: no live services, credentials or mutable handles. */
export interface ComponentState {
  id: string;
  schemaVersion: number;
  revision: string;
  value: unknown;
  fidelity: "captured" | "reference-only";
}

export interface StateCheckpoint {
  id: string;
  scope: string;
  components: readonly ComponentState[];
}

export interface StateView {
  readonly checkpoint: StateCheckpoint;
  read<T>(id: string, schemaVersion?: number): T;
  restrict(ids: readonly string[]): StateView;
}

/** Reject values which JSON would silently drop or coerce before hashing. */
export function canonicalState(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalState).join(",")}]`;
  if (typeof value === "object" && value !== null
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalState((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("State must contain only finite JSON values");
}

/** Never return the retained object: a consumer cannot mutate another projection. */
export function createStateView(input: StateCheckpoint): StateView {
  const snapshot = JSON.parse(canonicalState(input)) as StateCheckpoint;
  if (!snapshot.id || !snapshot.scope) throw new Error("State checkpoint identity is required");
  const states = new Map<string, ComponentState>();
  for (const state of snapshot.components) {
    if (!/^[a-z][a-z0-9._-]*$/.test(state.id) || states.has(state.id)) throw new Error(`Invalid or duplicate state: ${state.id}`);
    if (!Number.isSafeInteger(state.schemaVersion) || state.schemaVersion < 1 || !state.revision) throw new Error(`Invalid state version: ${state.id}`);
    if (state.fidelity !== "captured" && state.fidelity !== "reference-only") throw new Error(`Invalid state fidelity: ${state.id}`);
    states.set(state.id, state);
  }
  return Object.freeze({
    get checkpoint() { return structuredClone(snapshot); },
    read<T>(id: string, schemaVersion = 1): T {
      const state = states.get(id);
      if (!state) throw new Error(`State not available in this scope: ${id}`);
      if (state.schemaVersion !== schemaVersion) throw new Error(`Unsupported state schema: ${id}@${state.schemaVersion}`);
      return structuredClone(state.value) as T;
    },
    restrict(ids: readonly string[]): StateView {
      const allowed = new Set(ids);
      for (const id of allowed) if (!states.has(id)) throw new Error(`State not available in this scope: ${id}`);
      return createStateView({ ...snapshot, components: snapshot.components.filter((state) => allowed.has(state.id)) });
    },
  });
}

export interface StateProvider {
  readonly id: string;
  capture(signal: AbortSignal): Promise<ComponentState>;
}

/**
 * Optimistic barrier for cooperating local providers. Two complete reads must
 * agree, including revisions. Reference-only observations are pinned once per
 * checkpoint: they are not participants in the local consistency barrier.
 */
export async function captureStateView(input: {
  id: string;
  scope: string;
  providers: readonly StateProvider[];
  signal: AbortSignal;
  maxAttempts?: number;
}): Promise<StateView> {
  const providers = [...input.providers].sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(providers.map((p) => p.id)).size !== providers.length) throw new Error("Duplicate state provider");
  const attempts = input.maxAttempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) throw new Error("Invalid state capture retry limit");
  const references = new Map<string, ComponentState>();
  const read = async () => {
    const values: ComponentState[] = [];
    for (const provider of providers) {
      input.signal.throwIfAborted();
      const state = references.get(provider.id) ?? await provider.capture(input.signal);
      if (state.id !== provider.id) throw new Error(`State provider identity mismatch: ${provider.id}`);
      const snapshot = JSON.parse(canonicalState(state)) as ComponentState;
      if (snapshot.fidelity === "reference-only") references.set(provider.id, snapshot);
      values.push(snapshot);
    }
    input.signal.throwIfAborted();
    return values;
  };
  const changed = new Set<string>();
  for (let attempt = 0; attempt < attempts; attempt++) {
    const before = await read();
    const after = await read();
    if (canonicalState(before) === canonicalState(after)) return createStateView({ id: input.id, scope: input.scope, components: after });
    for (let index = 0; index < before.length; index++) {
      if (canonicalState(before[index]) !== canonicalState(after[index])) changed.add(before[index]!.id);
    }
  }
  throw new Error(`State changed during checkpoint capture: ${[...changed].join(", ")}`);
}
