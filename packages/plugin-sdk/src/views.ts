// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/** Named host slots accept only their own typed inputs and outputs. */
export interface ViewContribution<Input, Output> {
  id: string;
  pluginId: string;
  priority?: number;
  matches(input: Input): boolean;
  render(input: Input): Output;
}
export function createViewRegistry<Input, Output>(entries: readonly ViewContribution<Input, Output>[], disabled: readonly string[] = []) {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.id || !entry.pluginId || ids.has(entry.id)) throw new Error("Invalid or duplicate view contribution");
    ids.add(entry.id);
  }
  const ordered = entries.filter((entry) => !disabled.includes(entry.pluginId))
    .map((entry) => Object.freeze({ ...entry }))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
  return Object.freeze({
    resolve(input: Input) { return ordered.find((entry) => entry.matches(input)); },
    list() { return ordered.map(({ id, pluginId, priority }) => ({ id, pluginId, priority })); },
  });
}
