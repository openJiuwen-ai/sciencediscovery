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

import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectorManifest, ModelProfile, RuntimeSettingsDetails, SkillDescriptor } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ScopedSettingsEditor } from "../src/ScopedSettingsEditor.js";

const model = {
  baseUrl: "https://example.test/v1",
  createdAt: "2026-01-01T00:00:00.000Z",
  hasApiToken: true,
  id: "model-1",
  model: "test-model",
  name: "Primary model",
  updatedAt: "2026-01-01T00:00:00.000Z",
  vision: false,
} satisfies ModelProfile;

const connector = {
  id: "pubmed",
  publisher: "NCBI",
} as ConnectorManifest;

const skills = [{
  currentRevision: 1,
  description: "Built-in evidence workflow",
  diagnostics: [],
  hash: "a".repeat(64),
  id: "life-science-evidence-brief",
  name: "life-science-evidence-brief",
  readOnly: true,
  resourceSummary: { bytes: 0, files: 0, kinds: { asset: 0, other: 0, reference: 0, script: 0 } },
  source: "built-in",
  version: "1.1.0",
}, {
  currentRevision: 2,
  description: "Managed project workflow",
  diagnostics: [],
  hash: "b".repeat(64),
  id: "managed-workflow",
  name: "managed-workflow",
  readOnly: false,
  resourceSummary: { bytes: 0, files: 0, kinds: { asset: 0, other: 0, reference: 0, script: 0 } },
  source: "managed",
  version: "revision:2",
}] satisfies SkillDescriptor[];

function details(
  overrides: RuntimeSettingsDetails["overrides"] = {},
  effective: Partial<RuntimeSettingsDetails["effective"]> = {},
): RuntimeSettingsDetails {
  return {
    effective: {
      enabledConnectorIds: ["pubmed"],
      enabledSkillIds: skills.map((skill) => skill.id),
      modelId: model.id,
      reviewModelId: model.id,
      semanticReviewEnabled: true,
      skillSelectionMode: "all",
      ...effective,
    },
    overrides,
    sources: {
      enabledConnectorIds: "project",
      enabledSkillIds: "unset",
      modelId: "global",
      reviewModelId: "project",
      semanticReviewEnabled: "global",
      skillSelectionMode: "unset",
    },
  };
}

function render(settings: RuntimeSettingsDetails): string {
  return renderToStaticMarkup(createElement(ScopedSettingsEditor, {
    connectors: [connector],
    details: settings,
    models: [model],
    onSave: () => undefined,
    scopeLabel: "Session",
    skills,
  }));
}

test("renders inherited effective values and their field sources", () => {
  const html = render(details());

  assert.match(html, /Inherit · Primary model \(Global setting\)/);
  assert.doesNotMatch(html, /Session naming|auto-refine|auto-truncate|Manual naming/);
  assert.match(html, /Effective: Project setting/);
  assert.match(html, /Effective: Global setting/);
});

test("preserves and renders an explicit empty-list override", () => {
  const html = render(details({ enabledConnectorIds: [] }));

  assert.match(html, /<option value="override" selected="">Override · 0 selected<\/option>/);
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked=""/);
});

test("renders Global settings as direct defaults without inheritance or skill controls", () => {
  const html = renderToStaticMarkup(createElement(ScopedSettingsEditor, {
    allowInheritance: false,
    connectors: [connector],
    details: details(),
    models: [model],
    onSave: () => undefined,
    scopeLabel: "Global",
    skillScope: "global",
    skills,
  }));

  assert.match(html, /These settings are the defaults for all Projects and Sessions/);
  assert.match(html, /<option value="model-1" selected="">Primary model · test-model<\/option>/);
  assert.match(html, /type="checkbox" checked=""/);
  assert.doesNotMatch(html, /Inherit|Override|Built-in fallback|Effective:/);
  assert.doesNotMatch(html, /settings mode/);
  assert.doesNotMatch(html, /managed-workflow|Only use selected skills|Allow all skills/);
});

test("Session skill selection inherits the Project mode by default", () => {
  const html = render(details());

  assert.match(html, /<option value="inherit" selected="">\s*Inherit · Allow all skills \(2 available\)/);
  assert.match(html, /Every installed skill stays available/);
  assert.doesNotMatch(html, /managed-workflow/);
});

test("Session override to selected shows the whitelist with only the checked skills", () => {
  const html = render(details({ enabledSkillIds: ["managed-workflow"], skillSelectionMode: "selected" }));

  assert.match(html, /<option value="selected" selected="">Only use selected skills<\/option>/);
  assert.match(html, /managed-workflow/);
  assert.equal(html.match(/type="checkbox" checked=""/g)?.length, 1);
  assert.doesNotMatch(html, /Every installed skill stays available/);
});

test("Project is the root skill layer, so it offers no inherit option and defaults to all", () => {
  const html = renderToStaticMarkup(createElement(ScopedSettingsEditor, {
    connectors: [connector],
    details: details(),
    models: [model],
    onSave: () => undefined,
    scopeLabel: "Project",
    skillScope: "project",
    skills,
  }));

  const skillFieldset = html.slice(html.indexOf("<legend>Skills</legend>"));
  assert.match(skillFieldset, /<option value="all" selected="">Allow all skills<\/option>/);
  assert.doesNotMatch(skillFieldset, /Inherit/);
  assert.doesNotMatch(skillFieldset, /settings-source/);
});

test("disambiguates duplicate model options without removing either profile", () => {
  const duplicate = { ...model, id: "model-profile-22222222" } satisfies ModelProfile;
  const html = renderToStaticMarkup(createElement(ScopedSettingsEditor, {
    allowInheritance: false,
    connectors: [connector],
    details: details(),
    models: [model, duplicate],
    onSave: () => undefined,
    scopeLabel: "Global",
    skills,
  }));

  assert.match(html, /Primary model · test-model · model-1/);
  assert.match(html, /Primary model · test-model · model-…2222/);
  assert.equal(html.match(/Primary model · test-model/g)?.length, 2);

  const inheritedHtml = renderToStaticMarkup(createElement(ScopedSettingsEditor, {
    connectors: [connector],
    details: details(),
    models: [model, duplicate],
    onSave: () => undefined,
    scopeLabel: "Session",
    skills,
  }));
  assert.match(inheritedHtml, /Inherit · Primary model · test-model · model-1 \(Global setting\)/);
});
