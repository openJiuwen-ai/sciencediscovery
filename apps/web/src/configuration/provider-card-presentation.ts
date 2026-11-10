// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { DEFAULT_MODEL_DISCOVERY, type ConfigurationRequestView, type ModelApiProtocol } from "@sciencediscovery/schema";

type Presentation = { kind: "settings" } | { kind: "unsupported" };
const capabilities = new Set(["provider.connection", "provider.credential", "provider.remove_credential", "model.api_identity", "model.metadata"]);
/** A link opens the existing page only. It never transfers a request, writes a
 * value, confirms a destination, or claims that the pending request was applied. */
export function providerCardPresentation(request: ConfigurationRequestView): Presentation | undefined {
  if (!capabilities.has(request.capabilityId)) return undefined;
  const unsupported: Presentation = { kind: "unsupported" };
  if (request.scope.kind !== "global" || request.schemaVersion !== 1 || request.adapterVersion !== 1 || request.autoApplyAt
    || new Set(request.fields.map(field => field.id)).size !== request.fields.length) return unsupported;
  const target = (id: string) => {
    const field = request.fields.find(item => item.id === id);
    return field?.kind === "enum" && typeof field.value === "string" && field.value
      ? field.choices?.find(choice => choice.id === field.value) : undefined;
  };
  if (request.capabilityId.startsWith("provider.")) {
    if (!target("providerId")) return unsupported;
    const kinds: Record<string, string> = request.capabilityId === "provider.credential"
      ? { providerId: "enum", apiToken: "credential" }
      : request.capabilityId === "provider.remove_credential" ? { providerId: "enum" }
        : { providerId: "enum", name: "text", baseUrl: "url", apiProtocol: "enum", apiVariant: "enum", modelDiscovery: "enum" };
    if (request.fields.some(field => kinds[field.id] !== field.kind)) return unsupported;
    if (request.capabilityId === "provider.connection") {
      if (request.changes.some(change => !["name", "baseUrl", "apiProtocol", "apiVariant", "modelDiscovery"].includes(change.field))) return unsupported;
      if (request.changes.some(change => change.field === "modelDiscovery")) {
        const protocol = request.fields.find(field => field.id === "apiProtocol");
        const discovery = request.fields.find(field => field.id === "modelDiscovery");
        // The original page changes discovery only with its protocol picker.
        if (!request.changes.some(change => change.field === "apiProtocol") || protocol?.kind !== "enum"
          || typeof protocol.value !== "string" || !Object.hasOwn(DEFAULT_MODEL_DISCOVERY, protocol.value)
          || discovery?.kind !== "enum" || discovery.value !== DEFAULT_MODEL_DISCOVERY[protocol.value as ModelApiProtocol]) return unsupported;
      }
    }
    return { kind: "settings" };
  }
  // Existing model settings have no metadata or API identity editor.
  // Historical requests must never fall back to an editable generic form.
  return unsupported;
}
