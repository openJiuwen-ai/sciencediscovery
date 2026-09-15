// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { PluginManifest } from "./index.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface PluginSettings { enabled?: boolean; config?: Record<string, Json> }
export type PluginSettingsMap = Record<string, PluginSettings>;
export interface ConfigField {
  type: "string" | "boolean" | "number";
  enum?: readonly (string | number | boolean)[];
  /** Only references are accepted; the secret store owns all credential bytes. */
  secretRef?: boolean;
}
export interface ServiceContract { id: string; version: number; optional?: boolean }
export interface PluginDiagnostic { code: string; message: string }
export interface PluginStatus {
  id: string; installed: true; available: boolean; enabled: boolean;
  authorized: boolean; active: boolean; diagnostics: PluginDiagnostic[];
}

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeKey = (key: string) => !["__proto__", "prototype", "constructor"].includes(key);

/** Validate overrides, not resolved defaults. Missing keys retain inheritance. */
export function validatePluginSettings(value: unknown, manifests: readonly PluginManifest[]): PluginSettingsMap {
  if (!plain(value)) throw new Error("plugins must be an object");
  const result: PluginSettingsMap = {};
  for (const [id, raw] of Object.entries(value)) {
    const manifest = manifests.find((item) => item.id === id);
    if (!safeKey(id) || !manifest) throw new Error(`Unknown plugin: ${id}`);
    if (!plain(raw) || Object.keys(raw).some((key) => !["enabled", "config"].includes(key))) throw new Error(`Invalid plugin settings: ${id}`);
    const settings: PluginSettings = {};
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled !== "boolean") throw new Error(`Invalid enabled flag: ${id}`);
      settings.enabled = raw.enabled;
    }
    if (raw.config !== undefined) {
      if (!plain(raw.config)) throw new Error(`Invalid plugin config: ${id}`);
      settings.config = {};
      for (const [key, entry] of Object.entries(raw.config)) {
        const field = manifest.configuration?.fields[key];
        if (!safeKey(key) || !field || typeof entry !== field.type || (typeof entry === "number" && !Number.isFinite(entry))
          || (field.enum && !field.enum.includes(entry as string | number | boolean))
          || (field.secretRef && (typeof entry !== "string" || !/^secret:[a-zA-Z0-9._-]+$/.test(entry)))) {
          throw new Error(`Invalid plugin config field: ${id}.${key}`);
        }
        settings.config[key] = entry as Json;
      }
    }
    result[id] = settings;
  }
  return result;
}

export function mergePluginSettings(...layers: readonly (PluginSettingsMap | undefined)[]): PluginSettingsMap {
  const result: PluginSettingsMap = {};
  for (const layer of layers) for (const [id, setting] of Object.entries(layer ?? {})) {
    if (!safeKey(id)) throw new Error("Invalid plugin id");
    const previous = result[id] ?? {};
    result[id] = { ...previous, ...structuredClone(setting),
      ...((previous.config || setting.config) ? { config: { ...previous.config, ...structuredClone(setting.config) } } : {}) };
  }
  return result;
}

export const pluginEnabled = (settings: PluginSettingsMap | undefined, id: string) => settings?.[id]?.enabled !== false;
export const disabledPluginIds = (settings?: PluginSettingsMap) => Object.entries(settings ?? {}).filter(([, value]) => value.enabled === false).map(([id]) => id);

/** Separate requested configuration from capability availability and authorization. */
export function negotiatePlugins(manifests: readonly PluginManifest[], environment: {
  settings?: PluginSettingsMap; services: readonly ServiceContract[];
  permissions: readonly string[]; unavailable?: readonly string[]; active?: readonly string[];
}): PluginStatus[] {
  const ids = new Set<string>();
  for (const manifest of manifests) {
    if (ids.has(manifest.id)) throw new Error(`Duplicate plugin: ${manifest.id}`);
    ids.add(manifest.id);
  }
  const statuses = manifests.map((manifest): PluginStatus => {
    const diagnostics: PluginDiagnostic[] = [];
    const report = (code: string, message: string) => diagnostics.push({ code, message });
    if (manifest.apiVersion !== 1) report("api-version", "Unsupported host API");
    if (environment.unavailable?.includes(manifest.id)) report("unavailable", "Required runtime ports are unavailable");
    for (const requirement of manifest.services?.requires ?? []) {
      if (!environment.services.some((service) => service.id === requirement.id && service.version === requirement.version)) {
        report(requirement.optional ? "optional-service" : "required-service", `${requirement.id}@${requirement.version} unavailable`);
      }
    }
    const authorized = (manifest.permissions ?? []).every((permission) => environment.permissions.includes(permission));
    if (!authorized) report("permission", "Required host permission is not granted");
    return { id: manifest.id, installed: true, enabled: pluginEnabled(environment.settings, manifest.id),
      available: !diagnostics.some((item) => !["optional-service", "permission"].includes(item.code)),
      authorized, active: false, diagnostics };
  });
  // Propagate unavailable required dependencies to a fixed point.
  for (let pass = 0; pass < manifests.length; pass++) for (const [index, manifest] of manifests.entries()) {
    const state = statuses[index]!;
    for (const id of manifest.requires ?? []) {
      const dependency = statuses.find((item) => item.id === id);
      if ((!dependency || !dependency.enabled || !dependency.available || !dependency.authorized) && state.available) {
        state.available = false; state.diagnostics.push({ code: "dependency", message: `Required plugin unavailable: ${id}` });
      }
    }
  }
  for (const state of statuses) state.active = state.enabled && state.available && state.authorized && (environment.active?.includes(state.id) ?? false);
  return statuses;
}
