// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { SessionStore } from "../store.js";
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { ConfigurationAdapter } from "./types.js";
import { digest, invalid, object } from "./validation.js";

export function createMemoryBackendAdapter(store: SessionStore): ConfigurationAdapter {
  return {
    id: "memory.backend", version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    normalize: (raw): ConfigurationValues => {
      const input = object(raw, ["backend"], "values");
      if (input.backend === undefined) return {};
      if (input.backend !== "local" && input.backend !== "neo4j") invalid("Choose local or Neo4j", "backend");
      return { backend: input.backend };
    },
    target: () => "memory.backend",
    preview: (input, snapshot) => {
      const current = snapshot.data.memoryGraph as ReturnType<SessionStore["configurationMemoryGraph"]>;
      const backend = input.backend === "local" || input.backend === "neo4j" ? input.backend : current.backend;
      const changed = input.backend !== undefined && backend !== current.backend;
      return { fields: [{ id: "backend", label: "Workbench memory graph backend", kind: "enum", required: true, value: backend,
        choices: [{ id: "local", label: "Local graph" }, { id: "neo4j", label: "Configured Neo4j" }] }],
        changes: changed ? [{ field: "backend", before: current.backend, after: backend }] : [],
        impact: { resourceLocation: "Deployment MemoryGraph settings", effectiveScope: "Every session using the workbench memory graph",
          message: `Existing Neo4j destination: ${current.destinationHost}. Participation stays ${current.enabled ? "enabled" : "disabled"}. Changing the backend can change which graph data is visible; existing data is retained with no migration. Neo4j may receive subsequent research context and its existing stored credentials. Connection fields and password are unchanged. Saving does not call the sidecar, verify readiness. A bound original configuration wait may continue through the framework; activation timing and execution permissions remain separate. An operator restart of API/MemoryGraph is needed for consistent runtime configuration; the existing settings-refresh self-heal may select Neo4j earlier. No restart or installation is performed here.` },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "requires_restart",
        disposition: input.backend === undefined ? "missing_input" : changed ? "change" : "no_change", ready: changed };
    },
    apply: context => {
      const backend = context.input.backend;
      if (backend !== "local" && backend !== "neo4j") invalid("Choose local or Neo4j", "backend");
      store.applyMemoryGraphBackendSync(backend);
      return { resourceRevision: digest(store.configurationSnapshot(context.sessionId, "memory.backend", "memory.backend").resourceVersions),
        summary: "Memory graph backend selection saved; runtime readiness and consistent restart remain unverified" };
    },
  };
}
