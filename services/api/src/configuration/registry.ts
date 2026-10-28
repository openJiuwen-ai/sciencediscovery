// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationCapabilityId, ConfigurationCapabilityView } from "@sciencediscovery/schema";
import type { ConfigurationAdapter } from "./types.js";
import { ConfigurationError, integer, invalid } from "./validation.js";
import { CONFIGURATION_AGENT_DESCRIPTORS, type ConfigurationAgentDescriptor } from "./agent-metadata.js";
const supported = new Set<ConfigurationCapabilityId>(Object.keys(CONFIGURATION_AGENT_DESCRIPTORS) as ConfigurationCapabilityId[]);
export class ConfigurationRegistry {
  private readonly adapters = new Map<ConfigurationCapabilityId, ConfigurationAdapter>();
  private readonly descriptors = new Map<ConfigurationCapabilityId, ConfigurationAgentDescriptor>();
  register(adapter: ConfigurationAdapter, descriptor = CONFIGURATION_AGENT_DESCRIPTORS[adapter.id]): this {
    if (!supported.has(adapter.id) || this.adapters.has(adapter.id)) invalid("Unknown or duplicate configuration capability");
    integer(adapter.version, "adapterVersion"); integer(adapter.schemaVersion, "schemaVersion");
    if (!adapter.scopes.length || adapter.scopes.some((scope) => !["session", "project", "global"].includes(scope))) invalid("Invalid adapter scope");
    if (adapter.persistence !== "local_transaction" && adapter.persistence !== "external_control") invalid("Invalid adapter persistence");
    if (adapter.persistence === "local_transaction" && !adapter.apply) invalid("Local adapters require a synchronous domain apply");
    if (!descriptor?.label || !Object.keys(descriptor.fields).length) invalid("Registered capabilities require finite Agent metadata");
    this.adapters.set(adapter.id, adapter); this.descriptors.set(adapter.id, structuredClone(descriptor)); return this;
  }
  get(id: string): ConfigurationAdapter {
    const adapter = this.adapters.get(id as ConfigurationCapabilityId);
    if (!adapter) throw new ConfigurationError("CONFIGURATION_CAPABILITY_UNAVAILABLE", "This configuration capability is not available", 409);
    return adapter;
  }
  list(): ConfigurationCapabilityView[] {
    return [...this.adapters.values()].map((adapter) => ({ id: adapter.id, adapterVersion: adapter.version, schemaVersion: adapter.schemaVersion, scopes: [...adapter.scopes], persistence: adapter.persistence, autoApplyEligible: adapter.autoApplyEligible === true }));
  }
  describe() {
    return this.list().map(capability => ({ ...capability, ...this.descriptors.get(capability.id)! }));
  }
  fields(id: string) { this.get(id); return structuredClone(this.descriptors.get(id as ConfigurationCapabilityId)!.fields); }
  agentValues(id: string, input: unknown) {
    const adapter = this.get(id);
    const fields = this.descriptors.get(adapter.id)!.fields;
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(fields, key))) invalid("Unknown registered Agent field");
    return adapter.normalize(input);
  }
}
