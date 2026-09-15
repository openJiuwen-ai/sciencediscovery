// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalState } from "@sciencediscovery/context";
import { filterEnabledMcpSources } from "@sciencediscovery/mcp-sources";
import { BridgeError, PluginBridge, mergePluginSettings, negotiatePlugins, pluginEnabled, type BridgeScope } from "@sciencediscovery/plugin-sdk";
import type { RuntimeSettingsOverrides, RuntimeSettingsDetails, SessionRun } from "@sciencediscovery/schema";
import type { SessionStore } from "../store.js";
import { installedPlugins, hostPermissions, hostServices } from "./catalog.js";
import { MAIN_RUN_STREAM } from "../store/run-streams.js";
import { VersionStore, type AgentStateRef } from "@sciencediscovery/cas";

const digest = (value: unknown) => createHash("sha256").update(canonicalState(JSON.parse(JSON.stringify(value)))).digest("hex");
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError("invalid", "Expected an object");
  return value as Record<string, unknown>;
};
type Ports = Pick<SessionStore, "getProject" | "getSession" | "getProjectSettings" | "getSessionSettings" |
  "dataDir" | "replaceProjectSettings" | "replaceSessionSettings" | "createSession" | "deleteSession" | "commitPluginSettings" | "getSessionRun" | "listRunStreamEvents">;
interface Composition {
  projectId: string; revision: string; settings: RuntimeSettingsDetails;
  plugins: typeof installedPlugins;
}
interface Candidate {
  id: string; projectId: string; baseline: Composition; patch: RuntimeSettingsOverrides;
  baselineRef: AgentStateRef; proposedRef: AgentStateRef; comparisonRef?: AgentStateRef;
  pinnedBaseline: RuntimeSettingsOverrides; pinnedProposed: RuntimeSettingsOverrides;
  baselineAssets: unknown; proposedAssets: unknown;
  status: "candidate" | "prepared" | "compared" | "approved" | "rejected" | "applied";
  experiments?: { baselineSessionId: string; candidateSessionId: string; baselineSettings: RuntimeSettingsOverrides; candidateSettings: RuntimeSettingsOverrides };
  comparison?: { baseline: SessionRun; candidate: SessionRun; capturedAt: string; fidelity: "observed-runs" };
  approvedAt?: string; appliedRevision?: string;
}

/** Host control plane. Credentials, execution permissions and domain stores remain elsewhere. */
export class PluginControl {
  private readonly listeners = new Set<{ scope: BridgeScope; listener: () => void }>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private assetPort?: (settings:RuntimeSettingsOverrides) => Promise<{settings:RuntimeSettingsOverrides;assets:unknown}>;
  bindAssets(port: NonNullable<PluginControl["assetPort"]>): void {
    if (this.assetPort) throw new Error("Plugin asset port already bound");
    this.assetPort = port;
  }
  private async pin(settings:RuntimeSettingsOverrides) {
    const fixed = this.normalize({...settings,skillSelectionMode:"selected"});
    if (this.assetPort) return this.assetPort(fixed);
    if (fixed.enabledSkillLibraries?.length || fixed.enabledSkillIds?.length) throw new BridgeError("unavailable","Skill asset provider is not bound");
    return {settings:fixed,assets:[]};
  }
  constructor(private readonly db: DatabaseSync, private readonly ports: Ports,
    private readonly normalize: (value: unknown) => RuntimeSettingsOverrides) {
    db.exec("CREATE TABLE IF NOT EXISTS plugin_candidates (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, json TEXT NOT NULL)");
  }
  private async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.queues.set(key, next);
    try { return await next; } finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }
  assertScope(scope: BridgeScope): void {
    if (!scope.projectId || !this.ports.getProject(scope.projectId)) throw new BridgeError("unavailable", "Project not found");
    if (scope.sessionId && this.ports.getSession(scope.sessionId)?.projectId !== scope.projectId) throw new BridgeError("forbidden", "Session does not belong to this Project");
  }
  snapshot(scope: BridgeScope): Composition {
    this.assertScope(scope);
    const settings = scope.sessionId ? this.ports.getSessionSettings(scope.sessionId) : this.ports.getProjectSettings(scope.projectId);
    return { projectId: scope.projectId, revision: digest({ settings, plugins: installedPlugins }), settings, plugins: structuredClone(installedPlugins) };
  }
  describe(scope: BridgeScope) {
    const snapshot = this.snapshot(scope);
    return { ...snapshot, status: negotiatePlugins(installedPlugins, {
      settings: snapshot.settings.effective.plugins, services: hostServices, permissions: hostPermissions,
    }), applies: "nextRun" as const };
  }
  subscribe(scope: BridgeScope, listener: () => void): () => void {
    this.assertScope(scope);
    const entry = { scope: structuredClone(scope), listener };
    this.listeners.add(entry);
    return () => { this.listeners.delete(entry); };
  }
  changed(projectId?: string, sessionId?: string): void {
    for (const entry of this.listeners) if ((!projectId || entry.scope.projectId === projectId) && (!sessionId || entry.scope.sessionId === sessionId)) {
      try { entry.listener(); } catch { /* Notifications never commit or roll back authority. */ }
    }
  }
  bridge(scope: BridgeScope): PluginBridge {
    this.assertScope(scope);
    const bridge = new PluginBridge(scope, (id) => id === "host.settings" || installedPlugins.some((item) => item.id === id));
    bridge.register({ id: "host.settings", queries: { snapshot: () => this.describe(scope) }, commands: {
      replace: async (input, signal) => {
        signal.throwIfAborted();
        const command = record(input);
        const assertCurrent = () => {
          signal.throwIfAborted();
          if (command.expectedRevision !== this.snapshot(scope).revision) throw new BridgeError("conflict", "Settings changed; reload before saving");
        };
        const settings = this.normalize(command.overrides);
        if (scope.sessionId) await this.ports.replaceSessionSettings(scope.sessionId, settings, assertCurrent);
        else await this.ports.replaceProjectSettings(scope.projectId, settings, assertCurrent);
        return this.describe(scope);
      },
    } });
    for (const manifest of installedPlugins) bridge.register({
      id: manifest.id,
      queries: {
        settings: () => {
          const snapshot = this.snapshot(scope);
          return { revision: snapshot.revision, applies: manifest.configuration?.applies,
            settings: snapshot.settings.effective.plugins?.[manifest.id] ?? {},
            fields: Object.fromEntries((manifest.settingsFields ?? []).map((key) => [key, snapshot.settings.effective[key as keyof RuntimeSettingsOverrides]])) };
        },
        ...(manifest.contributes?.includes("project.panel") ? {
          state: async (input: unknown) => {
            if (!scope.sessionId) throw new BridgeError("invalid", "Session scope is required");
            const runId = record(input).runId;
            if (typeof runId !== "string") throw new BridgeError("invalid", "runId is required");
            const events = await this.ports.listRunStreamEvents(scope.sessionId, runId, MAIN_RUN_STREAM);
            // Historical state stays readable even if the plugin is now disabled.
            return events.filter((entry) => entry.event.type === "plan.updated").map((entry) => entry.event);
          },
        } : {}),
      },
      commands: {
        configure: async (input, signal) => {
          signal.throwIfAborted();
          const command = record(input), before = this.snapshot(scope);
          if (command.expectedRevision !== before.revision) throw new BridgeError("conflict", "Settings changed; reload before saving");
          const patch = command.fields === undefined ? {} : record(command.fields);
          if (Object.keys(patch).some((key) => !manifest.settingsFields?.includes(key))) throw new BridgeError("forbidden", "Plugin cannot configure another domain");
          const next = { ...before.settings.overrides, ...patch };
          const plugins = { ...next.plugins };
          if (command.inherit === true) delete plugins[manifest.id];
          else plugins[manifest.id] = record(command.settings ?? {}) as never;
          next.plugins = plugins;
          const normalized = this.normalize(next);
          const assertCurrent = () => {
            signal.throwIfAborted();
            if (command.expectedRevision !== this.snapshot(scope).revision) throw new BridgeError("conflict", "Settings changed; reload before saving");
          };
          if (scope.sessionId) await this.ports.replaceSessionSettings(scope.sessionId, normalized, assertCurrent);
          else await this.ports.replaceProjectSettings(scope.projectId, normalized, assertCurrent);
          return this.snapshot(scope);
        },
      },
    });
    return bridge;
  }
  list(projectId: string): Candidate[] {
    this.assertScope({ projectId });
    return (this.db.prepare("SELECT json FROM plugin_candidates WHERE project_id = ? ORDER BY rowid DESC").all(projectId) as { json: string }[]).map((row) => JSON.parse(row.json));
  }
  private save(candidate: Candidate): Candidate {
    this.assertScope({projectId:candidate.projectId});
    this.db.prepare("INSERT INTO plugin_candidates(id, project_id, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json")
      .run(candidate.id, candidate.projectId, JSON.stringify(candidate));
    return structuredClone(candidate);
  }
  async create(projectId: string, expectedRevision: unknown, value: unknown): Promise<Candidate> {
    const baseline = this.snapshot({ projectId });
    if (expectedRevision !== baseline.revision) throw new BridgeError("conflict", "Baseline changed");
    const patch = record(value);
    if (Object.keys(patch).some((key) => !["plugins", "enabledSkillIds", "enabledSkillLibraries", "skillSelectionMode"].includes(key))) {
      throw new BridgeError("forbidden", "Only named plugin configuration and skill assets may be replaced");
    }
    const normalized = this.normalize(patch);
    const pinned = await this.pin(baseline.settings.effective);
    const proposed = await this.pin(this.normalize({...baseline.settings.effective,...normalized,
      plugins:mergePluginSettings(baseline.settings.effective.plugins,normalized.plugins)}));
    if (this.snapshot({projectId}).revision !== baseline.revision) throw new BridgeError("conflict","Baseline changed during capture");
    // A library 'head' is resolved now, not again when the candidate is applied.
    if (normalized.enabledSkillLibraries) normalized.enabledSkillLibraries=proposed.settings.enabledSkillLibraries;
    const versions=new VersionStore(this.ports.dataDir);
    const baselineRef=await versions.putRecord("PluginComposition", {baseline,settings:pinned.settings,assets:pinned.assets});
    const proposedRef=await versions.putRecord("PluginCandidateComposition", {baselineRef,patch:normalized,settings:proposed.settings,assets:proposed.assets});
    return this.save({ id: randomUUID(), projectId, baseline, baselineRef, proposedRef, patch: normalized,
      pinnedBaseline:pinned.settings,pinnedProposed:proposed.settings,baselineAssets:pinned.assets,proposedAssets:proposed.assets,status: "candidate" });
  }
  async command(projectId: string, id: string, action: string, input: unknown): Promise<Candidate> {
    return this.serial("candidate:" + id, async () => {
      const candidate = this.list(projectId).find((item) => item.id === id);
      if (!candidate) throw new BridgeError("unavailable", "Candidate not found");
      if (action === "reject" && !["applied", "rejected"].includes(candidate.status)) {
        candidate.status = "rejected"; return this.save(candidate);
      }
      if (action === "prepare" && candidate.status === "candidate") {
        const baselineSettings = candidate.pinnedBaseline;
        const candidateSettings = candidate.pinnedProposed;
        if (digest((await this.pin(baselineSettings)).assets)!==digest(candidate.baselineAssets)
          || digest((await this.pin(candidateSettings)).assets)!==digest(candidate.proposedAssets)) throw new BridgeError("conflict","Skill assets changed; create a new candidate");
        // Two ordinary isolated Sessions reuse the existing Run/Runner path and permissions.
        const baseline = await this.ports.createSession(projectId, "Plugin experiment: baseline", baselineSettings, {}, { allowUnconfiguredModel: true });
        let next;
        try { next = await this.ports.createSession(projectId, "Plugin experiment: candidate", candidateSettings, {}, { allowUnconfiguredModel: true }); }
        catch (error) {
          try { await this.ports.deleteSession(baseline.id, baseline.id); }
          catch (cleanup) { throw new AggregateError([error, cleanup], "Experiment preparation and cleanup failed"); }
          throw error;
        }
        candidate.experiments = { baselineSessionId: baseline.id, candidateSessionId: next.id,
          baselineSettings: this.ports.getSessionSettings(baseline.id).effective,
          candidateSettings: this.ports.getSessionSettings(next.id).effective };
        candidate.status = "prepared"; return this.save(candidate);
      }
      if (action === "compare" && candidate.status === "prepared" && candidate.experiments) {
        if (digest((await this.pin(candidate.pinnedBaseline)).assets)!==digest(candidate.baselineAssets)
          || digest((await this.pin(candidate.pinnedProposed)).assets)!==digest(candidate.proposedAssets)) throw new BridgeError("conflict","Experiment assets changed");
        const request = record(input), experiment = candidate.experiments;
        if (typeof request.baselineRunId !== "string" || typeof request.candidateRunId !== "string") throw new BridgeError("invalid", "Two completed Run ids are required");
        const baseline = await this.ports.getSessionRun(experiment.baselineSessionId, request.baselineRunId);
        const next = await this.ports.getSessionRun(experiment.candidateSessionId, request.candidateRunId);
        if (!baseline || !next || baseline.status !== "completed" || next.status !== "completed" || baseline.prompt !== next.prompt) {
          throw new BridgeError("invalid", "Compare the same task completed in both experiment Sessions");
        }
        if (digest(runtimeSelection(baseline.settingsSnapshot)) !== digest(runtimeSelection(experiment.baselineSettings))
          || digest(runtimeSelection(next.settingsSnapshot)) !== digest(runtimeSelection(experiment.candidateSettings))) {
          throw new BridgeError("conflict", "Experiment configuration drifted");
        }
        candidate.comparison = { baseline, candidate: next, capturedAt: new Date().toISOString(), fidelity: "observed-runs" };
        candidate.comparisonRef=await new VersionStore(this.ports.dataDir).putRecord("PluginExperimentComparison",
          {baselineRef:candidate.baselineRef,proposedRef:candidate.proposedRef,...candidate.comparison});
        candidate.status = "compared"; return this.save(candidate);
      }
      if (action === "approve" && candidate.status === "compared") {
        candidate.status = "approved"; candidate.approvedAt = new Date().toISOString(); return this.save(candidate);
      }
      if (action === "apply" && candidate.status === "applied") return candidate;
      if (action === "apply" && candidate.status === "approved") {
        if (digest((await this.pin(candidate.pinnedProposed)).assets)!==digest(candidate.proposedAssets)) throw new BridgeError("conflict","Candidate assets changed");
        const overrides = candidate.baseline.settings.overrides;
        await this.ports.commitPluginSettings(projectId, this.normalize({ ...overrides, ...candidate.patch,
          plugins: mergePluginSettings(overrides.plugins, candidate.patch.plugins) }), () => {
          if (this.snapshot({ projectId }).revision !== candidate.baseline.revision) throw new BridgeError("conflict", "Active composition changed; candidate was not applied");
        }, () => {
          candidate.status = "applied"; candidate.appliedRevision = this.snapshot({ projectId }).revision;
          this.save(candidate);
        });
        return structuredClone(candidate);
      }
      throw new BridgeError("conflict", "Invalid candidate lifecycle transition");
    });
  }
}

function runtimeSelection(settings: RuntimeSettingsOverrides) {
  const skills = pluginEnabled(settings.plugins, "skill");
  return { modelId:settings.modelId ?? null, plugins: settings.plugins ?? {}, enabledSkillIds: skills ? [...settings.enabledSkillIds ?? []].sort() : [],
    enabledSkillLibraries: skills ? settings.enabledSkillLibraries ?? [] : [],
    enabledConnectorIds: filterEnabledMcpSources(settings.enabledConnectorIds ?? [], settings.plugins).sort() };
}
