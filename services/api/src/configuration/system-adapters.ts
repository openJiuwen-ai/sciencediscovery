// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createHash } from "node:crypto";
import type { ConfigurationCapabilityId, ConfigurationFieldView, ConfigurationValues, IdeaTreeSettings, SystemQuotaSettings, SystemTimeoutSettings } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import { normalizeIdeaTreeSettings, normalizeQuotaSettings, normalizeTimeoutSettings, resolveIdeaTreeSettings } from "../store/settings.js";
import { CONFIGURATION_AGENT_DESCRIPTORS, SYSTEM_CONFIGURATION_CAPABILITIES } from "./agent-metadata.js";
import type { ConfigurationAdapter, ConfigurationSnapshot } from "./types.js";
import { ConfigurationError, invalid, object } from "./validation.js";

const noProbe = { targets: [] as string[], actions: [] as string[], maxRequests: 0, mayCharge: false };
const intensities = ["quick", "standard", "deep"] as const;
const directions = ["maximize", "minimize"] as const;

function domainError(error: unknown): never {
  const message = error instanceof Error ? error.message : "Invalid system setting";
  throw new ConfigurationError("INVALID_CONFIGURATION_INPUT", message, 400);
}

function integerValue(value: unknown, name: string, minimum: number, maximum?: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || (maximum !== undefined && value > maximum)) {
    invalid(maximum === undefined ? `${name} must be an integer of at least ${minimum}` : `${name} must be an integer from ${minimum} to ${maximum}`, name);
  }
  return value;
}

function normalized(id: ConfigurationCapabilityId, raw: unknown): ConfigurationValues {
  const descriptor = CONFIGURATION_AGENT_DESCRIPTORS[id];
  const input = object(raw, Object.keys(descriptor.fields), "values");
  const output: ConfigurationValues = {};
  for (const [key, value] of Object.entries(input)) {
    const field = descriptor.fields[key]!;
    if (field.kind === "integer") output[key] = integerValue(value, key, field.minimum ?? 0, field.maximum);
    else if (typeof value === "string" && field.choices?.includes(value)) output[key] = value;
    else invalid("Invalid registered setting", key);
  }
  return output;
}

function numberField(id: string, label: string, value: number, description: string): ConfigurationFieldView {
  return { id, label, kind: "number", required: false, value, description };
}
function enumField(id: string, label: string, choices: readonly string[], value: string): ConfigurationFieldView {
  return { id, label, kind: "enum", required: false, value, choices: choices.map(choice => ({ id: choice, label: choice })) };
}

function currentTimeouts(snapshot: ConfigurationSnapshot): SystemTimeoutSettings {
  return normalizeTimeoutSettings(snapshot.data.timeoutSettings);
}
function currentQuotas(snapshot: ConfigurationSnapshot): SystemQuotaSettings {
  return normalizeQuotaSettings(snapshot.data.quotaSettings);
}
function currentIdeaTree(snapshot: ConfigurationSnapshot): IdeaTreeSettings {
  return resolveIdeaTreeSettings(snapshot.data.ideaTreeSettings);
}

function changed(input: ConfigurationValues, current: object): Array<{ field: string; before: string; after: string }> {
  const source = current as Record<string, unknown>;
  return Object.entries(input).filter(([field, value]) => source[field] !== value)
    .map(([field, value]) => ({ field, before: JSON.stringify(source[field] ?? null), after: JSON.stringify(value) }));
}

export function createSystemConfigurationAdapters(store: SessionStore): ConfigurationAdapter[] {
  const checked = (id: ConfigurationCapabilityId, input: ConfigurationValues, snapshot: ConfigurationSnapshot): void => {
    try {
      if (id === "timeouts.configure") normalizeTimeoutSettings({ ...currentTimeouts(snapshot), ...input });
      else if (id === "quotas.configure") normalizeQuotaSettings({ ...currentQuotas(snapshot), ...input });
      else normalizeIdeaTreeSettings(input, currentIdeaTree(snapshot));
    } catch (error) { domainError(error); }
  };
  return SYSTEM_CONFIGURATION_CAPABILITIES.map((id): ConfigurationAdapter => ({
    id, version: 1, schemaVersion: 1, scopes: ["global"], persistence: "local_transaction",
    normalize: raw => normalized(id, raw),
    target: () => id,
    preview: (input, snapshot) => {
      checked(id, input, snapshot);
      const fields: ConfigurationFieldView[] = [];
      let message: string;
      if (id === "timeouts.configure") {
        const current = { ...currentTimeouts(snapshot), ...input };
        message = "Deployment-wide. A run keeps the timeouts it read when it started; a later run reads the saved values. 0 disables that one limit. A single timeout is not a reason to remove a limit.";
        fields.push(
          numberField("gatewayIdleTimeoutMs", "Gateway idle timeout (ms)", current.gatewayIdleTimeoutMs, "0 disables the idle limit."),
          numberField("gatewayTurnTimeoutMs", "Gateway turn timeout (ms)", current.gatewayTurnTimeoutMs, "0 disables the turn limit. When both are set, the turn limit is at least the idle limit."),
          numberField("kernelIdleTimeoutMs", "Kernel idle timeout (ms)", current.kernelIdleTimeoutMs, "0 disables the kernel idle limit."),
          numberField("permissionWaitTimeoutMs", "Permission wait timeout (ms)", current.permissionWaitTimeoutMs, "0 disables the permission-wait limit."),
          numberField("runnerExecTimeoutMs", "Runner execution timeout (ms)", current.runnerExecTimeoutMs, "0 disables the runner execution limit."),
        );
      } else if (id === "quotas.configure") {
        const current = { ...currentQuotas(snapshot), ...input };
        message = "Deployment-wide. A later run reads these limits when it starts. 0 on a byte field removes that cap. Concurrent subagents stay from 1 to 10.";
        fields.push(
          numberField("maxConcurrentSubagents", "Concurrent subagents", current.maxConcurrentSubagents ?? 10, "Integer from 1 to 10."),
          numberField("runnerMaxOutputBytes", "Runner output cap (bytes)", current.runnerMaxOutputBytes, "0 removes the output cap."),
          numberField("runnerMaxWorkspaceBytes", "Runner workspace cap (bytes)", current.runnerMaxWorkspaceBytes, "0 removes the workspace cap."),
          numberField("uploadMaxFileBytes", "Upload file cap (bytes)", current.uploadMaxFileBytes, "0 removes the per-file cap."),
          numberField("uploadMaxRequestBytes", "Upload request cap (bytes)", current.uploadMaxRequestBytes, "0 removes the request cap."),
        );
      } else {
        const current = normalizeIdeaTreeSettings(input, currentIdeaTree(snapshot));
        message = "Deployment-wide. A later idea-tree invocation reads these limits. Template and exploration intensity choose research budgets and assessor definitions. An idea-tree run already in progress keeps the settings it started with.";
        fields.push(
          enumField("explorationIntensity", "Exploration intensity", intensities, current.explorationIntensity),
          enumField("scoreDirection", "Score direction", directions, current.scoreDirection),
          numberField("maxTokensPerCall", "Tokens per call", current.maxTokensPerCall ?? 32768, "Integer from 256 to 32768."),
          numberField("maxDepth", "Maximum depth", current.maxDepth, "Integer from 1 to 20."),
          numberField("maxNodes", "Maximum nodes", current.maxNodes, "Integer from 2 to 10000."),
        );
      }
      const current = id === "timeouts.configure" ? currentTimeouts(snapshot) : id === "quotas.configure" ? currentQuotas(snapshot) : currentIdeaTree(snapshot);
      const changes = changed(input, current);
      return { fields, changes, impact: { resourceLocation: "Deployment system settings", effectiveScope: "Every session in this deployment", message },
        verificationPlan: noProbe, activationMode: "next_run", disposition: !Object.keys(input).length ? "missing_input" : changes.length ? "change" : "no_change", ready: changes.length > 0 };
    },
    apply: context => {
      try { store.applySystemConfigurationSync(id, context.input); }
      catch (error) {
        if (error instanceof Error && error.message.includes("shared transaction")) throw error;
        domainError(error);
      }
      return { resourceRevision: createHash("sha256").update(JSON.stringify(store.configurationSnapshot(context.sessionId, id, id).resourceVersions)).digest("hex"),
        summary: "Deployment settings saved for later runs" };
    },
  }));
}
