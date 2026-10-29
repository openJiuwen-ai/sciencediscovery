// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createModelRequest } from "@sciencediscovery/model";
import { DEFAULT_MODEL_API_VARIANT, type ConfigurationEndpointAuthorization, type ModelProfile } from "@sciencediscovery/schema";
import type { DatabaseSync } from "node:sqlite";
import { ConfigurationError, object, integer, string } from "./validation.js";
import type { ConfigurationRecord, ConfigurationPlan, ConfigurationAdapterContext } from "./types.js";

type Destination = NonNullable<ConfigurationPlan["endpointAuthorization"]>;
/** Exact protocol and wire URL, never a provider's user-editable display name. */
export function modelDestination(profile: Pick<ModelProfile, "baseUrl" | "model" | "apiProtocol" | "apiVariant">): Destination {
  let base: URL;
  try { base = new URL(profile.baseUrl); }
  catch { throw new ConfigurationError("INVALID_CONFIGURATION_URL", "Use a valid HTTP or HTTPS endpoint", 400, "baseUrl"); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new ConfigurationError("INVALID_CONFIGURATION_URL", "Use an endpoint without credentials, query or fragment", 400, "baseUrl");
  const protocol = profile.apiProtocol ?? (profile.baseUrl.includes("/api/plan") ? "anthropic-messages" : "openai-chat-completions");
  const variant = profile.apiVariant ?? DEFAULT_MODEL_API_VARIANT[protocol];
  const request = createModelRequest({ ...profile, apiProtocol: protocol, apiVariant: variant, thinkingMode: "disabled" }, "Connectivity check", [{ role: "user", content: "Reply OK" }], [], { maxTokens: 16, maxRetries: 0, requestTimeoutMs: 10000 }, false);
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const octets = host.split(".").map(Number);
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host) && octets.every(value => value >= 0 && value <= 255);
  const loopback = host === "localhost" || host.endsWith(".localhost") || host === "::1" || ipv4 && octets[0] === 127 || /^::ffff:7f[0-9a-f]{2}:/i.test(host);
  const privateNetwork = ipv4 && (octets[0] === 10 || octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31 || octets[0] === 192 && octets[1] === 168 || octets[0] === 169 && octets[1] === 254 || octets[0] === 0)
    || /^(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(host);
  const trusted = url.protocol === "https:" && (
    protocol === "openai-chat-completions" && variant === "openai" && url.href === "https://api.openai.com/v1/chat/completions"
    || protocol === "openai-responses" && variant === "responses" && url.href === "https://api.openai.com/v1/responses"
    || protocol === "anthropic-messages" && ["anthropic", "anthropic-legacy"].includes(variant) && url.href === "https://api.anthropic.com/v1/messages");
  return { endpointTarget: JSON.stringify([protocol, variant, url.href]), host: url.host,
    classification: trusted ? "trusted_preset" : loopback ? "loopback" : privateNetwork ? "private_network" : url.protocol === "https:" ? "public_https" : "public_http" };
}

/** User-only authorizations are separate from Agent proposal inputs and bind
 * exact request/revision/destination. No token is stored in this journal. */
export class ModelDestinationAuthorizer {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS configuration_endpoint_consents (
      request_id TEXT NOT NULL, revision INTEGER NOT NULL, endpoint_target TEXT NOT NULL,
      session_id TEXT NOT NULL, confirmed_at TEXT NOT NULL,
      PRIMARY KEY(request_id,revision,endpoint_target))`);
  }
  view(record: ConfigurationRecord): ConfigurationEndpointAuthorization | undefined {
    const destination = record.plan.endpointAuthorization;
    if (!destination) return undefined;
    const confirmed = this.database.prepare("SELECT 1 FROM configuration_endpoint_consents WHERE request_id=? AND revision=? AND endpoint_target=? AND session_id=?")
      .get(record.view.id, record.view.revision, destination.endpointTarget, record.view.sessionId);
    const blocked = destination.classification === "public_http" && record.input.tokenOptional !== true;
    return { ...destination, revision: record.view.revision, status: blocked ? "blocked" : destination.classification === "trusted_preset" ? "trusted" : confirmed ? "confirmed" : "required" };
  }
  assert(record: ConfigurationRecord, credential: boolean): void {
    const view = this.view(record);
    if (!view) {
      if (["model.connect", "model.repair_credential"].includes(record.view.capabilityId)) throw new ConfigurationError("ENDPOINT_CONSENT_REQUIRED", "Prepare a valid destination preview before supplying a credential", 409, "baseUrl");
      return;
    }
    if (view.classification === "public_http" && credential) throw new ConfigurationError("ENDPOINT_CREDENTIAL_INSECURE", "Remote plaintext HTTP cannot receive an API key", 400, "baseUrl");
    if (!["confirmed", "trusted"].includes(view.status)) throw new ConfigurationError("ENDPOINT_CONSENT_REQUIRED", "Confirm the exact destination in the dedicated endpoint control before supplying a credential or sending a probe", 409, "baseUrl");
  }
  assertContext(context: ConfigurationAdapterContext, profile: ModelProfile, credential: boolean): void {
    if (!context.plan.endpointAuthorization || modelDestination(profile).endpointTarget !== context.plan.endpointAuthorization.endpointTarget)
      throw new ConfigurationError("STALE_ENDPOINT_CONSENT", "The model destination changed; review and confirm a new preview", 409, "baseUrl");
    this.assert({ input: context.input, plan: context.plan, view: { id: context.requestId, sessionId: context.sessionId, revision: context.revision } } as ConfigurationRecord, credential);
  }
  confirm(record: ConfigurationRecord, input: unknown): void {
    const body = object(input, ["revision", "endpointTarget"], "endpointConsent");
    integer(body.revision, "revision"); string(body.endpointTarget, "endpointTarget", 4096);
    const destination = this.view(record);
    if (!destination || record.view.revision !== body.revision || destination.endpointTarget !== body.endpointTarget) throw new ConfigurationError("STALE_ENDPOINT_CONSENT", "Review the current destination before confirming", 409);
    if (!["collecting_input", "awaiting_confirmation", "needs_fix", "failed"].includes(record.view.state)) throw new ConfigurationError("STALE_CONFIGURATION_PREVIEW", "This request cannot accept destination consent", 409);
    if (destination.status === "blocked") throw new ConfigurationError("ENDPOINT_CREDENTIAL_INSECURE", "Remote plaintext HTTP cannot receive an API key", 400, "baseUrl");
    this.database.prepare("INSERT OR IGNORE INTO configuration_endpoint_consents(request_id,revision,endpoint_target,session_id,confirmed_at) VALUES(?,?,?,?,?)")
      .run(record.view.id, record.view.revision, destination.endpointTarget, record.view.sessionId, new Date().toISOString());
  }
  rebind(requestId: string, sessionId: string, from: number, to: number, destination: string): void {
    this.database.prepare(`INSERT OR IGNORE INTO configuration_endpoint_consents(request_id,revision,endpoint_target,session_id,confirmed_at)
      SELECT request_id,?,endpoint_target,session_id,confirmed_at FROM configuration_endpoint_consents
      WHERE request_id=? AND session_id=? AND revision=? AND endpoint_target=?`).run(to, requestId, sessionId, from, destination);
  }
}
