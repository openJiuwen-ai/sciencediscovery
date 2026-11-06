// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { SessionStore } from "../store.js";
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { ConfigurationAdapter } from "./types.js";
import { digest, invalid, object } from "./validation.js";

/** The workbench MemoryGraph gate, not an Agent's independent memory or a backend connection test. */
export function createMemoryEnableAdapter(store: SessionStore): ConfigurationAdapter {
  return {
    id: "memory.enable", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    normalize: (raw): ConfigurationValues => {
      const input = object(raw, ["enabled"], "values");
      if (input.enabled === undefined) return {};
      if (typeof input.enabled !== "boolean") invalid("Choose whether workbench MemoryGraph is enabled", "enabled");
      return { enabled: input.enabled };
    },
    target: () => "memory.enable",
    preview: (input, snapshot) => {
      const current = snapshot.data.memoryGraph as ReturnType<SessionStore["configurationMemoryGraph"]>;
      const changed = typeof input.enabled === "boolean" && input.enabled !== current.enabled;
      const enabled = typeof input.enabled === "boolean" ? input.enabled : current.enabled;
      return { fields: [{ id: "enabled", label: "Enable workbench memory graph", kind: "boolean", required: true, value: enabled }],
        changes: changed ? [{ field: "enabled", before: current.enabled ? "Enabled" : "Disabled", after: input.enabled ? "Enabled" : "Disabled" }] : [],
        impact: { resourceLocation: "Deployment MemoryGraph settings", effectiveScope: "Every session using the workbench memory graph",
          message: `Configured backend: ${current.backend} (${current.destinationHost}). Manual confirmation required. Enabling permits subsequent research-memory operations to use that existing backend and its stored credentials. Disabling stops subsequent gated operations; in-flight requests may finish and stored graph data is retained. This does not disable every Agent's independent memory, change backend/credentials, install a service or verify readiness.` },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_request",
        disposition: input.enabled === undefined ? "missing_input" : changed ? "change" : "no_change", ready: changed };
    },
    apply: context => {
      const enabled = context.input.enabled;
      if (typeof enabled !== "boolean") invalid("Choose whether workbench MemoryGraph is enabled", "enabled");
      store.applyMemoryGraphParticipationSync(enabled);
      return { resourceRevision: digest(store.configurationSnapshot(context.sessionId, "memory.enable", "memory.enable").resourceVersions),
        summary: "Memory graph participation saved for subsequent operations; backend readiness remains unverified" };
    },
  };
}
