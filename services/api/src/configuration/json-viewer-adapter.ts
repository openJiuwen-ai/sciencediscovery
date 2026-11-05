// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationAdapter } from "./types.js";
import { ConfigurationError, digest, invalid, object } from "./validation.js";
const modes = ["enabled", "disabled", "inherit"] as const;
export function createJsonViewerAdapter(store: SessionStore): ConfigurationAdapter {
  return {
    id: "plugin.json_viewer", version: 1, schemaVersion: 1, scopes: ["global", "project", "session"], persistence: "local_transaction",
    normalize: raw => {
      const input = object(raw, ["mode"], "values"), output: ConfigurationValues = {};
      if (input.mode !== undefined) {
        if (typeof input.mode !== "string" || !modes.some(mode => mode === input.mode)) {
          invalid("Choose enabled, disabled or inherit", "mode");
        }
        output.mode = input.mode;
      }
      return output;
    },
    target: () => "artifact-json",
    preview: (input, snapshot, scope) => {
      const source = snapshot.data.jsonViewerSettings as ReturnType<SessionStore["configurationJsonViewerSettings"]>;
      if (!source.installed) throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "The bundled optional JSON viewer is not installed", 409);
      const before = source.modes[scope.kind], value = String(input.mode ?? before), inherited = source.inherited[scope.kind];
      const changes = input.mode !== undefined && value !== before ? [{ field: "mode", before, after: value }] : [];
      return {
        fields: [{ id: "mode", label: "JSON viewer mode", kind: "enum", required: true, value,
          choices: [{ id: "enabled", label: "Enabled" }, { id: "disabled", label: "Disabled" }, { id: "inherit", label: `Inherit (${inherited ? "enabled" : "disabled"})` }] }],
        changes,
        impact: { resourceLocation: "Bundled JSON artifact viewer", effectiveScope: scope.kind === "global" ? "Global default for inheriting Projects and Sessions" : scope.kind === "project" ? `Project ${scope.id} and its inheriting Sessions` : `Session ${scope.id}`,
          message: "Only the optional JSON viewer override at this scope changes. inherit removes this layer's explicit flag; Global falls back to the built-in enabled default. Lower-level overrides keep precedence. Existing files, raw JSON and generic source previews remain available. Other plugins/settings, installed code and permissions stay unchanged. Open UI hosts may refresh through their normal subscription; saving does not prove every client has refreshed. Already queued runs keep their frozen composition. The settings writer performs no installation, model request or file deletion. A bound original configuration wait may continue through the framework; activation timing and execution permissions remain separate." },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_run",
        disposition: input.mode === undefined ? "missing_input" : changes.length ? "change" : "no_change", ready: changes.length > 0,
      };
    },
    apply: context => {
      store.applyJsonViewerConfigurationSync(context.sessionId, context.input.mode as typeof modes[number], context.scope);
      return { resourceRevision: digest(store.configurationSnapshot(context.sessionId, "plugin.json_viewer", "artifact-json").resourceVersions), summary: "JSON viewer override saved; client refresh is separate" };
    },
  };
}
