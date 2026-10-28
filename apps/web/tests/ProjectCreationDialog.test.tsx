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


import type { ConnectorManifest, ModelProfile, RuntimeSettingsDetails, RuntimeSettingsOverrides, SkillDescriptor, SkillLibrary } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { LocaleProvider } from "../src/i18n/index.js";
import { ProjectCreationDialog } from "../src/session/ManagementControls.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const model = {
  baseUrl: "https://example.test/v1",
  createdAt: "2026-10-20T00:00:00.000Z",
  hasApiToken: true,
  id: "model-1",
  model: "test-model",
  name: "Primary model",
  updatedAt: "2026-10-20T00:00:00.000Z",
  vision: false,
} satisfies ModelProfile;

const connector = {
  id: "pubmed",
  publisher: "NCBI",
} as ConnectorManifest;

const skill = {
  currentRevision: 1,
  description: "Evidence workflow",
  diagnostics: [],
  hash: "a".repeat(64),
  id: "evidence-workflow",
  name: "Evidence workflow",
  readOnly: true,
  resourceSummary: { bytes: 0, files: 0, kinds: { asset: 0, other: 0, reference: 0, script: 0 } },
  source: "built-in",
  version: "1.0.0",
} satisfies SkillDescriptor;

const skillLibrary = {
  createdAt: "2026-10-20T00:00:00.000Z",
  headVersionId: "version-a",
  id: "evaluation-skills",
  name: "Evaluation Skills",
  updatedAt: "2026-10-20T00:00:00.000Z",
} satisfies SkillLibrary;

function details(): RuntimeSettingsDetails {
  return {
    effective: {
      enabledConnectorIds: [],
      enabledSkillLibraries: [],
      enabledSkillIds: [],
      modelId: model.id,
      semanticReviewEnabled: false,
      skillSelectionMode: "all",
    },
    overrides: {},
    sources: {
      enabledConnectorIds: "global",
      enabledSkillLibraries: "unset",
      enabledSkillIds: "unset",
      modelId: "global",
      reviewModelId: "unset",
      semanticReviewEnabled: "global",
      skillSelectionMode: "unset",
    },
  };
}

function dialogProps(onCreate: (name: string, description: string, settingsOverrides: RuntimeSettingsOverrides) => void) {
  return {
    connectors: [connector],
    details: details(),
    models: [model],
    onCancel: () => undefined,
    onCreate,
    skillLibraries: [skillLibrary],
    skills: [skill],
  };
}

test("default view shows only name and description, folding runtime inheritance into collapsed advanced settings", () => {
  const html = renderToStaticMarkup(createElement(ProjectCreationDialog, dialogProps(() => undefined)));

  const detailsStart = html.indexOf('<details class="scoped-settings-advanced">');
  assert.ok(detailsStart > 0, "advanced settings details element is present");
  assert.ok(!html.includes('<details class="scoped-settings-advanced" open'), "advanced settings render collapsed");

  const detailsEnd = html.indexOf("</details>", detailsStart);
  const defaultView = html.slice(0, detailsStart);
  const advancedView = html.slice(detailsStart, detailsEnd);
  const afterAdvanced = html.slice(detailsEnd);

  assert.match(defaultView, /placeholder="Research project"/);
  assert.match(defaultView, /placeholder="Optional — a few words about this research"/);
  assert.match(defaultView, /Create Project/);
  assert.doesNotMatch(defaultView, /Task model|Optional extensions|Effective:/);

  assert.match(advancedView, /<summary>Advanced settings<\/summary>/);
  assert.match(advancedView, /Project runtime settings/);
  assert.match(advancedView, /Task model/);
  assert.match(advancedView, /Optional extensions/);

  assert.match(afterAdvanced, /type="submit"/);
});

test("advanced settings summary and description field localize to zh-CN", () => {
  const html = renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: "zh-CN" },
    createElement(ProjectCreationDialog, dialogProps(() => undefined))));

  assert.match(html, /<summary>高级设置<\/summary>/);
  assert.match(html, /研究描述/);
  assert.match(html, /placeholder="可选——简单介绍这项研究"/);
});

test("creating without touching advanced settings submits the same empty inheritance draft plus name and trimmed description", async () => {
  let created: { description: string; name: string; overrides: RuntimeSettingsOverrides } | undefined;
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ProjectCreationDialog, dialogProps((name, description, settingsOverrides) => {
      created = { description, name, overrides: settingsOverrides };
    })));
  });

  const nameInput = renderer!.root.findAllByType("input").find((input) => input.props.required);
  assert.ok(nameInput);
  await act(async () => nameInput.props.onChange({ target: { value: "Lung cancer differential expression analysis" } }));
  const descriptionInput = renderer!.root.findByType("textarea");
  await act(async () => descriptionInput.props.onChange({ target: { value: "  Compare tumor vs normal samples.  " } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => undefined }));

  assert.ok(created);
  assert.equal(created!.name, "Lung cancer differential expression analysis");
  assert.equal(created!.description, "Compare tumor vs normal samples.");
  assert.deepEqual(created!.overrides, { enabledSkillLibraries: [] });
  await act(async () => renderer!.unmount());
});

test("fields inside the collapsed advanced settings remain overridable", async () => {
  let created: { overrides: RuntimeSettingsOverrides } | undefined;
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ProjectCreationDialog, dialogProps((_name, _description, settingsOverrides) => {
      created = { overrides: settingsOverrides };
    })));
  });

  const modelSelect = renderer!.root.findAllByType("select")
    .filter((select) => !select.props["aria-label"]?.endsWith(" plugin"))
    .find((select) => select.findAllByType("option").some((option) => option.props.value === model.id));
  assert.ok(modelSelect);
  await act(async () => modelSelect.props.onChange({ target: { value: model.id } }));
  const nameInput = renderer!.root.findAllByType("input").find((input) => input.props.required);
  await act(async () => nameInput!.props.onChange({ target: { value: "Overrides" } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => undefined }));

  assert.ok(created);
  assert.equal(created!.overrides.modelId, model.id);
  await act(async () => renderer!.unmount());
});
