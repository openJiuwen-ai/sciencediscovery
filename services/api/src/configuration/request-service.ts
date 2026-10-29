// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { randomUUID } from "node:crypto";
import type { ConfigurationDecisionInput, ConfigurationPreviewInput, ConfigurationRequestView, ConfigurationScope } from "@sciencediscovery/schema";
import type { ConfigurationAdapter, ConfigurationAdapterContext, ConfigurationApplyReceipt, ConfigurationHost, ConfigurationPlan, ConfigurationProposalInput, ConfigurationRecord, ConfigurationSnapshot } from "./types.js";
import { ConfigurationRepository } from "./repository.js";
import { ConfigurationRegistry } from "./registry.js";
import { normalizeConfigurationFields } from "./schema-normalizer.js";
import { canonical, ConfigurationError, digest, displayText, integer, invalid, object, string } from "./validation.js";
import { choosePlan, defaultChoices, makeChoiceReceipt, normalizeChoices, projectChoiceReceipt, selectedChoice } from "./choices.js";
import { configurationNeedKey } from "./need-key.js";

const editable = new Set(["collecting_input", "awaiting_confirmation", "needs_fix", "stale", "failed"]);
export interface ConfigurationRequestServiceOptions {
  repository: ConfigurationRepository;
  registry: ConfigurationRegistry;
  host: ConfigurationHost;
  now?: () => Date;
}
export class ConfigurationRequestService {
  readonly repository: ConfigurationRepository;
  readonly registry: ConfigurationRegistry;
  private readonly host: ConfigurationHost;
  private readonly clock: () => Date;
  private readonly ownerId = randomUUID();
  constructor(options: ConfigurationRequestServiceOptions) { this.repository = options.repository; this.registry = options.registry; this.host = options.host; this.clock = options.now ?? (() => new Date()); }
  getRepository(): ConfigurationRepository { return this.repository; }
  getRecord(sessionId: string, id: string): ConfigurationRecord {
    const record = this.repository.get(id, sessionId);
    if (!record) throw new ConfigurationError("CONFIGURATION_REQUEST_NOT_FOUND", "Configuration request not found", 404);
    return record;
  }
  get(sessionId: string, id: string): ConfigurationRequestView { return this.project(this.getRecord(sessionId, id)); }
  list(sessionId: string): ConfigurationRequestView[] { return this.repository.list(sessionId).map((record) => this.project(record)); }
  /** Persist terminal lifecycle facts before returning an error or deduplicating
   * a new proposal. No provider validation or task submission occurs here. */
  async reconcileLifecycle(sessionId: string, id?: string): Promise<ConfigurationRequestView[]> {
    return this.transact(sessionId, () => {
      const changed: ConfigurationRequestView[] = [];
      const records = id ? [this.getRecord(sessionId, id)] : this.repository.list(sessionId);
      for (const record of records) {
        if (!editable.has(record.view.state) && record.view.state !== "validating") continue;
        const snapshot = this.snapshot(sessionId, record.view.capabilityId, record.target, record.view.runId);
        const stopped = record.stopGeneration !== snapshot.stopGeneration;
        const expired = Boolean(record.view.expiresAt && record.view.expiresAt <= this.now());
        if (!stopped && !expired) continue;
        const version = record.view.stateVersion;
        record.view.state = stopped ? "cancelled" : "expired";
        record.view.stateVersion++; record.view.updatedAt = this.now();
        record.view.activation.state = "suppressed"; record.view.resumption.state = !stopped && record.view.runId ? "needs_user_action" : "suppressed";
        record.view.error = { code: stopped ? "CONTINUATION_STOPPED" : "CONFIGURATION_EXPIRED", message: stopped ? "The original task was stopped" : record.view.runId ? "This proposal expired. The original task remains paused. Replanning on the same checkpoint is not available yet; stop this task before retrying." : "This configuration proposal expired. Create a new proposal to continue.", retryable: false };
        delete record.view.autoApplyAt;
        this.repository.save(record, version);
        for (const item of this.repository.listOutbox({ sessionId })) if (item.requestId === record.view.id && ["pending", "claimed"].includes(item.state))
          this.repository.updateOutbox({ ...item, state: "suppressed", updatedAt: this.now() }, item.state);
        this.repository.finishPendingIdempotency(record.view.id, this.project(record));
        changed.push(this.project(record));
      }
      return changed;
    });
  }
  private assertLifecycle(record: ConfigurationRecord): void {
    if (record.view.state === "expired") throw new ConfigurationError("CONFIGURATION_EXPIRED", "This configuration proposal expired", 410);
    if (record.view.state === "cancelled") throw new ConfigurationError("CONTINUATION_STOPPED", "The original task was stopped", 409);
  }
  /** Call once during single-process startup, before accepting new requests. */
  async recoverPendingVerifications(): Promise<number> {
    let recovered = 0;
    for (const attempt of this.repository.listVerificationAttempts()) {
      if (attempt.state !== "started" || attempt.ownerId === this.ownerId) continue;
      try { await this.transact(attempt.sessionId, () => {
        const current = this.repository.getVerificationAttempt(attempt.id);
        if (!current || current.state !== "started" || current.ownerId === this.ownerId) return;
        const record = this.repository.get(attempt.requestId, attempt.sessionId);
        this.repository.saveVerificationAttempt({ ...current, state: "unknown", finishedAt: this.now(), code: "VERIFICATION_RESULT_UNKNOWN" });
        if (!record || record.view.revision !== attempt.revision || record.view.state !== "validating") return;
        const version = record.view.stateVersion;
        const snapshot = this.snapshot(record.view.sessionId, record.view.capabilityId, record.target, record.view.runId);
        record.view.state = snapshot.writable && snapshot.stopGeneration === record.stopGeneration ? "needs_fix" : "cancelled";
        record.view.stateVersion++; record.view.updatedAt = this.now();
        record.view.error = { code: "VERIFICATION_RESULT_UNKNOWN", message: "The previous connection check has no recorded result. Review and confirm before sending a new check.", retryable: false };
        this.repository.save(record, version);
        this.repository.finishPendingIdempotency(record.view.id, this.project(record));
        recovered++;
      }); } catch {
        // Archived/deleted sessions may reject the domain write barrier. Keep
        // their durable attempt untouched and never let them block recovery of
        // another session or cause a verification/network request to be sent.
      }
    }
    return recovered;
  }
  private async transact<T>(sessionId: string, action: () => T): Promise<T> {
    const result = await this.host.runInTransaction(sessionId, () => this.repository.transaction(action));
    await this.host.afterCommit?.(sessionId);
    return result;
  }
  private now(): string { return this.clock().toISOString(); }
  private snapshot(sessionId: string, capabilityId: ConfigurationAdapter["id"], target: string, runId?: string): ConfigurationSnapshot {
    return { ...this.host.snapshot(sessionId, capabilityId, target), ...(runId ? { runId } : {}) };
  }
  private scope(input: ConfigurationScope | undefined, adapter: ConfigurationAdapter, sessionId: string, snapshot: ConfigurationSnapshot): ConfigurationScope {
    const value = input ?? { kind: "session", id: sessionId };
    const candidate = object(value, ["kind", "id"], "scope");
    if (candidate.kind === "global" && candidate.id !== undefined) invalid("Global scope does not accept an id");
    if (!adapter.scopes.includes(value.kind)) invalid("Unsupported configuration scope");
    if (value.kind === "session" && candidate.id !== sessionId || value.kind === "project" && candidate.id !== snapshot.projectId) throw new ConfigurationError("CONFIGURATION_FORBIDDEN", "Configuration scope does not belong to this session", 403);
    return structuredClone(value);
  }
  private checkWritable(snapshot: ConfigurationSnapshot): void {
    if (!snapshot.writable) throw new ConfigurationError("SESSION_NOT_WRITABLE", "The session is not writable", 409);
  }
  private guard(record: ConfigurationRecord, snapshot: ConfigurationSnapshot, compareVersions = true): void {
    this.checkWritable(snapshot);
    if (record.view.expiresAt && record.view.expiresAt <= this.now()) throw new ConfigurationError("CONFIGURATION_EXPIRED", "This configuration proposal expired", 410);
    if (record.stopGeneration !== snapshot.stopGeneration) throw new ConfigurationError("CONTINUATION_STOPPED", "The original task was stopped", 409);
    if (compareVersions && canonical(record.resourceVersions) !== canonical(snapshot.resourceVersions)) throw new ConfigurationError("RESOURCE_VERSION_CONFLICT", "Settings changed since this proposal was prepared", 409);
    const adapter = this.registry.get(record.view.capabilityId);
    if (adapter.version !== record.adapterVersion || adapter.schemaVersion !== record.schemaVersion) throw new ConfigurationError("STALE_CONFIGURATION_PREVIEW", "The adapter changed; prepare a new proposal", 409);
  }
  private plan(adapter: ConfigurationAdapter, input: ConfigurationRecord["input"], snapshot: ConfigurationSnapshot, scope: ConfigurationScope, credentialHandle?: string): ConfigurationPlan {
    const source = adapter.preview(input, snapshot, scope);
    const fields = normalizeConfigurationFields(source.fields, adapter.fieldPolicy);
    if (credentialHandle) {
      const credentials = fields.filter((field) => field.kind === "credential");
      if (credentials.length !== 1) invalid("Credential handle must identify one registered field");
      for (const field of fields) if (field.kind === "credential") field.status = "provided";
    }
    const changes = source.changes.map((change) => {
      const value = object(change, ["field", "before", "after"], "change");
      return { field: string(value.field, "change.field", 200), ...(value.before !== undefined ? { before: displayText(value.before, "change.before", 2000) } : {}), ...(value.after !== undefined ? { after: displayText(value.after, "change.after", 2000) } : {}) };
    });
    if (changes.length > 100) invalid("Too many changes");
    const impact = object(source.impact, ["resourceLocation", "effectiveScope", "message"], "impact");
    const verification = object(source.verificationPlan, ["targets", "actions", "maxRequests", "mayCharge"], "verificationPlan");
    if (!Array.isArray(verification.targets) || verification.targets.length > 8 || !Array.isArray(verification.actions) || verification.actions.length > 8 || typeof verification.mayCharge !== "boolean") invalid("Invalid verification plan");
    const targets = verification.targets.map((target) => {
      const value = string(target, "verification target", 2048);
      let url: URL; try { url = new URL(value); } catch { return invalid("Invalid verification target"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid("Verification target cannot contain credentials or query data");
      return url.href;
    });
    if (!["before_first_run", "same_run", "next_run", "requires_restart"].includes(source.activationMode)) invalid("Invalid activation mode");
    const maxRequests = integer(verification.maxRequests, "maxRequests", 0);
    if (maxRequests > 10 || typeof source.ready !== "boolean") invalid("Verification budget exceeds the supported limit");
    return { fields, changes, disposition: source.disposition ?? (source.ready ? "change" : "missing_input"),
      impact: { resourceLocation: string(impact.resourceLocation, "resourceLocation", 500), effectiveScope: string(impact.effectiveScope, "effectiveScope", 500), message: string(impact.message, "impact.message", 2000) },
      verificationPlan: { targets, actions: verification.actions.map((action) => string(action, "verification action", 500)), maxRequests, mayCharge: verification.mayCharge },
      activationMode: snapshot.runId && source.activationMode === "before_first_run" ? "next_run" : source.activationMode, ready: source.ready && !fields.some((field) => field.kind === "credential" && field.required && field.status !== "provided"),
      ...(source.endpointAuthorization ? { endpointAuthorization: structuredClone(source.endpointAuthorization) } : {}),
      ...(source.data ? { data: structuredClone(source.data) } : {}) };
  }
  private refreshDigest(record: ConfigurationRecord): void {
    record.view.previewDigest = digest({ id: record.view.id, revision: record.view.revision, adapterVersion: record.adapterVersion, schemaVersion: record.schemaVersion, input: record.input, scope: record.view.scope, target: record.target, plan: record.plan, resourceVersions: record.resourceVersions, stopGeneration: record.stopGeneration, credentialHandle: record.credentialHandle,
      ...(record.view.protocolVersion === 3 ? { protocolVersion: 3, options: record.view.options, selectedOptionId: record.view.selectedOptionId, needKey: record.view.needKey } : {}) });
  }
  private actions(record: ConfigurationRecord): ConfigurationRequestView["allowedActions"] {
    const view = record.view;
    if (view.state === "collecting_input" || view.state === "needs_fix" || view.state === "stale" || view.state === "failed") return ["preview", "dismiss"];
    if (view.state === "awaiting_confirmation") return ["preview", "apply", "dismiss"];
    if (view.state === "validating" || view.state === "applying") return ["query"];
    if (view.state === "applied") return [...(this.registry.get(view.capabilityId).previewReversal && (!selectedChoice(record) || selectedChoice(record)?.kind === "persisted_apply") ? ["reversal" as const] : []), ...(["pending", "failed", "needs_user_action"].includes(view.resumption.state) ? ["continue" as const] : [])];
    return [];
  }
  /** Every field below is an explicit whitelist; internal record extensions stay server-only. */
  private project(record: ConfigurationRecord): ConfigurationRequestView {
    const view = record.view;
    const endpointAuthorization = this.host.projectEndpointAuthorization?.(record);
    return structuredClone({
      ...(view.protocolVersion === 3 ? { protocolVersion: 3 as const, options: normalizeChoices(view.options ?? []), selectedOptionId: view.selectedOptionId, needKey: view.needKey,
        ...(view.choiceReceipt ? { choiceReceipt: projectChoiceReceipt(view.choiceReceipt) } : {}) } : {}),
      id: view.id, sessionId: view.sessionId, projectId: view.projectId,
      ...(view.runId ? { runId: view.runId } : {}), revision: view.revision, stateVersion: view.stateVersion,
      capabilityId: view.capabilityId, adapterVersion: record.adapterVersion, schemaVersion: record.schemaVersion, state: view.state,
      ...(endpointAuthorization ? { endpointAuthorization } : {}),
      ...(view.autoApplyAt ? { autoApplyAt: view.autoApplyAt } : {}),
      ...(view.decisionSource ? { decisionSource: view.decisionSource } : {}),
      reason: { code: view.reason.code, message: view.reason.message },
      scope: view.scope.kind === "global" ? { kind: "global" } : { kind: view.scope.kind, id: view.scope.id },
      fields: normalizeConfigurationFields(view.fields, this.registry.get(view.capabilityId).fieldPolicy),
      changes: view.changes.map(({ field, before, after }) => ({ field, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) })),
      impact: { resourceLocation: view.impact.resourceLocation, effectiveScope: view.impact.effectiveScope, message: view.impact.message },
      verificationPlan: { targets: [...view.verificationPlan.targets], actions: [...view.verificationPlan.actions], maxRequests: view.verificationPlan.maxRequests, mayCharge: view.verificationPlan.mayCharge },
      ...(view.previewDigest ? { previewDigest: view.previewDigest } : {}),
      activation: { mode: view.activation.mode, state: view.activation.state, ...(view.activation.effectiveRevision ? { effectiveRevision: view.activation.effectiveRevision } : {}) },
      resumption: { state: view.resumption.state, ...(view.resumption.runId ? { runId: view.resumption.runId } : {}) },
      ...(view.error ? { error: { code: view.error.code, message: view.error.message, ...(view.error.field ? { field: view.error.field } : {}), retryable: view.error.retryable } } : {}),
      allowedActions: this.actions(record), createdAt: view.createdAt, updatedAt: view.updatedAt,
      ...(view.expiresAt ? { expiresAt: view.expiresAt } : {}),
    });
  }
  private replay(scope: string, key: string | undefined, payload: unknown, sessionId: string): ConfigurationRequestView | undefined {
    const previous = this.repository.getIdempotency(scope, key, payload);
    if (!previous) return undefined;
    const current = this.get(sessionId, previous.requestId);
    return ["expired", "cancelled"].includes(current.state) ? current : previous.response ?? current;
  }
  async propose(sessionId: string, input: ConfigurationProposalInput, key?: string, expectedResourceVersions?: Record<string, string>): Promise<ConfigurationRequestView> {
    return this.proposeInternal(sessionId, input, key, expectedResourceVersions);
  }
  private async proposeInternal(sessionId: string, input: ConfigurationProposalInput, key?: string, expectedResourceVersions?: Record<string, string>, trustedReversal = false): Promise<ConfigurationRequestView> {
    const value = object(input, ["capabilityId", "values", "scope", "runId", "reason", "requestId", "protocolVersion"], "proposal");
    if (input.protocolVersion !== undefined && input.protocolVersion !== 3) invalid("Unsupported configuration protocol version");
    if (["skill.select", "thinking.configure", "review.configure", "timeouts.configure", "quotas.configure", "idea_tree.configure"].includes(String(value.capabilityId)) && input.protocolVersion !== 3)
      throw new ConfigurationError("CONFIGURATION_PROTOCOL_REQUIRED", "This configuration capability requires the v3 choice protocol. Upgrade the client before preparing a proposal.", 409);
    const adapter = this.registry.get(string(value.capabilityId, "capabilityId", 100));
    const normalized = trustedReversal ? structuredClone(input.values) : adapter.normalize(value.values);
    const target = adapter.target(normalized);
    if (input.runId) string(input.runId, "runId", 200);
    if (input.requestId) string(input.requestId, "requestId", 200);
    const reason = input.reason === undefined ? "A configuration change is required" : string(input.reason, "reason", 2000);
    const payload = { ...input, values: normalized };
    const idempotencyScope = `${sessionId}:propose`;
    await this.reconcileLifecycle(sessionId);
    return this.transact(sessionId, () => {
      const replay = this.replay(idempotencyScope, key, payload, sessionId); if (replay) return replay;
      const snapshot = this.snapshot(sessionId, adapter.id, target, input.runId); this.checkWritable(snapshot);
      if (expectedResourceVersions && canonical(snapshot.resourceVersions) !== canonical(expectedResourceVersions)) throw new ConfigurationError("RESOURCE_VERSION_CONFLICT", "Settings changed while preparing the reverse proposal", 409);
      const scope = this.scope(input.scope, adapter, sessionId, snapshot);
      const fingerprint = digest({ capabilityId: adapter.id, target, scope, runId: input.runId });
      const existing = this.repository.findActive(sessionId, fingerprint);
      if (existing) {
        if (existing.view.protocolVersion !== input.protocolVersion) throw new ConfigurationError("CONFIGURATION_PROTOCOL_CONFLICT", "The active proposal uses another protocol version", 409);
        if (canonical(existing.input) !== canonical(normalized)) throw new ConfigurationError("ACTIVE_CONFIGURATION_CONFLICT", "A proposal for this target already exists; edit its preview", 409);
        this.repository.reserveIdempotency(idempotencyScope, key, payload, existing.view.id); const view = this.project(existing); this.repository.finishIdempotency(idempotencyScope, key, view); return view;
      }
      let plan = this.plan(adapter, normalized, snapshot, scope);
      if (plan.disposition === "no_change") throw new ConfigurationError("CONFIGURATION_NO_CHANGE", "The requested settings are already effective. No configuration or user decision is needed.", 409);
      const options = input.protocolVersion === 3 ? normalizeChoices(this.host.choiceOptions?.({ sessionId, capabilityId: adapter.id, input: normalized, snapshot, scope, ...(input.runId ? { runId: input.runId } : {}) }) ?? defaultChoices()) : undefined;
      const selected = options?.find(option => option.kind === "persisted_apply");
      if (selected) plan = choosePlan(plan, selected);
      const now = this.now();
      const view: ConfigurationRequestView = { id: input.requestId ?? randomUUID(), sessionId, projectId: snapshot.projectId, ...(input.runId ? { runId: input.runId } : {}), revision: 1, stateVersion: 1, capabilityId: adapter.id, adapterVersion: adapter.version, schemaVersion: adapter.schemaVersion, state: plan.ready ? "awaiting_confirmation" : "collecting_input", reason: { code: "CONFIGURATION_REQUIRED", message: reason }, scope, fields: plan.fields, changes: plan.changes, impact: plan.impact, verificationPlan: plan.verificationPlan, activation: { mode: plan.activationMode, state: "not_requested" }, resumption: { state: "not_requested", ...(input.runId ? { runId: input.runId } : {}) }, allowedActions: [], createdAt: now, updatedAt: now, expiresAt: new Date(this.clock().getTime() + 24 * 60 * 60 * 1000).toISOString() };
      const record: ConfigurationRecord = { view, adapterVersion: adapter.version, schemaVersion: adapter.schemaVersion, input: normalized, target, plan, resourceVersions: snapshot.resourceVersions, stopGeneration: snapshot.stopGeneration, fingerprint, createdBy: "authenticated_client" };
      if (options && selected) {
        view.protocolVersion = 3; view.options = options; view.selectedOptionId = selected.id;
        view.needKey = configurationNeedKey({ runId: input.runId, capabilityId: adapter.id, target, snapshot });
      }
      this.refreshDigest(record); this.repository.save(record); this.repository.reserveIdempotency(idempotencyScope, key, payload, view.id); const result = this.project(record); this.repository.finishIdempotency(idempotencyScope, key, result); return result;
    });
  }
  async preview(sessionId: string, id: string, input: ConfigurationPreviewInput, key?: string): Promise<ConfigurationRequestView> {
    object(input, ["expectedRevision", "values", "scope", "credentialHandle", "selectedOptionId"], "preview"); integer(input.expectedRevision, "expectedRevision");
    if (input.selectedOptionId !== undefined) string(input.selectedOptionId, "selectedOptionId", 100);
    if (input.credentialHandle !== undefined) string(input.credentialHandle, "credentialHandle", 500);
    const idempotencyScope = `${sessionId}:${id}:preview`;
    await this.reconcileLifecycle(sessionId, id);
    return this.transact(sessionId, () => {
      const replay = this.replay(idempotencyScope, key, input, sessionId); if (replay) return replay;
      const record = this.getRecord(sessionId, id); const oldStateVersion = record.view.stateVersion;
      this.assertLifecycle(record);
      if (record.view.revision !== input.expectedRevision || !editable.has(record.view.state)) throw new ConfigurationError("STALE_CONFIGURATION_PREVIEW", "This preview is no longer editable", 409);
      // Alternative/dismiss previews intentionally project no editable fields.
      // A subsequent option switch (including after refresh) retains the server's
      // non-sensitive candidate rather than requiring the browser to cache it.
      const noWrite = record.view.options?.some(option => option.id === input.selectedOptionId && ["dismiss", "alternative"].includes(option.kind));
      const values = noWrite || record.view.protocolVersion === 3 && input.selectedOptionId !== undefined && record.plan.fields.length === 0
        && Object.keys(object(input.values, Object.keys(input.values ?? {}), "values")).length === 0 ? record.input : input.values;
      const adapter = this.registry.get(record.view.capabilityId); const normalized = adapter.normalize(values); const target = adapter.target(normalized);
      const snapshot = this.snapshot(sessionId, adapter.id, target, record.view.runId); this.checkWritable(snapshot);
      if (snapshot.stopGeneration !== record.stopGeneration) throw new ConfigurationError("CONTINUATION_STOPPED", "The original task was stopped", 409);
      if (record.view.expiresAt && record.view.expiresAt <= this.now()) throw new ConfigurationError("CONFIGURATION_EXPIRED", "This proposal expired", 410);
      const scope = this.scope(input.scope ?? record.view.scope, adapter, sessionId, snapshot);
      if (record.view.protocolVersion !== 3 && input.selectedOptionId !== undefined) invalid("A v2 proposal does not accept selected options");
      const options = record.view.protocolVersion === 3 ? normalizeChoices(this.host.choiceOptions?.({ sessionId, capabilityId: adapter.id, input: normalized, snapshot, scope, ...(record.view.runId ? { runId: record.view.runId } : {}) }) ?? defaultChoices()) : undefined;
      const selected = options?.find(option => option.id === (input.selectedOptionId ?? record.view.selectedOptionId));
      if (options && !selected) throw new ConfigurationError("CONFIGURATION_OPTION_UNAVAILABLE", "Select an available option from the latest proposal", 409);
      if (selected?.kind === "run_overlay" && (adapter.id !== "connector.enable" || adapter.persistence !== "local_transaction" || !record.view.runId || input.credentialHandle || record.credentialHandle))
        throw new ConfigurationError("CONFIGURATION_OPTION_UNAVAILABLE", "Task overlays support ready connectors without temporary credentials only", 409);
      let credentialHandle = input.credentialHandle ?? (target === record.target ? record.credentialHandle : undefined);
      if (input.credentialHandle && target !== record.target) throw new ConfigurationError("INVALID_CONFIGURATION_INPUT", "Credentials must be provided again after changing the target", 400);
      if (credentialHandle && this.host.resolvePreviewCredential) credentialHandle = this.host.resolvePreviewCredential({ sessionId, requestId: id, revision: record.view.revision, target: String(record.plan.data?.credentialTarget ?? record.target), credentialHandle, explicit: input.credentialHandle !== undefined });
      // Refusal remains available if the target disappeared while this task waited.
      // Only the server-owned dismissal choice may skip rebuilding an applying plan.
      let plan = selected?.kind === "dismiss" ? record.plan : this.plan(adapter, normalized, snapshot, scope, credentialHandle);
      if (selected) plan = choosePlan(plan, selected);
      this.host.onPreviewRevision?.({ sessionId, requestId: id, fromRevision: record.view.revision, toRevision: record.view.revision + 1, oldTarget: record.target, newTarget: target, ...(credentialHandle ? { credentialHandle } : {}) });
      record.input = normalized; record.target = target; record.plan = plan; record.resourceVersions = snapshot.resourceVersions; record.adapterVersion = adapter.version; record.schemaVersion = adapter.schemaVersion;
      if (options && selected) {
        record.view.options = options; record.view.selectedOptionId = selected.id;
        record.view.needKey = configurationNeedKey({ runId: record.view.runId, capabilityId: adapter.id, target, snapshot });
      }
      record.view.scope = scope; record.view.revision++; record.view.stateVersion++; record.view.updatedAt = this.now(); record.view.state = plan.ready ? "awaiting_confirmation" : "collecting_input";
      record.view.fields = plan.fields; record.view.changes = plan.changes; record.view.impact = plan.impact; record.view.verificationPlan = plan.verificationPlan; record.view.activation = { mode: plan.activationMode, state: "not_requested" };
      record.credentialHandle = credentialHandle; delete record.approvedDigest; delete record.approvedRevision; delete record.view.error;
      record.fingerprint = digest({ capabilityId: adapter.id, target, scope, runId: record.view.runId });
      const active = this.repository.findActive(sessionId, record.fingerprint);
      if (active && active.view.id !== id) throw new ConfigurationError("ACTIVE_CONFIGURATION_CONFLICT", "Another proposal already exists for this target", 409);
      record.view.adapterVersion = adapter.version; record.view.schemaVersion = adapter.schemaVersion; this.refreshDigest(record);
      if (selected && selected.kind !== "dismiss") this.host.validateChoice?.(this.context(record, snapshot));
      this.repository.save(record, oldStateVersion); this.repository.reserveIdempotency(idempotencyScope, key, input, id); const result = this.project(record); this.repository.finishIdempotency(idempotencyScope, key, result); return result;
    });
  }
  private context(record: ConfigurationRecord, snapshot: ConfigurationSnapshot): ConfigurationAdapterContext {
    return { sessionId: record.view.sessionId, requestId: record.view.id, revision: record.view.revision, input: record.input, plan: record.plan, snapshot, scope: record.view.scope,
      ...(record.view.runId ? { runId: record.view.runId } : {}), ...(record.view.previewDigest ? { previewDigest: record.view.previewDigest } : {}),
      ...(selectedChoice(record) ? { selectedOption: selectedChoice(record) } : {}), ...(record.credentialHandle ? { credentialHandle: record.credentialHandle } : {}) };
  }
  async decide(sessionId: string, id: string, input: ConfigurationDecisionInput, key?: string): Promise<ConfigurationRequestView> {
    object(input, ["revision", "previewDigest", "decision", "selectedOptionId"], "decision"); integer(input.revision, "revision"); string(input.previewDigest, "previewDigest", 100);
    if (input.selectedOptionId !== undefined) string(input.selectedOptionId, "selectedOptionId", 100);
    if (input.decision !== "apply" && input.decision !== "dismiss") invalid("Unknown configuration decision");
    const idempotencyScope = `${sessionId}:${id}:decision`;
    await this.reconcileLifecycle(sessionId, id);
    const prepared = await this.transact(sessionId, (): { done: ConfigurationRequestView } | { record: ConfigurationRecord; snapshot: ConfigurationSnapshot } => {
      const replay = this.replay(idempotencyScope, key, input, sessionId); if (replay) return { done: replay };
      const record = this.getRecord(sessionId, id); const version = record.view.stateVersion;
      this.assertLifecycle(record);
      const option = selectedChoice(record);
      if (record.view.protocolVersion === 3) {
        if (!option || input.selectedOptionId !== option.id) throw new ConfigurationError("CONFIGURATION_OPTION_REQUIRED", "Confirm the selected option from the latest preview", 409);
        if ((input.decision === "dismiss") !== (option.kind === "dismiss")) invalid("The decision does not match the selected option");
      } else if (input.selectedOptionId !== undefined) invalid("A v2 proposal does not accept selected options");
      if (record.view.revision !== input.revision || record.view.previewDigest !== input.previewDigest) throw new ConfigurationError("STALE_CONFIGURATION_PREVIEW", "Confirm the latest preview", 409);
      const noWrite = input.decision === "dismiss" || option?.kind === "alternative";
      if ((!noWrite && record.view.state === "applied") || (noWrite && record.view.state === "dismissed")) return { done: this.project(record) };
      if (input.decision === "apply" && ["validating", "applying"].includes(record.view.state)) return { done: this.project(record) };
      if (!editable.has(record.view.state)) throw new ConfigurationError("STALE_CONFIGURATION_PREVIEW", "This request has already been resolved", 409);
      const snapshot = this.snapshot(sessionId, record.view.capabilityId, record.target, record.view.runId); this.guard(record, snapshot, option?.kind !== "dismiss" && input.decision === "apply");
      if (option && option.kind !== "dismiss") {
        const available = normalizeChoices(this.host.choiceOptions?.({ sessionId, capabilityId: record.view.capabilityId, input: record.input, snapshot, scope: record.view.scope, ...(record.view.runId ? { runId: record.view.runId } : {}) }) ?? defaultChoices()).find(item => item.id === option.id);
        if (!available?.available || canonical(available) !== canonical(option)) throw new ConfigurationError("CONFIGURATION_OPTION_UNAVAILABLE", "The selected option changed. Refresh its preview.", 409);
        this.host.validateChoice?.(this.context(record, snapshot));
      }
      if (input.decision === "apply" && (!record.plan.ready || record.view.state !== "awaiting_confirmation")) invalid("Complete and preview all required fields first");
      record.view.stateVersion++; record.view.updatedAt = this.now(); record.approvedRevision = record.view.revision; record.approvedDigest = record.view.previewDigest;
      record.view.state = noWrite ? "dismissed" : "validating";
      if (noWrite && option) record.view.choiceReceipt = makeChoiceReceipt(record);
      if (noWrite && record.view.runId) { record.view.resumption.state = "pending"; this.enqueue(record, "resume", { decision: "dismiss" }); }
      this.repository.save(record, version); this.repository.reserveIdempotency(idempotencyScope, key, input, id);
      if (noWrite) { const result = this.project(record); this.repository.finishIdempotency(idempotencyScope, key, result); return { done: result }; }
      this.repository.saveVerificationAttempt({ id: `${id}:${input.revision}:verify`, requestId: id, sessionId, revision: input.revision, ownerId: this.ownerId, state: "started", startedAt: this.now() });
      return { record, snapshot };
    });
    if ("done" in prepared) return prepared.done;
    const adapter = this.registry.get(prepared.record.view.capabilityId);
    let verification;
    try {
      // Stop or another settings write may have won while the previous barrier
      // was being released. Recheck immediately before sending a paid probe.
      const snapshot = await this.transact(sessionId, () => {
        const current = this.getRecord(sessionId, id);
        const latest = this.snapshot(sessionId, current.view.capabilityId, current.target, current.view.runId);
        this.guard(current, latest);
        this.host.validateChoice?.(this.context(current, latest));
        return latest;
      });
      verification = await adapter.verify?.(this.context(prepared.record, snapshot)) ?? { ok: true };
    }
    catch (error) {
      // Typed codes are public identifiers; provider exception messages are never
      // a safe projection, even when wrapped by an adapter. Retry requires an
      // explicit user decision and never resends a paid probe automatically.
      const known = error instanceof ConfigurationError && /^[A-Z][A-Z0-9_]{2,99}$/.test(error.code);
      verification = {
        ok: false, code: known ? error.code : "CONFIGURATION_VERIFICATION_FAILED",
        message: known && error.retryable ? "The configuration could not be verified. Review the current values and retry explicitly." : "The configuration could not be verified. Refresh the proposal and review its current values.",
        retryable: known && error.retryable === true,
        ...(known && error.field && prepared.record.plan.fields.some(field => field.id === error.field) ? { field: error.field } : {}),
      };
    }
    return this.transact(sessionId, () => {
      const record = this.getRecord(sessionId, id); const version = record.view.stateVersion;
      this.finishVerification(id, input.revision, verification.ok, verification.code);
      if (record.view.state !== "validating" || record.approvedRevision !== input.revision || record.approvedDigest !== input.previewDigest) return this.project(record);
      const snapshot = this.snapshot(sessionId, record.view.capabilityId, record.target, record.view.runId);
      try { this.guard(record, snapshot); }
      catch (error) {
        if (!(error instanceof ConfigurationError)) throw error;
        record.view.state = error.code === "CONTINUATION_STOPPED" || error.code === "SESSION_NOT_WRITABLE" ? "cancelled" : error.code === "CONFIGURATION_EXPIRED" ? "expired" : "stale";
        if (record.view.state === "expired" || record.view.state === "cancelled") {
          record.view.activation.state = "suppressed";
          record.view.resumption.state = record.view.state === "expired" && record.view.runId ? "needs_user_action" : "suppressed";
          delete record.view.autoApplyAt;
        }
        record.view.error = { code: error.code, message: error.message, retryable: false }; record.view.stateVersion++; record.view.updatedAt = this.now(); this.repository.save(record, version); const result = this.project(record); this.repository.finishIdempotency(idempotencyScope, key, result); return result;
      }
      if (!verification.ok) {
        record.view.state = "needs_fix"; record.view.stateVersion++; record.view.updatedAt = this.now(); record.view.error = { code: verification.code ?? "CONFIGURATION_VERIFICATION_FAILED", message: verification.message ?? "The connection could not be verified", ...(verification.field ? { field: verification.field } : {}), retryable: verification.retryable === true }; this.repository.save(record, version); const result = this.project(record); this.repository.finishIdempotency(idempotencyScope, key, result); return result;
      }
      if (adapter.persistence === "external_control") {
        record.view.state = "applying"; record.view.stateVersion++; record.view.updatedAt = this.now(); this.enqueue(record, "external_submit", {}); this.repository.save(record, version);
      } else {
        this.host.validateChoice?.(this.context(record, snapshot));
        const option = selectedChoice(record);
        const overlay = option?.kind === "run_overlay";
        const apply = overlay ? this.host.applyRunOverlay : adapter.apply;
        if (!apply) {
          if (overlay) { throw new ConfigurationError("CONFIGURATION_OPTION_UNAVAILABLE", "This executor cannot apply a task overlay", 409); }
          throw new Error("Local adapters require a synchronous domain apply");
        }
        const result = apply.call(overlay ? this.host : adapter, this.context(record, snapshot));
        if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Configuration domain apply must be synchronous");
        const after = this.snapshot(sessionId, record.view.capabilityId, record.target, record.view.runId);
        const receipt: ConfigurationApplyReceipt = { id: randomUUID(), requestId: id, revision: input.revision, previewDigest: input.previewDigest, capabilityId: adapter.id, sessionId, stopGeneration: record.stopGeneration, result, resourceVersions: after.resourceVersions, createdAt: this.now() };
        const executionDependencies = this.host.executionDependencies?.(record);
        if (executionDependencies) receipt.executionDependencies = executionDependencies;
        this.repository.saveReceipt(receipt); record.view.state = "applied"; record.view.stateVersion++; record.view.updatedAt = this.now(); delete record.view.error;
        if (option) record.view.choiceReceipt = makeChoiceReceipt(record);
        record.view.activation.state = "pending"; if (record.view.runId) record.view.resumption.state = "pending";
        this.enqueue(record, "activate", { receiptId: receipt.id, decision: "apply" }); this.repository.save(record, version);
      }
      const result = this.project(record); this.repository.finishIdempotency(idempotencyScope, key, result); return result;
    }).catch(async (error: unknown) => {
      // The host rolled back the domain catalog and SQLite transaction. Persist an
      // explicit retryable phase instead of stranding the request in validating.
      return this.transact(sessionId, () => {
        const record = this.getRecord(sessionId, id);
        if (record.view.state !== "validating") throw error;
        const version = record.view.stateVersion;
        this.finishVerification(id, input.revision, verification.ok, verification.code);
        record.view.state = "failed";
        record.view.stateVersion++;
        record.view.updatedAt = this.now();
        record.view.error = { code: "CONFIGURATION_APPLY_FAILED", message: "The change could not be saved. Review the preview before trying again.", retryable: true };
        this.repository.save(record, version);
        const result = this.project(record);
        this.repository.finishIdempotency(idempotencyScope, key, result);
        return result;
      });
    });
  }
  private finishVerification(requestId: string, revision: number, ok: boolean, code?: string): void {
    const attempt = this.repository.getVerificationAttempt(`${requestId}:${revision}:verify`);
    if (attempt?.state === "started") this.repository.saveVerificationAttempt({ ...attempt, state: ok ? "succeeded" : "failed", finishedAt: this.now(), ...(code ? { code } : {}) });
  }
  private enqueue(record: ConfigurationRecord, kind: "activate" | "resume" | "external_submit", extra: Record<string, unknown>): void {
    const now = this.now();
    const option = selectedChoice(record);
    this.repository.enqueueOutbox({ id: `${record.view.id}:${record.view.revision}:${kind}`, requestId: record.view.id, revision: record.view.revision, sessionId: record.view.sessionId, kind, state: "pending", payload: { ...extra, activationMode: record.view.activation.mode, ...(record.view.runId ? { runId: record.view.runId } : {}), stopGeneration: record.stopGeneration, previewDigest: record.view.previewDigest,
      ...(option ? { selectedOptionId: option.id, choiceKind: option.kind, ...(option.alternativeId ? { alternativeId: option.alternativeId } : {}), needKey: record.view.needKey } : {}) }, createdAt: now, updatedAt: now });
  }
  async reversal(sessionId: string, id: string, key?: string): Promise<ConfigurationRequestView> {
    const record = this.getRecord(sessionId, id); const adapter = this.registry.get(record.view.capabilityId); const receipt = this.repository.getReceipt(id, record.view.revision);
    const previewReversal = adapter.previewReversal;
    if (record.view.state !== "applied" || !receipt || !previewReversal || selectedChoice(record) && selectedChoice(record)?.kind !== "persisted_apply") throw new ConfigurationError("CONFIGURATION_REVERSAL_UNAVAILABLE", "This configuration cannot be reversed automatically", 409);
    const reverse = await this.transact(sessionId, () => {
      const snapshot = this.snapshot(sessionId, record.view.capabilityId, record.target); this.checkWritable(snapshot);
      // A removed/offline source must remain removable. Only the formal
      // settings baseline can prevent restoring this receipt's inverse;
      // current availability is revalidated for newly enabled sources.
      const baseline = (versions: Record<string, string>) => record.view.capabilityId === "connector.enable"
        ? { settings: versions.settings } : versions;
      if (canonical(baseline(snapshot.resourceVersions)) !== canonical(baseline(receipt.resourceVersions))) throw new ConfigurationError("RESOURCE_VERSION_CONFLICT", "Settings changed after this application; prepare a new proposal", 409);
      return { values: previewReversal.call(adapter, receipt, snapshot), resourceVersions: snapshot.resourceVersions };
    });
    return this.proposeInternal(sessionId, { ...(record.view.protocolVersion === 3 ? { protocolVersion: 3 } : {}), capabilityId: record.view.capabilityId, values: reverse.values, scope: record.view.scope, reason: "Reverse the selected configuration change" }, key ? `reversal:${id}:${key}` : undefined, reverse.resourceVersions, true);
  }
}
