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
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ModelProfile } from "@sciencediscovery/schema";

import {
  duplicateModelProfileId,
  modelOptionLabel,
  shortModelProfileId,
} from "../src/modelLabels.js";
import { translate } from "../src/i18n/index.js";

const sourceRoot = new URL("../src/", import.meta.url);

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, sourceRoot), "utf8");
}

function model(id: string, name = "Shared", providerModel = "test-model"): ModelProfile {
  return {
    baseUrl: "https://example.test/v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    hasApiToken: true,
    id,
    model: providerModel,
    name,
    updatedAt: "2026-01-01T00:00:00.000Z",
    vision: false,
  };
}

test("model labels add a short profile ID only when visible identities collide", () => {
  const first = model("model-profile-11111111");
  const second = model("model-profile-22222222");
  const unique = model("model-profile-33333333", "Unique");
  const models = [first, second, unique];

  assert.equal(shortModelProfileId(first.id), "model-…1111");
  assert.equal(duplicateModelProfileId(first, models), "model-…1111");
  const t = (key: Parameters<typeof translate>[1]) => translate("en", key);
  assert.equal(modelOptionLabel(first, models, t), "Shared · test-model · OpenAI standard · Model default · model-…1111");
  assert.equal(modelOptionLabel(second, models, t), "Shared · test-model · OpenAI standard · Model default · model-…2222");
  assert.equal(modelOptionLabel(unique, models, t), "Unique · test-model · OpenAI standard · Model default");
});

test("settings checkboxes expose a 24px control inside clickable labels", () => {
  const settings = source("styles/settings.css");
  const dialogs = source("styles/dialogs.css");
  const timeline = source("styles/timeline.css");
  const responsive = source("styles/responsive.css");

  assert.match(settings, /\.settings-choices \{[^}]*grid-template-columns: 1fr 1fr;/);
  assert.match(settings, /\.settings-choices input \{[^}]*width: 24px;[^}]*min-height: 24px;[^}]*height: 24px;/);
  assert.match(settings, /\.config-panel \.timeout-unlimited input \{[^}]*width: 24px;[^}]*min-height: 24px;[^}]*height: 24px;/);
  assert.match(timeline, /\.specialist-layout fieldset \{[^}]*flex-wrap: wrap;/);
  assert.match(timeline, /\.specialist-layout fieldset label \{[^}]*min-height: 32px;[^}]*cursor: pointer;/);
  assert.match(timeline, /\.specialist-layout fieldset input\[type="checkbox"\] \{[^}]*width: 24px;[^}]*min-height: 24px;[^}]*height: 24px;/);
  assert.match(responsive, /\.settings-choices \{ grid-template-columns: 1fr; \}/);
  assert.match(responsive, /\.specialist-layout \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});

test("the shared form skeleton also covers scoped settings outside config panels", () => {
  const primitives = source("styles/primitives.css");
  const managementControls = source("session/ManagementControls.tsx");

  // The project creation dialog mounts ScopedSettingsEditor without a
  // `.config-panel` ancestor, so the primitive must scope `.scoped-settings`
  // directly to keep its selects and text fields off browser defaults.
  assert.match(primitives, /\.scoped-settings :where\(\s*input:not\(\[type="checkbox"\]\)[\s\S]*?select,\s*textarea\s*\) \{/);
  assert.match(primitives, /\.scoped-settings textarea \{[^}]*min-height: 96px;/);
  assert.match(managementControls, /<section[^>]*className="creation-dialog"[^>]*>/);
  assert.match(managementControls, /<ScopedSettingsEditor/);
});

test("configured providers render one expandable row each with an inline model table", () => {
  const settings = source("styles/settings.css");

  assert.match(settings, /\.provider-rows \{[^}]*display: grid;/);
  assert.match(settings, /\.provider-row-summary \{[^}]*grid-template-columns: 9px minmax\(0, 1fr\) auto auto;/);
  assert.match(settings, /\.provider-model-table \{[^}]*display: grid;[^}]*border: 1px solid var\(--border\)/);
  assert.match(settings, /\.provider-model-row \{[^}]*grid-template-columns: minmax\(140px, 1\.2fr\) minmax\(0, 2fr\) auto;/);
  assert.match(settings, /\.provider-manual-form \{[^}]*display: grid;/);
  assert.match(settings, /\.provider-manual-form \.provider-manual-vision \{[^}]*align-self: start;/);
  assert.match(settings, /\.provider-add-panel select \{[^}]*max-width: 240px;/);
  assert.match(settings, /\.provider-editor-actions \{[^}]*flex-wrap: nowrap;/);
  // The preset wall and the resident editor are gone for good.
  assert.doesNotMatch(settings, /provider-preset-card/);
});

test("sidebar ellipsis text nodes carry their full visible names", () => {
  const app = source("App.tsx");

  assert.match(app, /<span title=\{project\.name\}>\{label\}<\/span>/);
  assert.match(app, /<span title=\{`\$\{item\.title\}\$\{item\.archivedAt/);
  // Only the optional vision model picker still uses the long option label;
  // the composer mounts the ModelPicker popover instead of an inline select.
  assert.equal(app.match(/modelOptionLabel\(item, (?:models|visionModels), t\)/g)?.length, 1);
  assert.match(app, /<ModelPicker/);
  // The advanced standalone model editor is gone; migrated profiles live
  // under their custom provider instead.
  assert.doesNotMatch(app, /provider-advanced-profiles/);
  assert.doesNotMatch(app, /ModelDraftFields/);
});

test("the system settings dialog uses up to roughly 80% of the viewport", () => {
  const dialogs = source("styles/dialogs.css");
  const responsive = source("styles/responsive.css");

  assert.match(dialogs, /\.system-config-dialog \{[^}]*width: min\(80vw, 1600px\);[^}]*height: min\(80vh, 1000px\);/);
  assert.match(responsive, /@media \(max-width: 900px\)[\s\S]*?\.system-config-dialog \{ width: calc\(100vw - 32px\);/);
  assert.match(responsive, /@media \(max-width: 600px\)[\s\S]*?\.system-config-dialog \{ width: 100%;/);
});

test("workspace resize wiring shares a viewport-driven maximum", () => {
  const app = source("App.tsx");

  assert.doesNotMatch(app, /MAX_WORKSPACE_WIDTH/);
  assert.match(app, /aria-valuemax=\{workspaceMaxWidth\}/);
  assert.match(app, /event\.key === "End"\) resizeWorkspace\(Number\.POSITIVE_INFINITY\)/);
  assert.match(app, /window\.addEventListener\("resize", updateWorkspaceBounds\)/);
  assert.match(app, /style=\{workspaceCollapsed \? undefined : \{ gridTemplateColumns:/);
});

test("dense settings and artifact layouts adapt without fixed-column overflow", () => {
  const settings = source("styles/settings.css");
  const responsive = source("styles/responsive.css");
  const artifacts = source("styles/artifacts.css");

  assert.match(settings, /\.skill-manager-toolbar \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(250px, 1fr\) auto auto auto;/);
  assert.match(settings, /\.environment-install \{[^}]*grid-template-columns: minmax\(112px, 128px\) minmax\(0, 1fr\) auto;/);
  assert.match(responsive, /\.skill-manager-toolbar \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(responsive, /\.environment-install \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(responsive, /\.dialog-actions \{ flex-wrap: wrap; \}/);
  assert.match(responsive, /\.annotation-editor \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(artifacts, /\.artifact-provenance article header \{[^}]*flex-wrap: wrap;/);
});

test("Composer controls wrap by available container width instead of overlapping", () => {
  const conversation = source("styles/conversation.css");
  const responsive = source("styles/responsive.css");

  assert.match(conversation, /\.composer-footer \{[^}]*flex-wrap: wrap;/);
  assert.match(conversation, /\.model-picker \{[^}]*flex: 1 1 280px;[^}]*min-width: 0;/);
  assert.match(conversation, /\.model-picker-popover \{[^}]*position: absolute;[^}]*bottom: calc\(100% \+ 8px\);/);
  assert.match(conversation, /\.model-picker-stops \{[^}]*display: flex;/);
  // Conversation model rows reveal a rich hover/focus popup that never swallows the click.
  assert.match(conversation, /\.model-picker-row-wrap:hover \.model-picker-popup, \.model-picker-row-wrap:focus-within \.model-picker-popup \{[^}]*display: grid;/);
  assert.match(conversation, /\.model-picker-popup \{[^}]*pointer-events: none;/);
  assert.match(conversation, /\.model-picker-stop \+ \.model-picker-stop \{[^}]*margin-left: -1px;/);
  assert.match(conversation, /\.model-picker-trigger-name \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;/);
  assert.match(conversation, /\.orchestration-controls \{[^}]*flex-wrap: wrap;/);
  assert.match(responsive, /@container \(max-width: 1024px\)[\s\S]*?\.model-picker \{ flex-basis: 100%; max-width: none; \}/);
  assert.match(responsive, /@container \(max-width: 900px\)[\s\S]*?\.orchestration-controls \{ flex-basis: 100%; \}/);
  assert.match(responsive, /@media \(max-width: 600px\) \{\s*\.model-picker, \.orchestration-controls \{ flex: 0 0 auto; \}\s*\.model-picker \{ width: 100%; max-width: none;/);
});
