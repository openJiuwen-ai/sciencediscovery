// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ConfigField, Json, ServiceContract } from "./configuration.js";
export * from "./configuration.js";
export * from "./services.js";
export * from "./bridge.js";

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly requires?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly entries?: { readonly runtime?: string; readonly web?: string; readonly platform?: string };
  readonly services?: { readonly provides?: readonly ServiceContract[]; readonly requires?: readonly ServiceContract[] };
  readonly permissions?: readonly string[];
  readonly configuration?: {
    readonly schemaVersion: number; readonly scopes: readonly ("global" | "project" | "session")[];
    readonly applies: "nextRun" | "restart"; readonly fields: Readonly<Record<string, ConfigField>>;
    readonly defaults?: Readonly<Record<string, Json>>;
  };
  readonly contributes?: readonly string[];
  readonly settingsFields?: readonly string[];
}
export interface PluginInstance<C> {
  readonly contribution: C;
  start?(signal: AbortSignal): Promise<void>;
  dispose?(): void | Promise<void>;
}
export interface PluginDefinition<C> {
  readonly manifest: PluginManifest;
  create(): PluginInstance<C>;
}
export interface PluginScope<C> {
  readonly manifests: readonly PluginManifest[];
  readonly contributions: readonly C[];
  start(signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

/** A trusted build-time installation; dependencies resolve before factories run. */
export async function createPluginScope<C>(definitions: readonly PluginDefinition<C>[], disabled: readonly string[] = []): Promise<PluginScope<C>> {
  const excluded = new Set(disabled);
  const known = new Set(definitions.map((item) => item.manifest.id));
  for (const id of excluded) if (!known.has(id)) throw new Error(`Unknown plugin: ${id}`);
  const byId = new Map<string, PluginDefinition<C>>();
  for (const definition of definitions) {
    const { id, version, apiVersion } = definition.manifest;
    if (!/^[a-z][a-z0-9.-]*$/.test(id) || !version || apiVersion !== 1) throw new Error(`Invalid plugin manifest: ${id}`);
    if (byId.has(id)) throw new Error(`Duplicate plugin: ${id}`);
    byId.set(id, definition);
  }
  const ordered: PluginDefinition<C>[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Plugin dependency cycle: ${id}`);
    const definition = byId.get(id);
    if (!definition || excluded.has(id)) throw new Error(`Plugin dependency unavailable: ${id}`);
    visiting.add(id);
    for (const dependency of definition.manifest.requires ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(definition);
  };
  for (const id of byId.keys()) if (!excluded.has(id)) visit(id);
  const instances: PluginInstance<C>[] = [];
  const manifests = ordered.map((item) => structuredClone(item.manifest));
  let disposed = false;
  let started = false;
  let startPromise: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  const cleanup = () => disposal ??= (async () => {
    disposed = true;
    const errors: unknown[] = [];
    for (const instance of [...instances].reverse()) {
      try { await instance.dispose?.(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Plugin disposal failed");
  })();
  const dispose = async () => {
    disposed = true;
    await startPromise?.catch(() => undefined);
    await cleanup();
  };
  try {
    for (const definition of ordered) instances.push(definition.create());
  } catch (error) {
    try { await dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Plugin activation failed"); }
    throw error;
  }
  return Object.freeze({
    get manifests() { return structuredClone(manifests); },
    contributions: Object.freeze(instances.map((item) => item.contribution)),
    start(signal: AbortSignal) {
      if (disposed || started) return Promise.reject(new Error("Plugin scope already started or disposed"));
      started = true;
      startPromise = (async () => { try {
        for (const instance of instances) {
          if (disposed) throw new Error("Plugin scope disposed during start");
          signal.throwIfAborted();
          await instance.start?.(signal);
        }
        signal.throwIfAborted();
      } catch (error) {
        try { await cleanup(); } catch (failure) { throw new AggregateError([error, failure], "Plugin start failed"); }
        throw error;
      } })();
      return startPromise;
    },
    dispose,
  });
}
