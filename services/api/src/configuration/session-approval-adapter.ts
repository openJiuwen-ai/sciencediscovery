// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationAdapter } from "./types.js";
import { ConfigurationError, digest, invalid, object } from "./validation.js";

export function createSessionApprovalAdapter(store: SessionStore, cleanupAvailable: () => boolean): ConfigurationAdapter {
  return {
    id: "security.approval_mode", version: 1, schemaVersion: 1, scopes: ["session"], persistence: "local_transaction",
    normalize: raw => {
      const input = object(raw, ["approvalMode"], "values");
      if (input.approvalMode !== undefined && input.approvalMode !== "ask_for_dangerous" && input.approvalMode !== "always_allow") invalid("Select a registered session approval mode", "approvalMode");
      return input as ConfigurationValues;
    },
    target: () => "security.approval_mode",
    preview: (input, snapshot, scope) => {
      if (!cleanupAvailable()) throw new ConfigurationError("CONFIGURATION_BACKEND_UNSUPPORTED", "No bounded retired-kernel cleanup adapter is installed", 409);
      const source = snapshot.data.sessionApproval as ReturnType<SessionStore["configurationSessionApproval"]>;
      if (source.pendingCount) throw new ConfigurationError("PENDING_PERMISSION_REQUESTS", "Resolve the existing permission cards separately before changing this session's approval mode", 409);
      const next = String(input.approvalMode ?? source.approvalMode);
      const changes = next === source.approvalMode ? [] : [{ field: "approvalMode", before: source.approvalMode, after: String(next) }];
      const statement = "This independent human security decision changes only this session. Always allow automatically permits later eligible actions; direct code still requires its separate authorization. The Permission Epoch rotates and persistent kernel/shell memory may be lost. Existing permission cards must be resolved separately: this change never bulk-approves them. After both human confirmations and cleanup, a bound original configuration task can continue under the existing framework. Ordinary tool Always allow and automatic configuration cannot authorize this policy change.";
      return {
        fields: [{ id: "approvalMode", label: "Current session approval mode", kind: "enum", required: true, value: next,
          choices: [{ id: "ask_for_dangerous", label: "Ask before dangerous actions" }, { id: "always_allow", label: "Always allow eligible actions" }] }],
        changes, impact: { resourceLocation: "Current session approval policy", effectiveScope: "This session only",
          message: `${statement} Network/private-network policy, future-session defaults and automatic configuration authorization stay unchanged. Only reported retired local kernels are cleaned; real Runner behavior is not certified by saving this setting.` },
        securityConsent: { targetDigest: digest([next, scope, snapshot.resourceVersions]), statement },
        verificationPlan: { targets: [], actions: ["After commit: one configured-Runner kernel listing and at most eight exact retired-epoch kernel deletions. Failed cleanup requires explicit Continue; repeated Apply and background polling do not retry it. No execution, download, install or remote job is submitted by the settings writer."], maxRequests: 9, mayCharge: false },
        activationMode: "next_execution", disposition: input.approvalMode === undefined ? "missing_input" : changes.length ? "change" : "no_change", ready: changes.length > 0 && input.approvalMode !== undefined,
        data: { approvalMode: next },
      };
    },
    apply: context => {
      if (!cleanupAvailable()) throw new ConfigurationError("CONFIGURATION_BACKEND_UNSUPPORTED", "Retired-kernel cleanup is no longer available", 409);
      const result = store.applySessionApprovalConfigurationSync(context.sessionId, context.plan.data?.approvalMode);
      return { retiredPermissionEpochIds: result.retiredPermissionEpochIds,
        summary: "Session approval mode saved and Permission Epoch rotated. No pending action was approved; retired-kernel cleanup is separate." };
    },
  };
}
