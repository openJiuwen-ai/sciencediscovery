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

const sourceRoot = new URL("../src/", import.meta.url);

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, sourceRoot), "utf8");
}

test("mixed action rows assign semantic button classes", () => {
  assert.match(source("ReviewerControlCard.tsx"), /className="primary-button"/);

  const skillManager = source("SkillManager.tsx");
  assert.equal(skillManager.match(/className="dialog-actions"><button className="secondary-button"/g)?.length, 4);
  const skillToolbar = skillManager.match(/<div className="skill-manager-toolbar">([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.equal(skillToolbar.match(/<button className="secondary-button"/g)?.length, 5);
  assert.match(skillManager, /className="skill-detail-actions">[\s\S]*?className="secondary-button compact-button"[\s\S]*?>Edit<[\s\S]*?className="danger-button compact-button"[\s\S]*?>Delete</);

  assert.match(source("Orchestration.tsx"), /className="specialist-actions"><button className="primary-button"/);

  const environments = source("EnvironmentManager.tsx");
  assert.match(environments, /<button className="primary-button"[^>]*type="submit">Create</);
  assert.match(environments, /<button className="secondary-button".*?Install packages/);

  const remoteCompute = source("RemoteCompute.tsx");
  assert.match(remoteCompute, /<button className="primary-button"[^>]*>Probe and add</);
  assert.match(remoteCompute, /<button className="secondary-button".*?Refresh probe/);

  const proxySettings = source("ProxySettingsEditor.tsx");
  assert.match(proxySettings, /className="proxy-server-actions">[\s\S]*?className="secondary-button compact-button"[\s\S]*?className="danger-button compact-button"/);
  assert.match(proxySettings, /className="secondary-button proxy-add-button"/);

  const artifacts = source("ScientificArtifacts.tsx");
  assert.match(artifacts, /className="secondary-button compact-button"[\s\S]*?>Download script</);
  assert.match(artifacts, /className="secondary-button compact-button"[\s\S]*?>Attach to next message</);
  assert.match(artifacts, /aria-label="Zoom dashboard out" className="icon-button"/);
  assert.match(artifacts, /aria-label="Zoom dashboard in" className="icon-button"/);
});

test("container-styled button groups retain their dedicated skeleton", () => {
  const settings = source("styles/settings.css");
  assert.match(settings, /\.config-panel \.specialist-actions \.primary-button,[\s\S]*?\.config-panel \.remote-host-form \.primary-button \{ width: auto; \}/);
  assert.match(source("styles/workspace.css"), /\.paper-actions button \{ min-height: 34px;/);
  assert.match(source("styles/memory-graph.css"), /\.memory-explorer-search button \{ border:/);
});

test("configuration text controls share a safe primitive skeleton", () => {
  const primitives = source("styles/primitives.css");
  const dialogs = source("styles/dialogs.css");
  const tokens = source("styles/tokens.css");

  assert.match(primitives, /\.config-panel :where\([\s\S]*?select,[\s\S]*?textarea[\s\S]*?min-height: var\(--control-min-height\)/);
  assert.match(primitives, /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\):not\(\[type="file"\]\)/);
  assert.match(primitives, /\.secondary-button\.compact-button,[\s\S]*?\.danger-button\.compact-button \{ min-height: 34px;/);
  assert.match(tokens, /--control-min-height: 40px;/);
  assert.doesNotMatch(dialogs, /\.config-panel input \{/);
});

test("environment settings poll bootstrap progress and expose a failed retry action", () => {
  const environments = source("EnvironmentManager.tsx");
  assert.match(environments, /setup\?\.state !== "installing"/);
  assert.match(environments, /window\.setInterval/);
  assert.match(environments, /\{setup\.message\} · Phase: \{setup\.phase\}/);
  assert.match(environments, /Retry Python environment setup/);
  assert.match(environments, /setup\.error/);
  assert.doesNotMatch(environments, /Install managed Python and R environments/);
});
