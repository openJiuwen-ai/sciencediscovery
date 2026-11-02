// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { randomUUID } from "node:crypto";
import type { SessionStore } from "../store.js";
import { makeChoiceReceipt, selectedChoice } from "./choices.js";
import type { ConfigurationRepository } from "./repository.js";
import type { ConfigurationRegistry } from "./registry.js";
import type { ConfigurationAdapterContext, ConfigurationExternalOutcome } from "./types.js";
import { canonical, digest } from "./validation.js";

function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("External outcome unknown")), timeoutMs); })]).finally(() => clearTimeout(timer));
}

/** Submit once. Lease recovery and lost responses only query the external journal. */
export class ConfigurationExternalCommitCoordinator {
  constructor(private readonly store: SessionStore, private readonly repository: ConfigurationRepository,
    private readonly registry: ConfigurationRegistry, private readonly timeoutMs = 10_000) {}

  async settle(sessionId: string, requestId: string): Promise<void> {
    const prepared = await this.store.runConfigurationTransaction(sessionId, () => {
      const record = this.repository.get(requestId, sessionId);
      if (!record || record.view.state !== "applying") return;
      const adapter = this.registry.get(record.view.capabilityId), port = adapter.externalControl;
      if (adapter.persistence !== "external_control" || !port) return;
      if (record.approvedRevision !== record.view.revision || !record.approvedDigest || record.approvedDigest !== record.view.previewDigest) return;
      const job = this.repository.getOutbox(`${requestId}:${record.view.revision}:external_submit`);
      if (!job || ["done", "suppressed"].includes(job.state) || Number(job.payload.nextAttemptAt ?? 0) > Date.now()
        || job.state === "claimed" && Number(job.payload.leaseUntil ?? 0) > Date.now()) return;
      const expectedState = job.state, started = job.payload.submissionStarted === true;
      const operation = { operationId: job.id, bindingDigest: digest([requestId, record.view.capabilityId, record.view.revision, record.approvedDigest]) };
      if (!started) {
        const snapshot = this.store.configurationSnapshot(sessionId, record.view.capabilityId, record.target);
        const stopped = snapshot.stopGeneration !== record.stopGeneration, expired = Boolean(record.view.expiresAt && Date.parse(record.view.expiresAt) <= Date.now());
        const changed = canonical(snapshot.resourceVersions) !== canonical(record.resourceVersions);
        if (stopped || expired || changed) {
          const version = record.view.stateVersion;
          record.view.state = stopped ? "cancelled" : expired ? "expired" : "stale";
          record.view.activation.state = "suppressed"; record.view.resumption.state = "suppressed";
          record.view.error = { code: stopped ? "CONTINUATION_STOPPED" : expired ? "CONFIGURATION_EXPIRED" : "RESOURCE_VERSION_CONFLICT", message: "This external change was not submitted. Review a new preview before applying.", retryable: false };
          record.view.stateVersion++; record.view.updatedAt = new Date().toISOString(); this.repository.save(record, version);
          this.repository.updateOutbox({ ...job, state: "suppressed", updatedAt: record.view.updatedAt }, expectedState); return;
        }
      }
      job.state = "claimed"; job.updatedAt = new Date().toISOString();
      job.payload = { ...job.payload, submissionStarted: true, ...operation, leaseToken: randomUUID(), leaseUntil: Date.now() + Math.max(60_000, this.timeoutMs * 3) };
      if (!this.repository.updateOutbox(job, expectedState)) return;
      return { record, job, port, operation, started };
    });
    if (!prepared) return;
    const { record, port, operation, job } = prepared;
    let outcome: ConfigurationExternalOutcome | undefined;
    try {
      if (prepared.started) outcome = await bounded(port.resolve(operation), this.timeoutMs);
      else {
        const snapshot = this.store.configurationSnapshot(sessionId, record.view.capabilityId, record.target);
        const context: ConfigurationAdapterContext = { sessionId, requestId, revision: record.view.revision, input: record.input,
          plan: record.plan, snapshot: { ...snapshot, ...(record.view.runId ? { runId: record.view.runId } : {}) }, scope: record.view.scope, runId: record.view.runId, previewDigest: record.approvedDigest,
          ...(record.credentialHandle ? { credentialHandle: record.credentialHandle } : {}),
          ...(selectedChoice(record) ? { selectedOption: selectedChoice(record) } : {}) };
        // Fence an unissued operation if Stop, expiry or another write won after
        // releasing the first transaction. The authority rechecks its own CAS too.
        const changed = canonical(snapshot.resourceVersions) !== canonical(record.resourceVersions);
        const stopped = snapshot.stopGeneration !== record.stopGeneration;
        const expired = Boolean(record.view.expiresAt && Date.parse(record.view.expiresAt) <= Date.now());
        outcome = await bounded(changed || stopped || expired ? port.resolve(operation) : port.submit(operation, context), this.timeoutMs);
      }
    } catch {
      try { outcome = await bounded(port.resolve(operation), this.timeoutMs); } catch { /* Keep unknown; never resubmit. */ }
    }
    const valid = outcome?.operationId === operation.operationId && outcome.bindingDigest === operation.bindingDigest
      && (outcome.status === "rejected" && /^[A-Z][A-Z0-9_]{2,99}$/.test(outcome.code)
        || outcome.status === "applied" && outcome.resourceVersions && typeof outcome.resourceVersions === "object" && !Array.isArray(outcome.resourceVersions)
          && canonical(Object.keys(outcome.resourceVersions).sort()) === canonical(Object.keys(record.resourceVersions).sort())
          && Object.values(outcome.resourceVersions).every(value => typeof value === "string" && /^(?:sha256:)?[a-f0-9]{64}$/.test(value)));
    await this.store.runConfigurationTransaction(sessionId, () => {
      const current = this.repository.get(requestId, sessionId), lease = this.repository.getOutbox(job.id);
      if (!current || current.view.state !== "applying" || current.view.revision !== record.view.revision || current.approvedDigest !== record.approvedDigest
        || !lease || lease.state !== "claimed" || lease.payload.leaseToken !== job.payload.leaseToken) return;
      const approvedDigest = current.approvedDigest;
      if (!approvedDigest) return;
      const version = current.view.stateVersion, stopped = current.stopGeneration !== this.store.notifications.generation(sessionId), expired = Boolean(current.view.expiresAt && Date.parse(current.view.expiresAt) <= Date.now());
      const now = new Date().toISOString();
      if (!valid || !outcome) {
        current.view.error = { code: "EXTERNAL_CONFIGURATION_OUTCOME_UNKNOWN", message: "The write result is awaiting authoritative reconciliation. It has not been resubmitted; do not assume it was saved or discarded.", retryable: false };
        lease.state = "pending"; lease.payload.nextAttemptAt = Date.now() + 5_000;
      } else if (outcome.status === "rejected") {
        current.view.state = stopped ? "cancelled" : expired ? "expired" : "failed";
        current.view.activation.state = "suppressed"; current.view.resumption.state = "suppressed";
        current.view.error = { code: outcome.code, message: "The external authority confirmed that this operation was not saved. Refresh the preview and confirm a new revision if still needed.", retryable: false };
        lease.state = "done";
      } else {
        this.repository.saveReceipt({ id: randomUUID(), requestId, revision: current.view.revision, previewDigest: approvedDigest, capabilityId: current.view.capabilityId,
          sessionId, stopGeneration: current.stopGeneration, result: { resourceRevision: digest(outcome.resourceVersions), summary: "The external authority confirmed the saved configuration." }, resourceVersions: outcome.resourceVersions, createdAt: now });
        current.view.state = "applied"; if (selectedChoice(current)) current.view.choiceReceipt = makeChoiceReceipt(current);
        current.view.activation.state = stopped || expired ? "suppressed" : "pending";
        current.view.resumption.state = stopped || expired ? "suppressed" : current.view.runId ? "pending" : "not_requested";
        if (stopped || expired) current.view.error = { code: "EXTERNAL_CONFIGURATION_SAVED_AFTER_STOP", message: "The external authority saved an already submitted change. No task activation or continuation is authorized.", retryable: false }; else delete current.view.error;
        lease.state = "done";
        if (!stopped && !expired) this.repository.enqueueOutbox({ id: `${requestId}:${current.view.revision}:activate`, requestId, revision: current.view.revision, sessionId, kind: "activate", state: "pending",
          payload: { receiptId: this.repository.getReceipt(requestId, current.view.revision)?.id, previewDigest: current.approvedDigest, stopGeneration: current.stopGeneration, activationMode: current.plan.activationMode }, createdAt: now, updatedAt: now });
      }
      lease.updatedAt = now; delete lease.payload.leaseToken; delete lease.payload.leaseUntil;
      if (!this.repository.updateOutbox(lease, "claimed")) throw new Error("External configuration phase lease changed");
      current.view.stateVersion++; current.view.updatedAt = now; this.repository.save(current, version);
    });
  }
}
