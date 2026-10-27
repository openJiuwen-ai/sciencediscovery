// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { assertBackendReceipt, BackendDispatchNotAuthorizedError, type BackendControl, type BackendWriteOperation, type BackendWriteReceipt } from "./backend-control.js";
import { requireExternalControl } from "./backend-capabilities.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

export interface ExternalOperationRecord {
  operation: BackendWriteOperation;
  state: "prepared" | "sending" | "external_unknown" | "applied" | "rejected" | "suppressed";
  receipt?: BackendWriteReceipt;
  errorCode?: string;
}
/** Each callback is durable; claim serializes workers and mutations at the host's cancellation boundary. */
export interface ExternalOperationJournal {
  claim(operationId: string): Promise<ExternalOperationRecord | undefined>;
  save(record: ExternalOperationRecord): Promise<void>;
  release(operationId: string): Promise<void>;
  isAuthorized(operation: BackendWriteOperation): Promise<boolean>;
  recordApplied(record: ExternalOperationRecord & { receipt: BackendWriteReceipt }): Promise<void>;
}

/** CFG-T24: after a crash/timeout in sending, only query. An unknown outcome never becomes a new write. */
export class ConfigurationOperationWorker {
  constructor(private readonly backend: BackendControl, private readonly journal: ExternalOperationJournal) {}
  async process(operationId: string): Promise<ExternalOperationRecord | undefined> {
    const record = await this.journal.claim(operationId);
    if (!record) return undefined;
    try {
      if (["applied", "rejected", "suppressed"].includes(record.state)) return record;
      const operation = record.operation;
      const recovery = record.state !== "prepared";
      if (!recovery && !await this.journal.isAuthorized(operation)) {
        record.state = "suppressed"; await this.journal.save(record); return record;
      }
      const capabilities = await this.backend.inspect();
      if (capabilities.backendId !== operation.backendId) throw new Error("Backend identity mismatch");
      requireExternalControl(capabilities, operation.settingId, operation.scope);
      let result;
      try {
        if (recovery) result = await this.backend.queryOperation(operation);
        else {
          // Persist the uncertain boundary before issuing any network write.
          record.state = "sending"; await this.journal.save(record);
          if (!await this.journal.isAuthorized(operation)) {
            record.state = "suppressed"; await this.journal.save(record); return record;
          }
          result = await this.backend.submit(operation, { beforeDispatch: () => this.journal.isAuthorized(operation) });
        }
      } catch (error) {
        if (error instanceof BackendDispatchNotAuthorizedError) {
          record.state = "suppressed"; record.errorCode = "dispatch_not_authorized";
          await this.journal.save(record); return record;
        }
        record.state = "external_unknown"; record.errorCode = "backend_outcome_unknown";
        await this.journal.save(record); return record;
      }
      if (result.state === "applied") {
        assertBackendReceipt(operation, result.receipt);
        record.state = "applied"; record.receipt = result.receipt; delete record.errorCode;
        // The host records the saved fact even after Stop; activation/resume remain independently gated.
        await this.journal.recordApplied({ ...record, receipt: result.receipt });
      } else if (result.state === "rejected") {
        record.state = "rejected"; record.errorCode = result.code; await this.journal.save(record);
      } else if (result.state === "not_executed" && result.safeToRetry && recovery) {
        // The next scheduler attempt repeats authorization and keeps the exact operationId.
        record.state = "prepared"; delete record.errorCode; await this.journal.save(record);
      } else {
        record.state = "external_unknown"; record.errorCode = "backend_outcome_unknown"; await this.journal.save(record);
      }
      return record;
    } finally { await this.journal.release(operationId); }
  }
}

/** Durable single-host journal. Leases survive API crashes; sending resumes as query-only. */
export class SqliteExternalOperationJournal implements ExternalOperationJournal {
  private readonly leases = new Map<string, string>();
  constructor(private readonly options: {
    database: DatabaseSync;
    isAuthorized(operation: BackendWriteOperation): Promise<boolean>;
    /** Synchronous host domain commit on this same database/transaction. */
    commitApplied(record: ExternalOperationRecord & { receipt: BackendWriteReceipt }): void;
    now?: () => number;
    leaseMs?: number;
  }) {
    options.database.exec(`CREATE TABLE IF NOT EXISTS configuration_external_operations_v2 (
      operation_id TEXT PRIMARY KEY, backend_id TEXT NOT NULL, record_json TEXT NOT NULL,
      lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0
    )`);
  }
  prepare(operation: BackendWriteOperation): void {
    const previous = this.read(operation.operationId);
    if (previous) {
      if (!isDeepStrictEqual(previous.operation, operation)) throw new Error("External operation identity was reused with another plan");
      return;
    }
    const record: ExternalOperationRecord = { operation: structuredClone(operation), state: "prepared" };
    this.options.database.prepare("INSERT INTO configuration_external_operations_v2 (operation_id,backend_id,record_json) VALUES (?,?,?)")
      .run(operation.operationId, operation.backendId, JSON.stringify(record));
  }
  read(operationId: string): ExternalOperationRecord | undefined {
    const row = this.options.database.prepare("SELECT record_json FROM configuration_external_operations_v2 WHERE operation_id=?").get(operationId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as ExternalOperationRecord : undefined;
  }
  async claim(operationId: string): Promise<ExternalOperationRecord | undefined> {
    const now = (this.options.now ?? Date.now)();
    const token = randomUUID();
    const claimed = this.options.database.prepare("UPDATE configuration_external_operations_v2 SET lease_token=?,lease_until=? WHERE operation_id=? AND lease_until<=?")
      .run(token, now + (this.options.leaseMs ?? 60_000), operationId, now);
    if (claimed.changes !== 1) return undefined;
    this.leases.set(operationId, token);
    return this.read(operationId);
  }
  async save(record: ExternalOperationRecord): Promise<void> {
    this.assertImmutableOperation(record);
    const token = this.leases.get(record.operation.operationId);
    if (!token) throw new Error("External operation is not leased by this worker");
    const result = this.options.database.prepare("UPDATE configuration_external_operations_v2 SET record_json=? WHERE operation_id=? AND lease_token=? AND lease_until>?")
      .run(JSON.stringify(record), record.operation.operationId, token, (this.options.now ?? Date.now)());
    if (result.changes !== 1) throw new Error("External operation lease expired");
  }
  async release(operationId: string): Promise<void> {
    const token = this.leases.get(operationId);
    if (token) this.options.database.prepare("UPDATE configuration_external_operations_v2 SET lease_token=NULL,lease_until=0 WHERE operation_id=? AND lease_token=?").run(operationId, token);
    this.leases.delete(operationId);
  }
  async isAuthorized(operation: BackendWriteOperation): Promise<boolean> {
    const authorized = await this.options.isAuthorized(operation);
    const token = this.leases.get(operation.operationId);
    const lease = this.options.database.prepare("SELECT lease_token,lease_until FROM configuration_external_operations_v2 WHERE operation_id=?")
      .get(operation.operationId) as { lease_token: string | null; lease_until: number } | undefined;
    return authorized && Boolean(token && lease?.lease_token === token && lease.lease_until > (this.options.now ?? Date.now)());
  }
  private assertImmutableOperation(record: ExternalOperationRecord): void {
    const saved = this.read(record.operation.operationId);
    if (!saved || !isDeepStrictEqual(saved.operation, record.operation)) throw new Error("The approved external operation is immutable");
  }
  async recordApplied(record: ExternalOperationRecord & { receipt: BackendWriteReceipt }): Promise<void> {
    this.assertImmutableOperation(record);
    assertBackendReceipt(record.operation, record.receipt);
    const db = this.options.database;
    if (db.isTransaction) throw new Error("External operation completion requires its own synchronous transaction boundary");
    db.exec("BEGIN IMMEDIATE");
    try {
      const token = this.leases.get(record.operation.operationId);
      const saved = db.prepare("UPDATE configuration_external_operations_v2 SET record_json=? WHERE operation_id=? AND lease_token=? AND lease_until>?")
        .run(JSON.stringify(record), record.operation.operationId, token ?? "", (this.options.now ?? Date.now)());
      if (saved.changes !== 1) throw new Error("External operation lease expired before receipt commit");
      const result: unknown = this.options.commitApplied(record);
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("External receipt domain commit must be synchronous");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
}
