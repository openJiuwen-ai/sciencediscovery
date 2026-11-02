// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationAdapter } from "./types.js";
import { digest, invalid, object } from "./validation.js";
export function createAutomaticConfigurationAdapter(store: SessionStore): ConfigurationAdapter {
  return {
    id: "security.automatic_configuration", version: 1, schemaVersion: 1, scopes: ["session"], persistence: "local_transaction",
    normalize: (raw): ConfigurationValues => {
      const input = object(raw, ["autoApplyLowRiskConfiguration"], "values");
      if (input.autoApplyLowRiskConfiguration !== undefined && typeof input.autoApplyLowRiskConfiguration !== "boolean") invalid("Choose an explicit boolean", "autoApplyLowRiskConfiguration");
      return typeof input.autoApplyLowRiskConfiguration === "boolean" ? { autoApplyLowRiskConfiguration: input.autoApplyLowRiskConfiguration } : {};
    }, target: () => "security.automatic_configuration",
    preview: (input, snapshot, scope) => {
      const current = snapshot.data.automaticConfiguration === true, next = input.autoApplyLowRiskConfiguration === undefined ? current : input.autoApplyLowRiskConfiguration === true;
      const statement = `Independent human security decision for this Session: ${next ? "future supported installed connector proposals may save after their cancellation window" : "eligible pending connector proposals lose their automatic countdown and future proposals require manual approval"}. Tool execution permissions, network access, credentials and choices requiring explicit selection remain separately authorized.`;
      const changes = current === next ? [] : [{ field: "autoApplyLowRiskConfiguration", before: String(current), after: String(next) }];
      return { fields: [{ id: "autoApplyLowRiskConfiguration", label: "Automatically save eligible low-risk configuration", kind: "boolean", required: false, value: next }], changes,
        impact: { resourceLocation: "Session automatic low-risk configuration policy", effectiveScope: "This Session only", message: `${statement} Only installed connector types on the existing whitelist are eligible. The settings writer performs no retrieval, tool execution, model call or installation. A bound original configuration wait may continue through the framework; activation timing and execution permissions remain separate. Enabling does not revive old countdowns. Other Sessions and current tool Always allow/Permission Epochs stay unchanged. Saving is not evidence that any future proposal or tool has succeeded.` },
        securityConsent: { targetDigest: digest([next, scope, snapshot.resourceVersions]), statement },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_request",
        disposition: !Object.keys(input).length ? "missing_input" : changes.length ? "change" : "no_change", ready: changes.length > 0 };
    },
    apply: context => {
      store.applyAutomaticConfigurationSync(context.sessionId, context.input.autoApplyLowRiskConfiguration === true);
      return { resourceRevision: digest(store.configurationSnapshot(context.sessionId, "security.automatic_configuration", "security.automatic_configuration").resourceVersions), summary: "Session policy saved for subsequent eligible configuration proposals; tool permission remains separate" };
    },
  };
}
