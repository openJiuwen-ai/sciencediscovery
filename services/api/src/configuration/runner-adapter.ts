// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationFieldView, ConfigurationValues } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationAdapter } from "./types.js";
import { canonical, ConfigurationError, invalid, object } from "./validation.js";

export function createRunnerConfigurationAdapter(store: SessionStore): ConfigurationAdapter {
  return {
    id: "runner.assign", version: 1, schemaVersion: 1, scopes: ["project", "session"], persistence: "local_transaction",
    normalize: (raw): ConfigurationValues => {
      const input = object(raw, ["selectionMode", "runnerIds"], "values");
      if (!Object.keys(input).length) return {};
      const mode = input.selectionMode ?? "selected";
      if (mode !== "inherit" && mode !== "selected") invalid("Choose selected or inherit", "selectionMode");
      if (input.runnerIds !== undefined && (!Array.isArray(input.runnerIds) || input.runnerIds.length > 500
        || new Set(input.runnerIds).size !== input.runnerIds.length || input.runnerIds.some(id => typeof id !== "string" || !id || id.length > 200 || id.trim() !== id))) invalid("Expected unique registered Runner IDs", "runnerIds");
      if (mode === "selected" && input.runnerIds === undefined) invalid("Selected mode requires an explicit Runner list; [] disables all Runners", "runnerIds");
      if (mode === "inherit" && Array.isArray(input.runnerIds) && input.runnerIds.length) invalid("Inherited mode cannot also select Runners", "runnerIds");
      return { selectionMode: mode, runnerIds: [...((input.runnerIds as string[] | undefined) ?? [])].sort() };
    },
    target: () => "runner.assign",
    preview: (input, snapshot, scope) => {
      const selection = snapshot.data.runnerSelection as ReturnType<SessionStore["configurationRunnerSelection"]>;
      const resources = snapshot.data.runnerResources as ReturnType<SessionStore["configurationRunnerResources"]>;
      if (scope.kind === "project" && input.selectionMode === "inherit") invalid("Project Runner defaults do not inherit from another scope", "selectionMode");
      if (Array.isArray(input.runnerIds) && input.runnerIds.some(id => !resources.some(item => item.id === id && item.available)))
        throw new ConfigurationError("CONFIGURATION_RESOURCE_UNAVAILABLE", "A selected Runner is not registered or usable", 409, "runnerIds");
      const current: ConfigurationValues = scope.kind === "project" ? { selectionMode: "selected", runnerIds: selection.projectRunnerIds }
        : { selectionMode: selection.selectionMode, runnerIds: selection.runnerIds };
      const values = { ...current, ...input };
      const selected = values.runnerIds as string[];
      const choices = [...new Set([...selected, ...resources.filter(item => item.available).map(item => item.id)])].slice(0, 500)
        .map(id => ({ id, label: resources.find(item => item.id === id)?.name ?? id }));
      const fields: ConfigurationFieldView[] = [
        { id: "selectionMode", label: "Runner selection mode", kind: "enum", required: false, value: String(values.selectionMode),
          choices: (scope.kind === "project" ? ["selected"] : ["selected", "inherit"]).map(id => ({ id, label: id })) },
        { id: "runnerIds", label: "Registered Runner IDs", kind: "multiselect", required: false, value: selected, choices,
          description: "Selected + [] disables all Runner execution. Inherit requires an empty list and follows Project defaults." },
      ];
      const changes = Object.entries(input).filter(([field, value]) => canonical(current[field]) !== canonical(value))
        .map(([field, value]) => ({ field, before: JSON.stringify(current[field]), after: JSON.stringify(value) }));
      return { fields, changes, impact: { resourceLocation: scope.kind === "project" ? "Project Runner defaults" : "Session Runner selection",
        effectiveScope: scope.kind === "project" ? "This project and sessions that inherit its Runner selection" : "This session only",
        message: "Only registered Runner selection changes. Selected + [] disables all Runners; Session inherit removes the override. Project defaults do not replace explicit Session overrides. Saving does not grant execution permission, register a host, accept an SSH host key, test connectivity, migrate or cancel running work, or rewrite queued run snapshots. Subsequent execution admission uses the formal selection: removing a Runner may block later calls; new selections are visible when execution is next assembled. Catalog usability is not a live connectivity check." },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_run",
        disposition: !Object.keys(input).length ? "missing_input" : changes.length ? "change" : "no_change", ready: changes.length > 0 };
    },
    apply: context => {
      store.applyRunnerConfigurationSync(context.sessionId, context.scope, context.input.selectionMode as "inherit" | "selected", context.input.runnerIds as string[]);
      return { summary: "Runner selection saved; execution permissions and existing jobs were not changed" };
    },
  };
}
