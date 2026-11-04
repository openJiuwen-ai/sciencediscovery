// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationCredentialBridge } from "./credential-bridge.js";
import type { ConfigurationAdapter, ConfigurationAdapterContext, ConfigurationPlan } from "./types.js";
import { classifyEndpointAddress } from "./model-destination.js";
import { ConfigurationError, digest, invalid, object } from "./validation.js";

type Settings = ReturnType<SessionStore["getMemoryGraphSettings"]>;
/** No network/DNS work. Custom paths and legacy embedded secrets require the formal connection editor. */
function destination(settings: Settings): NonNullable<ConfigurationPlan["endpointAuthorization"]> {
  let url: URL;
  try { url = new URL(settings.neo4jHttp); }
  catch { throw new ConfigurationError("CONFIGURATION_MEMORY_TARGET_UNAVAILABLE", "Review the saved Neo4j HTTP connection before entering a password", 409); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new ConfigurationError("CONFIGURATION_MEMORY_TARGET_UNAVAILABLE", "Use the formal connection editor to select a root HTTP(S) origin without embedded credentials, query or fragment", 409);
  return { endpointTarget: JSON.stringify(["neo4j-http", "neo4j", url.origin, "/db/neo4j/tx", digest(settings.neo4jUser)]), host: url.host,
    classification: classifyEndpointAddress(url) };
}

export function createMemoryCredentialAdapter(store: SessionStore, credentials: ConfigurationCredentialBridge,
  assertConsent: (context: ConfigurationAdapterContext) => void): ConfigurationAdapter {
  // The target changes with the saved connection/account, so the framework clears
  // old drafts/consent rather than rebinding them across a formal target edit.
  const target = (input: ConfigurationValues) => {
    const settings = store.getMemoryGraphSettings();
    return digest(["memory.credential", input.operation ?? "replace", settings.neo4jHttp, settings.neo4jUser]);
  };
  const current = (context: ConfigurationAdapterContext) => {
    if (context.plan.data?.credentialTarget !== target(context.input))
      throw new ConfigurationError("STALE_ENDPOINT_CONSENT", "The saved Neo4j connection changed. Refresh its destination and enter the password again", 409);
    if (context.input.operation !== "clear") {
      if (context.plan.endpointAuthorization?.endpointTarget !== destination(store.getMemoryGraphSettings()).endpointTarget)
        throw new ConfigurationError("STALE_ENDPOINT_CONSENT", "Review the current Neo4j destination", 409);
      assertConsent(context);
    }
  };
  const binding = (context: ConfigurationAdapterContext) => ({ sessionId: context.sessionId, requestId: context.requestId,
    revision: context.revision, target: String(context.plan.data?.credentialTarget), fieldId: "apiToken", normalization: "exact" as const });
  return {
    id: "memory.credential", version: 2, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    fieldPolicy: { credentialFields: ["apiToken"], credentialNormalization: "exact" },
    normalize: (raw): ConfigurationValues => {
      const input = object(raw, ["operation"], "values");
      if (input.operation === undefined) return {};
      if (input.operation !== "replace" && input.operation !== "clear") invalid("Choose replace or clear", "operation");
      return { operation: input.operation };
    },
    target,
    preview: (input, snapshot) => {
      const settings = snapshot.data.memoryCredentialSettings as Settings, operation = input.operation === "clear" ? "clear" : "replace";
      const changed = operation === "replace" || settings.hasNeo4jPassword;
      return { fields: [{ id: "operation", label: "Password operation", kind: "enum", required: true, value: operation,
        choices: [{ id: "replace", label: "Replace stored password" }, { id: "clear", label: "Clear stored password" }] },
        ...(operation === "replace" ? [{ id: "apiToken", label: "Neo4j password", kind: "credential" as const, required: true, status: "missing" as const }] : [])],
        changes: changed ? [{ field: "neo4jPassword", before: settings.hasNeo4jPassword ? "Configured (write-only)" : "Not configured",
          after: operation === "clear" ? "Clear stored password; runtime copy requires restart" : "Replace via secure user input; authentication unverified" }] : [],
        impact: { resourceLocation: "Shared encrypted MemoryGraph credential store", effectiveScope: "Every session using the configured Neo4j backend",
          message: `Manual confirmation required. Existing participation (${settings.enabled ? "enabled" : "disabled"}), backend (${settings.backend}), connection/account and graph data stay unchanged. Replacement also needs separate approval of the configured Neo4j origin/account and transaction path. This save does not send its own probe. Existing settings refresh/startup may forward the saved credential and perform backend health checks; authentication and runtime mirroring are not verified here. Clearing removes only the stored password: a sidecar runtime copy or in-flight request may continue until an operator consistently restarts API/MemoryGraph. The settings writer performs no restart, migration or installation. A bound original configuration wait may continue through the framework; activation timing and execution permissions remain separate.` },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "requires_restart",
        disposition: input.operation === undefined ? "missing_input" : changed ? "change" : "no_change", ready: input.operation !== undefined && changed,
        data: { credentialTarget: target(input) }, ...(operation === "replace" ? { endpointAuthorization: destination(settings) } : {}) };
    },
    verify: async context => {
      current(context);
      if (context.input.operation === "clear") return { ok: true };
      if (!context.credentialHandle) return { ok: false, code: "CONFIGURATION_CREDENTIAL_REQUIRED", field: "apiToken", message: "Enter the Neo4j password in the secure user field" };
      return credentials.withLease(context.credentialHandle, binding(context), async secret => {
        if (!secret.trim() || secret.length > 16384) invalid("Enter a non-empty Neo4j password", "apiToken");
        return { ok: true };
      });
    },
    apply: context => {
      current(context); let password: string | null = null;
      if (context.input.operation !== "clear") {
        if (!context.credentialHandle) throw new ConfigurationError("CONFIGURATION_CREDENTIAL_REQUIRED", "The isolated password draft is missing", 409, "apiToken");
        password = credentials.read(context.credentialHandle, binding(context));
        if (!password.trim()) invalid("Enter a non-empty Neo4j password", "apiToken");
      }
      store.applyMemoryCredentialConfigurationSync(password);
      return { resourceRevision: digest(store.configurationSnapshot(context.sessionId, "memory.credential", target(context.input)).resourceVersions),
        summary: "Stored Neo4j password updated; runtime mirror, authentication and revocation remain unverified" };
    },
  };
}
