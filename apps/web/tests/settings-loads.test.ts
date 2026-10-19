// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { ModelProfile, Project, RuntimeSettingsDetails, SystemQuotaSettings } from "@sciencediscovery/schema";

import {
  load,
  settleLoads,
  startupLoads,
  systemSettingsLoads,
  type StartupLoadClient,
  type SystemSettingsLoadClient,
} from "../src/settings-loads.js";

const registry = {
  presets: [{ id: "deepseek" }],
  providers: [{ id: "provider-1" }],
} as Awaited<ReturnType<SystemSettingsLoadClient["listProviders"]>>;
const model = { id: "model-1", name: "Existing" } as ModelProfile;
const settings = { overrides: { semanticReviewEnabled: true }, effective: { modelId: "model-1" } } as RuntimeSettingsDetails;
const quotas = { uploadMaxFileBytes: 1, uploadMaxRequestBytes: 2, runnerMaxWorkspaceBytes: 3 } as SystemQuotaSettings;
const project = { id: "project-1" } as Project;

function systemClient(overrides: Partial<SystemSettingsLoadClient> = {}): SystemSettingsLoadClient {
  return {
    listProviders: async () => registry,
    listModels: async () => [model],
    listConnectors: async () => [],
    listSkills: async () => [],
    listSkillLibraries: async () => [],
    getGlobalSettings: async () => settings,
    getTimeoutSettings: async () => ({}) as SystemSettingsLoadClient extends { getTimeoutSettings: () => Promise<infer T> } ? T : never,
    getQuotaSettings: async () => quotas,
    getSandboxNetworkSettings: async () => ({}) as Awaited<ReturnType<SystemSettingsLoadClient["getSandboxNetworkSettings"]>>,
    getWebSettings: async () => ({}) as Awaited<ReturnType<SystemSettingsLoadClient["getWebSettings"]>>,
    getMemoryGraphSettings: async () => ({}) as Awaited<ReturnType<SystemSettingsLoadClient["getMemoryGraphSettings"]>>,
    getIdeaTreeSettings: async () => ({}) as Awaited<ReturnType<SystemSettingsLoadClient["getIdeaTreeSettings"]>>,
    ...overrides,
  };
}

function startupClient(overrides: Partial<StartupLoadClient> = {}): StartupLoadClient {
  return {
    ...systemClient(),
    listProjects: async () => [project],
    getModelCatalog: async () => ({}) as Awaited<ReturnType<StartupLoadClient["getModelCatalog"]>>,
    getProxySettings: async () => ({}) as Awaited<ReturnType<StartupLoadClient["getProxySettings"]>>,
    getMcpProxyPolicies: async () => ({ policies: {} }),
    listMcpSources: async () => [],
    ...overrides,
  };
}

test("a rejected read does not discard the reads that succeeded, and an empty success is still applied", async () => {
  const applied: unknown[] = [];
  const errors: Error[] = [];
  await settleLoads([
    load(async () => ["kept"], (value) => applied.push(value)),
    load(async () => [], (value) => applied.push(value)),
    load(async () => { throw "memory settings failed"; }, () => applied.push("memory")),
  ], (reason) => errors.push(reason));

  assert.deepEqual(applied, [["kept"], []]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.message, "memory settings failed");
});

test("opening System settings still applies models and global settings when memory settings fail", async () => {
  const seen: Record<string, unknown> = {};
  await settleLoads(systemSettingsLoads(systemClient({
    getMemoryGraphSettings: async () => { throw new Error("memory settings 500"); },
  }), {
    providers: (value) => { seen.providers = value; },
    models: (value) => { seen.models = value; },
    connectors: (value) => { seen.connectors = value; },
    skills: () => undefined,
    skillLibraries: () => undefined,
    globalSettings: (value) => { seen.globalSettings = value; },
    timeouts: () => undefined,
    quotas: (value) => { seen.quotas = value; },
    sandboxNetwork: () => undefined,
    web: () => undefined,
    memoryGraph: () => { seen.memory = true; },
    ideaTree: () => undefined,
  }), (reason) => { seen.error = reason.message; });

  assert.deepEqual(seen.models, [model]);
  assert.equal(seen.providers, registry);
  assert.equal(seen.globalSettings, settings);
  assert.equal(seen.quotas, quotas);
  assert.deepEqual(seen.connectors, []);
  assert.equal(seen.memory, undefined);
  assert.equal(seen.error, "memory settings 500");
});

test("startup still applies projects and models when memory settings fail", async () => {
  const seen: Record<string, unknown> = {};
  await settleLoads(startupLoads(startupClient({
    getMemoryGraphSettings: async () => { throw new Error("memory settings 500"); },
  }), {
    providers: (value) => { seen.providers = value; },
    projects: (value) => { seen.projects = value; },
    models: (value) => { seen.models = value; },
    catalog: () => undefined,
    connectors: () => undefined,
    skills: () => undefined,
    skillLibraries: () => undefined,
    globalSettings: (value) => { seen.globalSettings = value; },
    timeouts: () => undefined,
    quotas: () => undefined,
    sandboxNetwork: () => undefined,
    proxies: () => undefined,
    mcpPolicies: () => undefined,
    mcpSources: () => undefined,
    web: () => undefined,
    memoryGraph: () => { seen.memory = true; },
    ideaTree: () => undefined,
  }), () => undefined);

  assert.deepEqual(seen.projects, [project]);
  assert.equal(seen.providers, registry);
  assert.deepEqual(seen.models, [model]);
  assert.equal(seen.globalSettings, settings);
  assert.equal(seen.memory, undefined);
});

test("a memory read that has not returned yet does not block providers, models, or global settings", async () => {
  let release: () => void = () => undefined;
  const hung = new Promise<never>((resolve) => { release = resolve; });
  const seen: Record<string, unknown> = {};
  const done = settleLoads(systemSettingsLoads(systemClient({
    getMemoryGraphSettings: () => hung,
  }), {
    providers: (value) => { seen.providers = value; },
    models: (value) => { seen.models = value; },
    connectors: () => undefined,
    skills: () => undefined,
    skillLibraries: () => undefined,
    globalSettings: (value) => { seen.globalSettings = value; },
    timeouts: () => undefined,
    quotas: () => undefined,
    sandboxNetwork: () => undefined,
    web: () => undefined,
    memoryGraph: () => { seen.memory = true; },
    ideaTree: () => undefined,
  }), () => undefined);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.providers, registry);
  assert.deepEqual(seen.models, [model]);
  assert.equal(seen.globalSettings, settings);
  assert.equal(seen.memory, undefined);

  release();
  await done;
});

test("a pending memory read does not keep the project list from settling", async () => {
  let release: () => void = () => undefined;
  const hung = new Promise<never>((resolve) => { release = resolve; });
  const seen: Record<string, unknown> = {};
  const done = settleLoads(startupLoads(startupClient({
    getMemoryGraphSettings: () => hung,
  }), {
    providers: () => undefined,
    projects: (value) => { seen.projects = value; },
    onProjectsSettled: () => { seen.ready = true; },
    models: () => undefined,
    catalog: () => undefined,
    connectors: () => undefined,
    skills: () => undefined,
    skillLibraries: () => undefined,
    globalSettings: () => undefined,
    timeouts: () => undefined,
    quotas: () => undefined,
    sandboxNetwork: () => undefined,
    proxies: () => undefined,
    mcpPolicies: () => undefined,
    mcpSources: () => undefined,
    web: () => undefined,
    memoryGraph: () => { seen.memory = true; },
    ideaTree: () => undefined,
  }), () => undefined);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen.projects, [project]);
  assert.equal(seen.ready, true);
  assert.equal(seen.memory, undefined);

  release();
  await done;
});

test("a rejected project list still marks projects settled", async () => {
  let settled = false;
  await settleLoads(startupLoads(startupClient({
    listProjects: async () => { throw new Error("projects 500"); },
  }), {
    providers: () => undefined,
    projects: () => { throw new Error("project apply should not run"); },
    onProjectsSettled: () => { settled = true; },
    models: () => undefined,
    catalog: () => undefined,
    connectors: () => undefined,
    skills: () => undefined,
    skillLibraries: () => undefined,
    globalSettings: () => undefined,
    timeouts: () => undefined,
    quotas: () => undefined,
    sandboxNetwork: () => undefined,
    proxies: () => undefined,
    mcpPolicies: () => undefined,
    mcpSources: () => undefined,
    web: () => undefined,
    memoryGraph: () => undefined,
    ideaTree: () => undefined,
  }), () => undefined);

  assert.equal(settled, true);
});
