// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationAdapter } from "./types.js";
import { digest, invalid, object } from "./validation.js";
const modes = ["ask_for_dangerous", "always_allow", "inherit"] as const;
type Mode = typeof modes[number];
export function createDefaultApprovalAdapter(store: SessionStore): ConfigurationAdapter {
  return {
    id: "security.default_approval", version: 1, schemaVersion: 1, scopes: ["global", "project"], persistence: "local_transaction",
    normalize: raw => {
      const input = object(raw, ["defaultApprovalMode"], "values");
      if (input.defaultApprovalMode !== undefined && !modes.includes(input.defaultApprovalMode as Mode)) invalid("Choose Ask, Always allow, or inherit", "defaultApprovalMode");
      return input as ConfigurationValues;
    }, target: () => "security.default_approval",
    preview: (input, snapshot, scope) => {
      const defaults = snapshot.data.defaultApproval as { global: Mode; project: Mode }, current = defaults[scope.kind === "project" ? "project" : "global"];
      const next = (input.defaultApprovalMode ?? current) as Mode;
      const inherited = scope.kind === "project" && defaults.global !== "inherit" ? defaults.global : "ask_for_dangerous";
      const effective = next === "inherit" ? inherited : next;
      const statement = `Independent human security decision: new sessions ${scope.kind === "project" ? "in this Project" : "inheriting this global default"} will default to ${effective}. Always allow stops asking for eligible tools; direct-code exceptions and network restrictions still apply. Existing sessions, pending tool approvals, grants and Permission Epochs are unchanged.`;
      const changes = next === current ? [] : [{ field: "defaultApprovalMode", before: current, after: next }];
      return { fields: [{ id: "defaultApprovalMode", label: "New-session tool approval", kind: "enum", required: true, value: next, choices: [
        { id: "ask_for_dangerous", label: "Ask for dangerous actions" }, { id: "always_allow", label: "Always allow eligible tools" }, { id: "inherit", label: scope.kind === "project" ? "Inherit the global default" : "Use built-in Ask default" },
      ] }], changes, impact: { resourceLocation: scope.kind === "project" ? "Project settings defaultApprovalMode" : "Global settings defaultApprovalMode", effectiveScope: scope.kind === "project" ? "New sessions in this Project" : "New sessions inheriting the global default",
        message: `${statement} Removing an override affects later parent-default changes. No existing execution is authorized, no kernels are retired, and no task is resumed. Auto-apply-low-risk configuration and current Session approval mode stay unchanged. Only the selected default field changes; create a new Session to use it.` },
        securityConsent: { targetDigest: digest([next, effective, scope, snapshot.resourceVersions]), statement },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_run",
        disposition: !Object.keys(input).length ? "missing_input" : changes.length ? "change" : "no_change", ready: changes.length > 0 };
    },
    apply: context => {
      store.applyDefaultApprovalConfigurationSync(context.sessionId, context.scope, context.input.defaultApprovalMode as Mode);
      return { resourceRevision: digest(store.configurationSnapshot(context.sessionId, "security.default_approval", "security.default_approval").resourceVersions), summary: "Approval default saved for new sessions; existing permissions are unchanged" };
    },
  };
}
