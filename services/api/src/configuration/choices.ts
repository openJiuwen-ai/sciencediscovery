// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationChoiceOptionView, ConfigurationChoiceReceipt } from "@sciencediscovery/schema";
import type { ConfigurationPlan, ConfigurationRecord } from "./types.js";
import { ConfigurationError, invalid, object, string } from "./validation.js";

/** Finite, server-owned choices. Candidate text/commands supplied by the Agent are never accepted. */
export function normalizeChoices(raw: ConfigurationChoiceOptionView[]): ConfigurationChoiceOptionView[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 8) invalid("Invalid configuration choices");
  const ids = new Set<string>();
  const result = raw.map(item => {
    const value = object(item, ["id", "kind", "label", "description", "available", "unavailableReason", "alternativeId"], "choice");
    const id = string(value.id, "optionId", 100);
    if (!/^[a-z][a-z0-9_.-]*$/.test(id) || ids.has(id)) invalid("Invalid or duplicate configuration option");
    ids.add(id);
    if (!["persisted_apply", "run_overlay", "alternative", "dismiss"].includes(String(value.kind)) || typeof value.available !== "boolean") invalid("Invalid configuration option kind");
    if (value.kind === "alternative" && (!value.alternativeId || !/^[a-z][a-z0-9_.-]*$/.test(String(value.alternativeId)))) invalid("A registered alternative is required");
    if (value.kind !== "alternative" && value.alternativeId !== undefined) invalid("Only alternative choices may specify a path");
    return { id, kind: value.kind as ConfigurationChoiceOptionView["kind"], label: string(value.label, "choice.label", 200), description: string(value.description, "choice.description", 2000), available: value.available,
      ...(value.unavailableReason !== undefined ? { unavailableReason: string(value.unavailableReason, "choice.unavailableReason", 1000) } : {}),
      ...(value.alternativeId !== undefined ? { alternativeId: string(value.alternativeId, "alternativeId", 100) } : {}) };
  });
  if (result.filter(option => option.kind === "dismiss" && option.available).length !== 1 || result.filter(option => option.kind === "persisted_apply").length !== 1) invalid("Choices require one persistent option and one available dismissal");
  return result;
}
export function defaultChoices(): ConfigurationChoiceOptionView[] {
  return [{ id: "persist", kind: "persisted_apply", label: "Save this configuration", description: "Apply the change to the displayed saved settings scope.", available: true },
    { id: "dismiss", kind: "dismiss", label: "Continue without configuring", description: "Do not change settings; return this choice to the original task.", available: true }];
}
export function selectedChoice(record: ConfigurationRecord): ConfigurationChoiceOptionView | undefined {
  return record.view.options?.find(option => option.id === record.view.selectedOptionId);
}
export function choosePlan(plan: ConfigurationPlan, option: ConfigurationChoiceOptionView): ConfigurationPlan {
  if (!option.available) throw new ConfigurationError("CONFIGURATION_OPTION_UNAVAILABLE", option.unavailableReason ?? "This configuration option is unavailable", 409);
  if (option.kind === "persisted_apply") return plan;
  if (option.kind === "run_overlay") return { ...plan,
    impact: { resourceLocation: "Isolated task overlay", effectiveScope: "This task only", message: "Saved session, project and global settings stay unchanged. The temporary capability is unavailable to later tasks." },
    changes: plan.changes.map(change => ({ ...change, field: `run.${change.field}` })) };
  return { ...plan, ready: true, fields: [], changes: [], verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false },
    impact: { resourceLocation: "No saved configuration", effectiveScope: "This task decision", message: option.description } };
}
export function makeChoiceReceipt(record: ConfigurationRecord): ConfigurationChoiceReceipt | undefined {
  const option = selectedChoice(record);
  if (!option) return undefined;
  return { optionId: option.id, kind: option.kind, label: option.label, configurationWritten: option.kind === "persisted_apply", scope: option.kind === "persisted_apply" ? record.view.scope.kind : option.kind === "run_overlay" ? "run" : "none",
    ...(record.view.runId ? { runId: record.view.runId } : {}), ...(option.alternativeId ? { alternativeId: option.alternativeId } : {}) };
}
export function projectChoiceReceipt(receipt: ConfigurationChoiceReceipt): ConfigurationChoiceReceipt {
  return { optionId: receipt.optionId, kind: receipt.kind, label: receipt.label, configurationWritten: receipt.configurationWritten, scope: receipt.scope,
    ...(receipt.runId ? { runId: receipt.runId } : {}), ...(receipt.alternativeId ? { alternativeId: receipt.alternativeId } : {}) };
}
