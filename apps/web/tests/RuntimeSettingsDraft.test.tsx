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

import type { ConnectorManifest, ModelProfile, RuntimeSettingsDetails, RuntimeSettingsOverrides, SkillDescriptor, SkillLibrary } from "@sciencediscovery/schema";
import { BUILT_IN_SKILL_LIBRARY_ID } from "@sciencediscovery/schema";
import { createElement, useState } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { ProjectCreationDialog } from "../src/ManagementControls.js";
import { ScopedSettingsEditor } from "../src/ScopedSettingsEditor.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const model = {
  baseUrl: "https://example.test/v1",
  createdAt: "2026-08-11T00:00:00.000Z",
  hasApiToken: true,
  id: "model-1",
  model: "test-model",
  name: "Primary model",
  updatedAt: "2026-08-11T00:00:00.000Z",
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
  createdAt: "2026-08-11T00:00:00.000Z",
  headVersionId: "version-a",
  id: "evaluation-skills",
  name: "Evaluation Skills",
  updatedAt: "2026-08-11T00:00:00.000Z",
} satisfies SkillLibrary;

const builtInSkillLibrary = {
  createdAt: "2026-08-11T00:00:00.000Z",
  headVersionId: "version-built-in",
  id: BUILT_IN_SKILL_LIBRARY_ID,
  name: "Built-in Skills",
  updatedAt: "2026-08-11T00:00:00.000Z",
} satisfies SkillLibrary;

function details(
  overrides: RuntimeSettingsDetails["overrides"] = {},
  effective: Partial<RuntimeSettingsDetails["effective"]> = {},
): RuntimeSettingsDetails {
  return {
    effective: {
      enabledConnectorIds: [],
      enabledSkillLibraries: [],
      enabledSkillIds: [],
      modelId: undefined,
      semanticReviewEnabled: false,
      skillSelectionMode: "all",
      ...effective,
    },
    overrides,
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

function editor(settings: RuntimeSettingsDetails, key?: string) {
  return createElement(ScopedSettingsEditor, {
    connectors: [connector],
    details: settings,
    key,
    models: [model],
    onSave: () => undefined,
    scopeLabel: "Session",
    skillLibraries: [skillLibrary],
    skills: [skill],
  });
}

function settingsControls(root: ReactTestInstance) {
  const selects = root.findAllByType("select");
  assert.equal(selects.length, 3);
  return {
    connectorMode: selects[1]!,
    model: selects[0]!,
    skillMode: selects[2]!,
  };
}

function selectedCheckboxes(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAllByType("input").filter((input) => input.props.type === "checkbox" && !input.props["aria-label"] && input.props.checked);
}

async function chooseRuntimeDraft(root: ReactTestInstance): Promise<void> {
  let controls = settingsControls(root);
  await act(async () => controls.model.props.onChange({ target: { value: model.id } }));
  controls = settingsControls(root);
  await act(async () => controls.connectorMode.props.onChange({ target: { value: "override" } }));
  const connectorCheckbox = root.findAllByType("input").find((input) => input.props.type === "checkbox");
  assert.ok(connectorCheckbox);
  await act(async () => connectorCheckbox.props.onChange());
  controls = settingsControls(root);
  await act(async () => controls.skillMode.props.onChange({ target: { value: "selected" } }));
  const checkboxes = root.findAllByType("input").filter((input) => input.props.type === "checkbox" && !input.props["aria-label"]);
  assert.equal(checkboxes.length, 2);
  await act(async () => checkboxes[1]!.props.onChange());
}

function assertRuntimeDraftSelected(root: ReactTestInstance): void {
  const controls = settingsControls(root);
  assert.equal(controls.model.props.value, model.id);
  assert.equal(controls.connectorMode.props.value, "override");
  assert.equal(controls.skillMode.props.value, "selected");
  assert.equal(selectedCheckboxes(root).length, 2);
}

test("Project name input preserves the complete unsubmitted Runtime Settings draft", async () => {
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ProjectCreationDialog, {
      connectors: [connector],
      details: details(),
      models: [model],
      onCancel: () => undefined,
      onCreate: () => undefined,
      skillLibraries: [skillLibrary],
      skills: [skill],
    }));
  });

  await chooseRuntimeDraft(renderer!.root);
  assertRuntimeDraftSelected(renderer!.root);
  const nameInput = renderer!.root.findAllByType("input").find((input) => input.props.required);
  assert.ok(nameInput);
  await act(async () => nameInput.props.onChange({ target: { value: "Protein design" } }));

  assertRuntimeDraftSelected(renderer!.root);
  await act(async () => renderer!.unmount());
});

test("semantic-equivalent details with a new reference do not overwrite an unsubmitted draft", async () => {
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(editor(details())); });
  await chooseRuntimeDraft(renderer!.root);

  await act(async () => {
    renderer!.update(editor(details()));
  });

  assertRuntimeDraftSelected(renderer!.root);
  await act(async () => renderer!.unmount());
});

function ParentRerenderHarness() {
  const [revision, setRevision] = useState(0);
  return createElement("div", null,
    createElement("button", { "aria-label": "Rerender parent", onClick: () => setRevision((value) => value + 1) }, revision),
    editor(details()),
  );
}

test("an ordinary parent state rerender does not reset the Runtime Settings draft", async () => {
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ParentRerenderHarness)); });
  await chooseRuntimeDraft(renderer!.root);

  await act(async () => renderer!.root.findByProps({ "aria-label": "Rerender parent" }).props.onClick());

  assertRuntimeDraftSelected(renderer!.root);
  await act(async () => renderer!.unmount());
});

test("skill library checkbox persists a mounted library selection", async () => {
  let saved: RuntimeSettingsOverrides | undefined;
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ScopedSettingsEditor, {
      connectors: [connector],
      details: details(),
      models: [model],
      onSave: (draft) => { saved = draft; },
      scopeLabel: "Session",
      skillLibraries: [skillLibrary],
      skills: [skill],
    }));
  });
  const checkbox = renderer!.root.findByProps({ "aria-label": "Use Evaluation Skills" });
  await act(async () => checkbox.props.onChange());
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => undefined }));

  assert.deepEqual(saved?.enabledSkillLibraries, [{
    libraryId: "evaluation-skills",
    limit: 12,
    priority: 0,
    versionId: "head",
  }]);
  await act(async () => renderer!.unmount());
});

test("built-in skill library can be unchecked and saved", async () => {
  let saved: RuntimeSettingsOverrides | undefined;
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ScopedSettingsEditor, {
      connectors: [connector],
      details: details({
        enabledSkillLibraries: [{ libraryId: BUILT_IN_SKILL_LIBRARY_ID, versionId: "head" }],
      }, {
        enabledSkillLibraries: [{ libraryId: BUILT_IN_SKILL_LIBRARY_ID, versionId: "head" }],
      }),
      models: [model],
      onSave: (draft) => { saved = draft; },
      scopeLabel: "Project",
      skillLibraries: [builtInSkillLibrary, skillLibrary],
      skillScope: "project",
      skills: [skill],
    }));
  });
  const checkbox = renderer!.root.findByProps({ "aria-label": "Use Built-in Skills" });
  assert.equal(checkbox.props.checked, true);
  assert.equal(Boolean(checkbox.props.disabled), false);
  await act(async () => checkbox.props.onChange());
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => undefined }));

  assert.deepEqual(saved?.enabledSkillLibraries, []);
  await act(async () => renderer!.unmount());
});

test("switching the Project or Session target initializes the new target overrides", async () => {
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(editor(details(), "project:project-1")); });
  await chooseRuntimeDraft(renderer!.root);

  const targetDetails = details({
    enabledConnectorIds: [],
    enabledSkillIds: [],
    modelId: model.id,
    skillSelectionMode: "selected",
  });
  await act(async () => {
    renderer!.update(editor(targetDetails, "session:session-2"));
  });

  const controls = settingsControls(renderer!.root);
  assert.equal(controls.model.props.value, model.id);
  assert.equal(controls.connectorMode.props.value, "override");
  assert.equal(controls.skillMode.props.value, "selected");
  assert.equal(selectedCheckboxes(renderer!.root).length, 0);
  await act(async () => renderer!.unmount());
});

test("closing and reopening Project creation starts again with empty overrides", async () => {
  const dialog = () => createElement(ProjectCreationDialog, {
    connectors: [connector],
    details: details(),
    models: [model],
    onCancel: () => undefined,
    onCreate: () => undefined,
    skillLibraries: [skillLibrary],
    skills: [skill],
  });
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(dialog()); });
  await chooseRuntimeDraft(renderer!.root);
  await act(async () => renderer!.update(createElement("div")));
  await act(async () => renderer!.update(dialog()));

  const controls = settingsControls(renderer!.root);
  assert.equal(controls.model.props.value, "");
  assert.equal(controls.connectorMode.props.value, "inherit");
  assert.equal(controls.skillMode.props.value, "all");
  assert.equal(selectedCheckboxes(renderer!.root).length, 0);
  await act(async () => renderer!.unmount());
});
