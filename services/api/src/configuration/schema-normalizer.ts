// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ConfigurationFieldView, ConfigurationValues } from "@sciencediscovery/schema";
import { displayText, invalid, object, string } from "./validation.js";

export interface ConfigurationSchemaPolicy {
  /** Exact registered static hosts. Never provided by a model or a form submission. */
  helpHosts?: readonly string[];
  credentialFields?: readonly string[];
}
function help(value: unknown, policy: ConfigurationSchemaPolicy): { label: string; url: string } | undefined {
  if (value === undefined) return undefined;
  const item = object(value, ["label", "url"], "help");
  let url: URL;
  try { url = new URL(string(item.url, "help.url")); } catch { return invalid("Invalid static help URL"); }
  if (url.protocol !== "https:" || url.username || url.password || !policy.helpHosts?.includes(url.hostname) || url.hash || url.search) invalid("Unapproved static help URL");
  return { label: string(item.label, "help.label", 200), url: url.href };
}
/** Normalize the supported WorkSwarm text/password contract; unsupported types fail closed. */
export function normalizeTokenSchema(source: unknown, policy: ConfigurationSchemaPolicy = {}): ConfigurationFieldView[] {
  if (!Array.isArray(source) || source.length > 64) invalid("Invalid token schema");
  const ids = new Set<string>();
  const fields = source.map((value): ConfigurationFieldView => {
    const field = object(value, ["key", "label", "type", "required", "default", "description", "placeholder", "help"], "schema");
    const id = string(field.key, "key", 100);
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/u.test(id) || ids.has(id)) invalid("Duplicate or invalid schema key", id);
    ids.add(id);
    if (field.required !== undefined && typeof field.required !== "boolean") invalid("Invalid required flag", id);
    if (field.type !== "text" && field.type !== "password") invalid("Unsupported token schema type", id);
    const base = { id, label: string(field.label, "label", 200), required: field.required === true,
      ...(field.description !== undefined ? { description: string(field.description, "description", 2000) } : {}),
      ...(field.type === "text" && field.placeholder !== undefined ? { placeholder: string(field.placeholder, "placeholder", 500) } : {}),
      ...(field.help !== undefined ? { help: help(field.help, policy) } : {}) };
    if (field.type === "password") {
      if (policy.credentialFields && !policy.credentialFields.includes(id)) invalid("Credential placeholder does not match registered fields", id);
      // Password defaults/placeholders are intentionally never copied into views.
      return { ...base, kind: "credential", status: "missing" };
    }
    if (policy.credentialFields?.includes(id)) invalid("Registered credential field must use password type", id);
    return { ...base, kind: "text", ...(field.default !== undefined ? { value: displayText(field.default, "default", 8192) } : {}) };
  });
  if (policy.credentialFields?.some((id) => !ids.has(id))) invalid("Credential placeholder missing from schema");
  return fields;
}
/** Whitelist projection also validates server adapters; credential fields cannot acquire a value. */
export function normalizeConfigurationFields(source: unknown, policy: ConfigurationSchemaPolicy = {}): ConfigurationFieldView[] {
  if (!Array.isArray(source) || source.length > 64) invalid("Invalid configuration fields");
  const ids = new Set<string>();
  return source.map((value): ConfigurationFieldView => {
    const candidate = object(value, ["id", "label", "required", "description", "placeholder", "help", "kind", "status", "value", "choices"], "field");
    const id = string(candidate.id, "field.id", 100);
    if (ids.has(id) || !/^[a-zA-Z][a-zA-Z0-9_.-]*$/u.test(id)) invalid("Duplicate or invalid field id", id);
    ids.add(id);
    if (typeof candidate.required !== "boolean") invalid("Invalid required field", id);
    const base = { id, label: string(candidate.label, "field.label", 200), required: candidate.required,
      ...(candidate.description !== undefined ? { description: string(candidate.description, "field.description", 2000) } : {}),
      ...(candidate.placeholder !== undefined ? { placeholder: string(candidate.placeholder, "field.placeholder", 500) } : {}),
      ...(candidate.help !== undefined ? { help: help(candidate.help, policy) } : {}) };
    if (candidate.kind === "credential") {
      if (candidate.value !== undefined || candidate.choices !== undefined || candidate.placeholder !== undefined) invalid("Credential fields cannot contain values", id);
      if (!["missing", "provided", "expired"].includes(String(candidate.status))) invalid("Invalid credential status", id);
      return { ...base, kind: "credential", status: candidate.status as "missing" | "provided" | "expired" };
    }
    if (!["text", "url", "number", "boolean", "enum", "multiselect"].includes(String(candidate.kind)) || candidate.status !== undefined) invalid("Unsupported field kind", id);
    const kind = candidate.kind as "text" | "url" | "number" | "boolean" | "enum" | "multiselect";
    let choices: Array<{ id: string; label: string }> | undefined;
    if (candidate.choices !== undefined) {
      if (!["enum", "multiselect"].includes(kind) || !Array.isArray(candidate.choices) || candidate.choices.length > 500) invalid("Invalid choices", id);
      const seen = new Set<string>();
      choices = candidate.choices.map((entry) => {
        const item = object(entry, ["id", "label"], "choice");
        const key = string(item.id, "choice.id", 500);
        if (seen.has(key)) { invalid("Duplicate enum choice", id); }
        seen.add(key);
        return { id: key, label: string(item.label, "choice.label", 500) };
      });
    }
    if (kind === "multiselect") {
      if (!choices) invalid("Multiselect requires finite choices", id);
      if (candidate.value !== undefined) validateIds(candidate.value, choices, id);
      return { ...base, kind, choices, ...(candidate.value !== undefined ? { value: [...candidate.value as string[]] } : {}) };
    }
    if (candidate.value !== undefined) {
      if (kind === "number" ? typeof candidate.value !== "number" || !Number.isFinite(candidate.value) : kind === "boolean" ? typeof candidate.value !== "boolean" : typeof candidate.value !== "string") invalid("Field value type mismatch", id);
      if (kind === "enum" && !choices?.some((choice) => choice.id === candidate.value)) invalid("Unknown enum value", id);
      if (typeof candidate.value === "string" && candidate.value.length > 8192) invalid("Field too long", id);
    }
    return { ...base, kind, ...(candidate.value !== undefined ? { value: candidate.value as string | number | boolean } : {}), ...(choices ? { choices } : {}) };
  });
}
export function normalizeConfigurationValues(input: unknown, fields: ConfigurationFieldView[]): ConfigurationValues {
  const record = object(input, fields.filter((field) => field.kind !== "credential").map((field) => field.id), "values");
  const output: ConfigurationValues = {};
  for (const [key, value] of Object.entries(record)) {
    const field = fields.find((item) => item.id === key)!;
    if (field.kind === "credential") invalid("Use the dedicated credential channel", key);
    const kind = field.kind;
    if (kind === "multiselect") {
      validateIds(value, field.choices, key);
      output[key] = [...value as string[]];
      continue;
    }
    if (kind === "number" ? typeof value !== "number" || !Number.isFinite(value) : kind === "boolean" ? typeof value !== "boolean" : typeof value !== "string") invalid("Invalid field value", key);
    if (typeof value === "string" && value.length > 8192) invalid("Field too long", key);
    if (kind === "enum" && !field.choices?.some((choice) => choice.id === value)) invalid("Unknown field choice", key);
    output[key] = value as string | number | boolean;
  }
  return output;
}
function validateIds(value: unknown, choices: Array<{ id: string }>, field: string): void {
  if (!Array.isArray(value) || value.length > 500 || new Set(value).size !== value.length || value.some(id => typeof id !== "string" || !choices.some(choice => choice.id === id))) invalid("Invalid registered ID selection", field);
}
