// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { SessionStore } from "../store.js";
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { ConfigurationAdapter } from "./types.js";
import { digest, invalid, object } from "./validation.js";

export function createReviewerEnableAdapter(store: SessionStore): ConfigurationAdapter {
  return {
    id: "reviewer.enable", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    normalize: (raw): ConfigurationValues => {
      const input = object(raw, ["enabled"], "values");
      if (input.enabled === undefined) return {};
      if (typeof input.enabled !== "boolean") invalid("Choose whether global Reviewer Specialist is enabled", "enabled");
      return { enabled: input.enabled };
    },
    target: () => "reviewer.enable",
    preview: (input, snapshot) => {
      const current = snapshot.data.globalReviewer as ReturnType<SessionStore["getReviewerSpecialistSettings"]>;
      const changed = typeof input.enabled === "boolean" && input.enabled !== current.enabled;
      const enabled = typeof input.enabled === "boolean" ? input.enabled : current.enabled;
      return { fields: [{ id: "enabled", label: "Enable global Reviewer Specialist", kind: "boolean", required: true, value: enabled }],
        changes: changed ? [{ field: "enabled", before: current.enabled ? "Enabled" : "Disabled", after: enabled ? "Enabled" : "Disabled" }] : [],
        impact: { resourceLocation: "Deployment Reviewer Specialist settings", effectiveScope: "Every session using Reviewer Specialist",
          message: `Global switch; manual confirmation required. Existing feedback policy stays ${current.feedbackPolicy}. Enabling permits subsequent review admission under existing session preferences and feedback policy; configured review models may charge and existing feedback actions retain their normal permission checks. Disabling also suppresses queued reviews before execution, but already-started operations may finish. Session review levels, automatic/semantic preferences, model choices and review history are unchanged. This switch does not requeue historical review jobs or unrelated research tasks. A bound original configuration wait may continue through the framework; activation timing and execution permissions remain separate.` },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_request",
        disposition: input.enabled === undefined ? "missing_input" : changed ? "change" : "no_change", ready: changed };
    },
    apply: context => {
      const enabled = context.input.enabled;
      if (typeof enabled !== "boolean") invalid("Choose whether global Reviewer Specialist is enabled", "enabled");
      store.applyReviewerParticipationSync(enabled);
      return { resourceRevision: digest(store.configurationSnapshot(context.sessionId, "reviewer.enable", "reviewer.enable").resourceVersions),
        summary: "Global Reviewer Specialist switch saved for subsequent review admission; historical review jobs are not requeued; a bound original configuration wait may continue" };
    },
  };
}
