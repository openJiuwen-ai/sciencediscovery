// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationAdapter, ConfigurationAdapterContext, ConfigurationPlan } from "./types.js";
import { classifyEndpointAddress } from "./model-destination.js";
import { ConfigurationError, digest, invalid, object } from "./validation.js";
type Settings = ReturnType<SessionStore["getMemoryGraphSettings"]>;

function origin(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8192) invalid("Enter a Neo4j HTTP(S) root origin", "neo4jHttp");
  let url: URL;
  try { url = new URL(value.trim()); } catch { return invalid("Enter a valid Neo4j HTTP(S) root origin", "neo4jHttp"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    invalid("Use a root HTTP(S) origin without embedded credentials, path, query or fragment", "neo4jHttp");
  return url.origin;
}
function username(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) invalid("Enter a non-empty Neo4j username without control characters", "neo4jUser");
  return value.trim();
}
/** Invalid legacy URLs never become ordinary model/form values. */
export function memoryConnectionMetadata(settings: Settings) {
  let httpOrigin: string | null = null, neo4jUser: string | null = null;
  try { httpOrigin = origin(settings.neo4jHttp); } catch { /* Require explicit supported input. */ }
  try { neo4jUser = username(settings.neo4jUser); } catch { /* Require explicit supported input. */ }
  return { enabled: settings.enabled, backend: settings.backend, httpOrigin, neo4jUser, hasPassword: settings.hasNeo4jPassword };
}
function resolve(input: ConfigurationValues, settings: Settings) {
  const safe = memoryConnectionMetadata(settings);
  return { origin: typeof input.neo4jHttp === "string" ? input.neo4jHttp : safe.httpOrigin ?? "",
    user: typeof input.neo4jUser === "string" ? input.neo4jUser : safe.neo4jUser ?? "" };
}
function destination(candidate: { origin: string; user: string }): NonNullable<ConfigurationPlan["endpointAuthorization"]> {
  const url = new URL(origin(candidate.origin));
  return { endpointTarget: JSON.stringify(["neo4j-http", "neo4j", url.origin, "/db/neo4j/tx", digest(candidate.user)]), host: url.host,
    classification: classifyEndpointAddress(url) };
}

export function createMemoryConnectionAdapter(store: SessionStore, assertConsent: (context: ConfigurationAdapterContext) => void): ConfigurationAdapter {
  const target = (input: ConfigurationValues) => {
    const current = store.getMemoryGraphSettings();
    return digest(["memory.connection", resolve(input, current), current.hasNeo4jPassword]);
  };
  const assertCurrent = (context: ConfigurationAdapterContext) => {
    const candidate = resolve(context.input, store.getMemoryGraphSettings());
    if (context.plan.data?.credentialTarget !== target(context.input) || !candidate.origin || !candidate.user
      || context.plan.endpointAuthorization?.endpointTarget !== destination(candidate).endpointTarget)
      throw new ConfigurationError("STALE_ENDPOINT_CONSENT", "Review the current Neo4j connection and its credential-reuse impact", 409);
    assertConsent(context);
  };
  return {
    id: "memory.connection", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    normalize: (raw): ConfigurationValues => {
      const input = object(raw, ["neo4jHttp", "neo4jUser"], "values");
      return { ...(input.neo4jHttp !== undefined ? { neo4jHttp: origin(input.neo4jHttp) } : {}),
        ...(input.neo4jUser !== undefined ? { neo4jUser: username(input.neo4jUser) } : {}) };
    }, target,
    preview: (input, snapshot) => {
      const settings = snapshot.data.memoryConnectionSettings as Settings, safe = memoryConnectionMetadata(settings), candidate = resolve(input, settings);
      const endpoint = candidate.origin && candidate.user ? destination(candidate) : undefined;
      if (endpoint?.classification === "public_http")
        throw new ConfigurationError("ENDPOINT_CREDENTIAL_INSECURE", "Use HTTPS for public Neo4j origins. HTTP is supported on loopback or private networks.", 400, "neo4jHttp");
      const changes = [];
      if (input.neo4jHttp !== undefined && candidate.origin !== safe.httpOrigin) changes.push({ field: "neo4jHttp", before: safe.httpOrigin ?? "Unreviewed legacy connection", after: candidate.origin });
      if (input.neo4jUser !== undefined && candidate.user !== safe.neo4jUser) changes.push({ field: "neo4jUser", before: safe.neo4jUser ?? "Unreviewed account", after: candidate.user });
      return { fields: [{ id: "neo4jHttp", label: "Neo4j HTTP origin", kind: "url", required: true, value: candidate.origin,
        description: "Use an HTTPS root origin for public Neo4j. Loopback and private networks may use HTTP. Omit passwords, paths, queries and fragments." },
        { id: "neo4jUser", label: "Neo4j username", kind: "text", required: true, value: candidate.user }], changes,
        impact: { resourceLocation: "Deployment MemoryGraph connection settings", effectiveScope: "Every session using this Neo4j backend",
          message: `Separate destination approval and manual save required. ${settings.hasNeo4jPassword ? "A password is already stored and may be reused at the new recipient." : "No password is stored; future credentials may use the new recipient."} Existing research context may later go to this destination. Participation (${settings.enabled ? "enabled" : "disabled"}), backend (${settings.backend}), password ciphertext and graph data are unchanged. The settings writer performs no password replacement, probe, migration, installation or restart. A bound original configuration wait may continue through the framework; activation timing and execution permissions remain separate. Existing degraded settings refresh/startup may synchronize this choice; a healthy old client may remain at its old destination until consistent operator restart of API/MemoryGraph. Saving is not verified mirroring or authentication.` },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "requires_restart",
        disposition: !Object.keys(input).length ? "missing_input" : changes.length ? "change" : "no_change", ready: Boolean(candidate.origin && candidate.user && changes.length),
        data: { credentialTarget: target(input) }, ...(endpoint ? { endpointAuthorization: endpoint } : {}) };
    },
    verify: async context => { assertCurrent(context); return { ok: true }; },
    apply: context => {
      assertCurrent(context);
      store.applyMemoryConnectionConfigurationSync({ ...(typeof context.input.neo4jHttp === "string" ? { neo4jHttp: context.input.neo4jHttp } : {}),
        ...(typeof context.input.neo4jUser === "string" ? { neo4jUser: context.input.neo4jUser } : {}) });
      return { resourceRevision: digest(store.configurationSnapshot(context.sessionId, "memory.connection", target(context.input)).resourceVersions),
        summary: "Neo4j connection stored; sidecar mirror, authentication and consistent restart remain unverified" };
    },
  };
}
