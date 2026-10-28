// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface ConfigurationCredentialBinding {
  sessionId: string;
  requestId: string;
  revision: number;
  target: string;
  fieldId: string;
}
interface DraftRow { ciphertext: string; expires_at: number; lease_until: number; lease_id: string | null; revoked: number; }
const TTL = 30 * 60_000;
const LEASE = 20_000;

/** Isolated encrypted drafts. Formal credentials remain in the existing model store. */
export class ConfigurationCredentialBridge {
  constructor(
    private readonly database: DatabaseSync,
    private readonly cipher: { encrypt(id: string, secret: string): string; decrypt(id: string, ciphertext: string): string },
    private readonly now: () => number = Date.now,
  ) {
    database.exec(`CREATE TABLE IF NOT EXISTS configuration_credential_drafts (
      handle TEXT PRIMARY KEY, session_id TEXT NOT NULL, request_id TEXT NOT NULL,
      revision INTEGER NOT NULL, target TEXT NOT NULL, field_id TEXT NOT NULL,
      ciphertext TEXT NOT NULL, expires_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
      lease_id TEXT, revoked INTEGER NOT NULL DEFAULT 0
    )`);
    // Additive migration for drafts created by the first development version.
    const columns = new Set((database.prepare("PRAGMA table_info(configuration_credential_drafts)").all() as unknown as Array<{ name: string }>).map(row => row.name));
    if (!columns.has("lease_id")) database.exec("ALTER TABLE configuration_credential_drafts ADD COLUMN lease_id TEXT");
    if (!columns.has("revoked")) database.exec("ALTER TABLE configuration_credential_drafts ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0");
    database.exec(`CREATE TABLE IF NOT EXISTS configuration_credential_uploads (
      request_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, session_id TEXT NOT NULL,
      payload_ciphertext TEXT NOT NULL, response_json TEXT NOT NULL,
      PRIMARY KEY(request_id,idempotency_key)
    )`);
  }
  private transaction<T>(action: () => T): T {
    if (this.database.isTransaction) return action();
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  private binding(binding: ConfigurationCredentialBinding): void {
    if (!binding || typeof binding !== "object" || binding.fieldId !== "apiToken" || !Number.isSafeInteger(binding.revision) || binding.revision < 1 ||
      [binding.sessionId, binding.requestId, binding.target].some(value => typeof value !== "string" || !value || value.length > 4096)) throw new Error("INVALID_CONFIGURATION_CREDENTIAL");
  }
  provide(binding: ConfigurationCredentialBinding, secret: unknown, key?: string): { handle: string; expiresAt: string } {
    this.binding(binding);
    if (typeof secret !== "string" || !secret.trim() || secret.length > 16_384) throw new Error("INVALID_CONFIGURATION_CREDENTIAL");
    if (key !== undefined && (typeof key !== "string" || !key || key.length > 200)) throw new Error("INVALID_IDEMPOTENCY_KEY");
    const payload = JSON.stringify({ sessionId: binding.sessionId, requestId: binding.requestId, revision: binding.revision,
      target: binding.target, fieldId: binding.fieldId, secret: secret.trim() });
    const idempotencyContext = `configuration-upload:${binding.requestId}:${key ?? ""}`;
    return this.transaction(() => {
      if (key) {
        const previous = this.database.prepare("SELECT session_id,payload_ciphertext,response_json FROM configuration_credential_uploads WHERE request_id=? AND idempotency_key=?")
          .get(binding.requestId, key) as { session_id: string; payload_ciphertext: string; response_json: string } | undefined;
        if (previous) {
          if (previous.session_id !== binding.sessionId || this.cipher.decrypt(idempotencyContext, previous.payload_ciphertext) !== payload) throw new Error("IDEMPOTENCY_MISMATCH");
          const response = JSON.parse(previous.response_json) as { handle: string; expiresAt: string };
          // Replacing, clearing or consuming a draft must also invalidate an old upload replay.
          this.row(response.handle, binding);
          return response;
        }
      }
      const handle = randomUUID(); const timestamp = this.now(); const expiresAt = timestamp + TTL;
      // Encrypt before modifying any previous draft. The surrounding transaction
      // also protects standalone callers from a failed upload/idempotency insert.
      const ciphertext = this.cipher.encrypt(`configuration-draft:${handle}`, secret.trim());
      this.database.prepare("UPDATE configuration_credential_drafts SET revoked=1 WHERE session_id=? AND request_id=? AND field_id=?")
        .run(binding.sessionId, binding.requestId, binding.fieldId);
      this.database.prepare("DELETE FROM configuration_credential_drafts WHERE session_id=? AND request_id=? AND field_id=? AND lease_until<=?")
        .run(binding.sessionId, binding.requestId, binding.fieldId, timestamp);
      this.database.prepare(`INSERT INTO configuration_credential_drafts
        (handle,session_id,request_id,revision,target,field_id,ciphertext,expires_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(handle, binding.sessionId, binding.requestId, binding.revision, binding.target, binding.fieldId, ciphertext, expiresAt);
      const response = { handle, expiresAt: new Date(expiresAt).toISOString() };
      if (key) this.database.prepare("INSERT INTO configuration_credential_uploads(request_id,idempotency_key,session_id,payload_ciphertext,response_json) VALUES(?,?,?,?,?)")
        .run(binding.requestId, key, binding.sessionId, this.cipher.encrypt(idempotencyContext, payload), JSON.stringify(response));
      return response;
    });
  }
  private row(handle: string, binding: ConfigurationCredentialBinding): DraftRow {
    this.binding(binding);
    if (typeof handle !== "string" || handle.length > 200) throw new Error("CREDENTIAL_DRAFT_EXPIRED");
    const row = this.database.prepare(`SELECT ciphertext,expires_at,lease_until,lease_id,revoked FROM configuration_credential_drafts
      WHERE handle=? AND session_id=? AND request_id=? AND revision=? AND target=? AND field_id=?`)
      .get(handle, binding.sessionId, binding.requestId, binding.revision, binding.target, binding.fieldId) as DraftRow | undefined;
    if (!row || row.revoked || row.expires_at <= this.now()) throw new Error("CREDENTIAL_DRAFT_EXPIRED");
    return row;
  }
  read(handle: string, binding: ConfigurationCredentialBinding): string {
    return this.cipher.decrypt(`configuration-draft:${handle}`, this.row(handle, binding).ciphertext);
  }
  /** A revision may move forward only for the exact same endpoint and field. */
  rebind(handle: string, binding: ConfigurationCredentialBinding, revision: number): void {
    this.binding(binding);
    if (!Number.isSafeInteger(revision) || revision < binding.revision || revision > binding.revision + 1) throw new Error("STALE_CONFIGURATION_CREDENTIAL");
    if (revision === binding.revision) { this.row(handle, binding); return; }
    const alreadyBound = this.database.prepare("SELECT 1 FROM configuration_credential_drafts WHERE handle=? AND session_id=? AND request_id=? AND revision=? AND target=? AND field_id=? AND expires_at>? AND revoked=0")
      .get(handle, binding.sessionId, binding.requestId, revision, binding.target, binding.fieldId, this.now());
    if (alreadyBound) return;
    const current = this.row(handle, binding);
    if (current.lease_until > this.now()) throw new Error("CREDENTIAL_DRAFT_BUSY");
    const changed = this.database.prepare("UPDATE configuration_credential_drafts SET revision=? WHERE handle=? AND revision=? AND revoked=0 AND lease_until<=?")
      .run(revision, handle, binding.revision, this.now());
    if (changed.changes !== 1) throw new Error("STALE_CONFIGURATION_CREDENTIAL");
  }
  hasDraft(requestId: string, revision: number, target: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM configuration_credential_drafts
      WHERE request_id=? AND revision=? AND target=? AND expires_at>? AND revoked=0 LIMIT 1`)
      .get(requestId, revision, target, this.now()));
  }
  async withLease<T>(handle: string, binding: ConfigurationCredentialBinding, action: (secret: string) => Promise<T>): Promise<T> {
    const row = this.row(handle, binding); const timestamp = this.now(); const leaseId = randomUUID();
    const claimed = this.database.prepare("UPDATE configuration_credential_drafts SET lease_until=?,lease_id=? WHERE handle=? AND lease_until<=? AND revoked=0 AND expires_at>?")
      .run(timestamp + LEASE, leaseId, handle, timestamp, timestamp);
    if (claimed.changes !== 1) throw new Error("CREDENTIAL_DRAFT_BUSY");
    try { return await action(this.cipher.decrypt(`configuration-draft:${handle}`, row.ciphertext)); }
    finally {
      // An old callback cannot release a later lease after its own lease expired.
      this.database.prepare("UPDATE configuration_credential_drafts SET lease_until=0,lease_id=NULL WHERE handle=? AND lease_id=?").run(handle, leaseId);
      this.database.prepare("DELETE FROM configuration_credential_drafts WHERE handle=? AND lease_until<=? AND (revoked=1 OR expires_at<=?)").run(handle, this.now(), this.now());
    }
  }
  clearRequest(requestId: string): void {
    this.transaction(() => {
      this.database.prepare("UPDATE configuration_credential_drafts SET revoked=1 WHERE request_id=?").run(requestId);
      this.database.prepare("DELETE FROM configuration_credential_drafts WHERE request_id=? AND lease_until<=?").run(requestId, this.now());
      this.database.prepare("DELETE FROM configuration_credential_uploads WHERE request_id=?").run(requestId);
    });
  }
  /** Discard only the stale implicit draft; a concurrently uploaded replacement
   * for this request must remain usable through its explicit handle. */
  clearDraft(handle: string, binding: ConfigurationCredentialBinding): void {
    this.binding(binding);
    this.transaction(() => {
      this.database.prepare("UPDATE configuration_credential_drafts SET revoked=1 WHERE handle=? AND session_id=? AND request_id=? AND revision=? AND target=? AND field_id=?")
        .run(handle, binding.sessionId, binding.requestId, binding.revision, binding.target, binding.fieldId);
      this.database.prepare("DELETE FROM configuration_credential_drafts WHERE handle=? AND session_id=? AND request_id=? AND revoked=1 AND lease_until<=?")
        .run(handle, binding.sessionId, binding.requestId, this.now());
      this.database.prepare("DELETE FROM configuration_credential_uploads WHERE request_id=? AND session_id=? AND json_extract(response_json,'$.handle')=?")
        .run(binding.requestId, binding.sessionId, handle);
    });
  }
  clearSession(sessionId: string): void {
    this.transaction(() => {
      this.database.prepare("UPDATE configuration_credential_drafts SET revoked=1 WHERE session_id=?").run(sessionId);
      this.database.prepare("DELETE FROM configuration_credential_drafts WHERE session_id=? AND lease_until<=?").run(sessionId, this.now());
      this.database.prepare("DELETE FROM configuration_credential_uploads WHERE session_id=?").run(sessionId);
    });
  }
  sweep(): void {
    const now = this.now();
    this.transaction(() => {
      this.database.prepare("DELETE FROM configuration_credential_drafts WHERE (expires_at<=? OR revoked=1) AND lease_until<=?").run(now, now);
      this.database.prepare("DELETE FROM configuration_credential_uploads WHERE json_extract(response_json,'$.expiresAt')<=?").run(new Date(now).toISOString());
    });
  }
}
