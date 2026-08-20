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
  assert.equal(modelOptionLabel(first, models), "Shared · test-model · model-…1111");
  assert.equal(modelOptionLabel(second, models), "Shared · test-model · model-…2222");
  assert.equal(modelOptionLabel(unique, models), "Unique · test-model");
});

test("settings checkboxes expose a 24px control inside clickable labels", () => {
  const settings = source("styles/settings.css");
  const dialogs = source("styles/dialogs.css");
  const timeline = source("styles/timeline.css");
  const responsive = source("styles/responsive.css");

  assert.match(settings, /\.settings-choices \{[^}]*grid-template-columns: 1fr 1fr;/);
  assert.match(settings, /\.settings-choices input \{[^}]*width: 24px;[^}]*min-height: 24px;[^}]*height: 24px;/);
  assert.match(settings, /\.config-panel \.timeout-unlimited input \{[^}]*width: 24px;[^}]*min-height: 24px;[^}]*height: 24px;/);
  assert.match(dialogs, /\.config-panel \.vision-capability \{[^}]*grid-template-columns: 24px minmax\(0, 1fr\)/);
  assert.match(timeline, /\.specialist-layout fieldset \{[^}]*flex-wrap: wrap;/);
  assert.match(timeline, /\.specialist-layout fieldset label \{[^}]*min-height: 32px;[^}]*cursor: pointer;/);
  assert.match(timeline, /\.specialist-layout fieldset input\[type="checkbox"\] \{[^}]*width: 24px;[^}]*min-height: 24px;[^}]*height: 24px;/);
  assert.match(responsive, /\.settings-choices \{ grid-template-columns: 1fr; \}/);
  assert.match(responsive, /\.specialist-layout \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});

test("sidebar ellipsis text nodes carry their full visible names", () => {
  const app = source("App.tsx");

  assert.match(app, /<span title=\{project\.name\}>\{label\}<\/span>/);
  assert.match(app, /<span title=\{`\$\{item\.title\}\$\{item\.archivedAt/);
  assert.equal(app.match(/modelOptionLabel\(item, (?:models|visionModels)\)/g)?.length, 3);
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

  assert.match(settings, /\.skill-manager-toolbar \{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
  assert.match(settings, /\.environment-install \{[^}]*grid-template-columns: minmax\(112px, 128px\) minmax\(0, 1fr\) auto;/);
  assert.match(responsive, /\.skill-manager-toolbar input \{ flex-basis: 100%; \}/);
  assert.match(responsive, /\.environment-install \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(responsive, /\.dialog-actions \{ flex-wrap: wrap; \}/);
  assert.match(responsive, /\.annotation-editor \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(artifacts, /\.artifact-provenance article header \{[^}]*flex-wrap: wrap;/);
});
