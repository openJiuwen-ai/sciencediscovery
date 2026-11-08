// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { configurationNeedsSecurityConsent, type ConfigurationSecurityConsent } from "@sciencediscovery/schema";
import type { DatabaseSync } from "node:sqlite";
import type { ConfigurationRecord } from "./types.js";
import { ConfigurationError, integer, object, string } from "./validation.js";

export { configurationNeedsSecurityConsent };

/** A user-only policy acknowledgement, independent of ordinary configuration and tool permission. */
export class ConfigurationSecurityAuthorizer {
  constructor(private readonly database: DatabaseSync) {
    // Retain acknowledgements with the Session for audit, even after a request
    // expires or is dismissed. Session deletion removes the audit rows.
    database.exec(`CREATE TABLE IF NOT EXISTS configuration_security_consents (
      request_id TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL,
      target_digest TEXT NOT NULL, confirmed_at TEXT NOT NULL,
      PRIMARY KEY(request_id,session_id,revision,target_digest))`);
  }
  view(record: ConfigurationRecord): ConfigurationSecurityConsent | undefined {
    const consent = record.plan.securityConsent;
    if (!consent) return undefined;
    const confirmed = this.database.prepare("SELECT 1 FROM configuration_security_consents WHERE request_id=? AND session_id=? AND revision=? AND target_digest=?")
      .get(record.view.id, record.view.sessionId, record.view.revision, consent.targetDigest);
    return { ...consent, revision: record.view.revision, status: confirmed ? "confirmed" : "required" };
  }
  assert(record: ConfigurationRecord, source = record.view.decisionSource): void {
    if (!configurationNeedsSecurityConsent(record.view.capabilityId)) return;
    if (this.view(record)?.status !== "confirmed") throw new ConfigurationError("SECURITY_CONSENT_REQUIRED", "Independently confirm the exact security policy before applying it", 409);
    if (source !== "user") throw new ConfigurationError("SECURITY_MANUAL_CONFIRMATION_REQUIRED", "Security policy changes require a separate human decision", 409);
  }
  confirm(record: ConfigurationRecord, raw: unknown): void {
    const input = object(raw, ["revision", "targetDigest", "acknowledged"], "securityConsent");
    integer(input.revision, "revision"); string(input.targetDigest, "targetDigest", 100);
    if (input.acknowledged !== true) throw new ConfigurationError("SECURITY_CONSENT_REQUIRED", "Read and explicitly acknowledge the security policy impact", 409);
    const view = this.view(record);
    if (!view || !record.plan.ready || record.view.state !== "awaiting_confirmation" || view.revision !== input.revision || view.targetDigest !== input.targetDigest)
      throw new ConfigurationError("STALE_SECURITY_CONSENT", "Review the current security policy preview before confirming", 409);
    this.database.prepare("INSERT OR IGNORE INTO configuration_security_consents(request_id,session_id,revision,target_digest,confirmed_at) VALUES(?,?,?,?,?)")
      .run(record.view.id, record.view.sessionId, record.view.revision, view.targetDigest, new Date().toISOString());
  }
  rebind(record: ConfigurationRecord, nextRevision: number): void {
    const digest = record.plan.securityConsent?.targetDigest;
    if (!digest) return;
    // Only copy this exact old target. A changed plan/CAS vector produces a different digest.
    this.database.prepare(`INSERT OR IGNORE INTO configuration_security_consents(request_id,session_id,revision,target_digest,confirmed_at)
      SELECT request_id,session_id,?,target_digest,confirmed_at FROM configuration_security_consents
      WHERE request_id=? AND session_id=? AND revision=? AND target_digest=?`)
      .run(nextRevision, record.view.id, record.view.sessionId, record.view.revision, digest);
  }
}
