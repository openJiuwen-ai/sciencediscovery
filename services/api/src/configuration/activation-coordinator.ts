// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationApplyReceipt, ConfigurationRecord } from "./types.js";
import type { ConfigurationActivationEvidence } from "./runtime-bridge.js";

export interface ConfigurationActivationHost {
  /** Current Stop/version/approved revision checks, repeated after any asynchronous activation. */
  isCurrent(record: ConfigurationRecord, receipt: ConfigurationApplyReceipt): Promise<boolean>;
  /** Only the approved delta. Do not reload the complete mutable Session configuration. */
  activate(record: ConfigurationRecord, receipt: ConfigurationApplyReceipt): Promise<ConfigurationActivationEvidence>;
  saveActivation(requestId: string, result: { state: "active" | "failed" | "suppressed" | "needs_user_action"; evidence?: ConfigurationActivationEvidence; code?: string }): Promise<void>;
  enqueueResume(record: ConfigurationRecord, evidence: ConfigurationActivationEvidence): Promise<void>;
}

/** CFG-T28: saved configuration, active runtime and queued continuation are independent durable stages. */
export class ConfigurationActivationCoordinator {
  constructor(private readonly host: ConfigurationActivationHost) {}
  async activate(record: ConfigurationRecord, receipt: ConfigurationApplyReceipt): Promise<"active" | "failed" | "suppressed" | "needs_user_action"> {
    if (receipt.requestId !== record.view.id || receipt.revision !== record.approvedRevision
      || receipt.previewDigest !== record.approvedDigest || receipt.stopGeneration !== record.stopGeneration)
      throw new Error("Activation receipt does not match the approved request");
    if (!await this.host.isCurrent(record, receipt)) {
      await this.host.saveActivation(record.view.id, { state: "suppressed", code: "activation_baseline_changed" });
      return "suppressed";
    }
    if (record.plan.activationMode === "next_run" || record.plan.activationMode === "requires_restart") {
      await this.host.saveActivation(record.view.id, { state: "needs_user_action", code: record.plan.activationMode });
      return "needs_user_action";
    }
    let evidence: ConfigurationActivationEvidence;
    try {
      evidence = await this.host.activate(record, receipt);
      if (evidence.requestId !== record.view.id || evidence.revision !== receipt.revision || evidence.receiptId !== receipt.id
        || evidence.runId !== record.view.runId || !evidence.effectiveRevision || !evidence.toolCatalogFingerprint)
        throw new Error("Target runtime activation evidence is incomplete");
    } catch {
      await this.host.saveActivation(record.view.id, { state: "failed", code: "activation_not_verified" });
      return "failed";
    }
    if (!await this.host.isCurrent(record, receipt)) {
      await this.host.saveActivation(record.view.id, { state: "suppressed", code: "activation_baseline_changed" });
      return "suppressed";
    }
    await this.host.saveActivation(record.view.id, { state: "active", evidence });
    if (record.view.runId) await this.host.enqueueResume(record, evidence);
    return "active";
  }
}
