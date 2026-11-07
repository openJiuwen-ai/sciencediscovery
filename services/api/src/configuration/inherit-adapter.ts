// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationValues } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import type { ConfigurationAdapter } from "./types.js";
import { INHERITABLE_CONFIGURATION_FIELDS } from "./inherit-fields.js";
import { ConfigurationError, digest, invalid, object } from "./validation.js";
const labels: Record<string, string> = { modelId: "Task model", reviewModelId: "Review model", semanticReviewEnabled: "Semantic review", thinkingMode: "Thinking mode", thinkingEffort: "Thinking effort", enabledConnectorIds: "Connector selection", skillSelectionMode: "Skill selection mode", enabledSkillIds: "Skill selection", enabledSkillLibraries: "Pinned Skill Libraries" };
function summary(value: unknown): string {
  if (value === undefined) return "Built-in default / not set";
  if (Array.isArray(value)) {
    const sample = value.slice(0, 3).map(item => {
      const text = typeof item === "string" ? item : JSON.stringify(item);
      return text.length <= 400 ? text : "Long selection (see catalog)";
    });
    return `${value.length} selections${value.length ? ` · ${sample.join(", ")}${value.length > 3 ? ", …" : ""}` : ""}`;
  }
  return String(value);
}
export function createInheritanceAdapter(store: SessionStore): ConfigurationAdapter {
  return {
    id: "settings.inherit", version: 1, schemaVersion: 1, scopes: ["session", "project"], persistence: "local_transaction",
    normalize: raw => {
      const input = object(raw, ["selectedFields"], "values"), output: ConfigurationValues = {};
      if (input.selectedFields !== undefined) {
        if (!Array.isArray(input.selectedFields) || input.selectedFields.length > INHERITABLE_CONFIGURATION_FIELDS.length || new Set(input.selectedFields).size !== input.selectedFields.length || input.selectedFields.some(field => typeof field !== "string" || !(INHERITABLE_CONFIGURATION_FIELDS as readonly string[]).includes(field))) {
          invalid("Choose only ordinary settings from the finite inheritance list", "selectedFields");
        }
        output.selectedFields = [...input.selectedFields].sort();
      }
      return output;
    },
    target: () => "ordinary-settings",
    preview: (input, snapshot, scope) => {
      const selected = input.selectedFields as string[] | undefined ?? [];
      if (selected.some(field => field.startsWith("skill") || field.startsWith("enabledSkill")) && !snapshot.data.skillSelectionAvailable) {
        throw new ConfigurationError("CONFIGURATION_BACKEND_UNSUPPORTED", "This backend uses a shared Skill catalog and cannot restore scoped Skill selections", 409, "selectedFields");
      }
      const candidate = store.configurationInheritanceCandidate(String(snapshot.data.sessionId ?? ""), scope, selected);
      const changes = INHERITABLE_CONFIGURATION_FIELDS.filter(field => selected.includes(field) && Object.hasOwn(candidate.before, field)).map(field => ({ field, before: summary(candidate.before[field]), after: `Inherit (${candidate.sources[field]}): ${summary(candidate.effective[field])}` }));
      return { fields: [{ id: "selectedFields", label: "Ordinary settings to inherit", kind: "multiselect", required: true, value: selected,
        choices: INHERITABLE_CONFIGURATION_FIELDS.filter(field => snapshot.data.skillSelectionAvailable || !field.startsWith("skill") && !field.startsWith("enabledSkill")).map(id => ({ id, label: labels[id] ?? id })) }], changes,
        impact: { resourceLocation: "Ordinary runtime setting overrides", effectiveScope: scope.kind === "project" ? `Project ${scope.id} and its inheriting Sessions` : `Session ${scope.kind === "session" ? scope.id : ""}`,
          message: "Only selected explicit ordinary overrides at this layer are removed. Even an equal explicit value becomes inherited; unselected fields and lower-level overrides remain. Project changes affect inheriting Sessions. An inherited Skill all mode can make more installed content available. Collection previews show counts and a bounded sample; the complete inherited selection stays bound to this approved snapshot. Security/approval/network/automatic policies, plugin JSON, credentials and Runner resources are not reset. Already queued/frozen runs stay unchanged. The settings writer performs no model/tool call, install or permission grant. A bound original configuration wait may continue through the framework; activation timing and execution permissions remain separate." },
        verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, activationMode: "next_run", disposition: !selected.length ? "missing_input" : changes.length ? "change" : "no_change", ready: changes.length > 0 };
    },
    apply: context => {
      store.applyConfigurationInheritanceSync(context.sessionId, context.scope, context.input.selectedFields as string[]);
      return { resourceRevision: digest(store.configurationSnapshot(context.sessionId, "settings.inherit", "ordinary-settings").resourceVersions), summary: "Selected ordinary overrides removed; future runs inherit their parent/default values" };
    },
  };
}
