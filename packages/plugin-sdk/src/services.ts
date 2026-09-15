// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ServiceContract } from "./configuration.js";

/** One scoped owner per contract. Never silently replace a registered provider. */
export class ServiceRegistry {
  private readonly values = new Map<string, { version: number; value: unknown }>();
  provide<T>(contract: ServiceContract, value: T): () => void {
    if (!contract.id || !Number.isSafeInteger(contract.version) || contract.version < 1) throw new Error("Invalid service contract");
    if (this.values.has(contract.id)) throw new Error(`Service already provided: ${contract.id}`);
    const entry = { version: contract.version, value };
    this.values.set(contract.id, entry);
    return () => { if (this.values.get(contract.id) === entry) this.values.delete(contract.id); };
  }
  require<T>(contract: ServiceContract): T | undefined {
    const entry = this.values.get(contract.id);
    if (entry?.version === contract.version) return entry.value as T;
    if (contract.optional) return undefined;
    throw new Error(`Service unavailable: ${contract.id}@${contract.version}`);
  }
  describe(): ServiceContract[] { return [...this.values].map(([id, { version }]) => ({ id, version })); }
}
