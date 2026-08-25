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

import type { ScientificEnvironmentSetup, ScientificEnvironmentSetupComponentStatus } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  environmentSetupActionLabel,
  EnvironmentSetupStatus,
  EnvironmentSourceSettingsEditor,
} from "../src/EnvironmentManager.js";

test("environment source settings distinguish global pip and conda mirrors", () => {
  const html = renderToStaticMarkup(createElement(EnvironmentSourceSettingsEditor, {
    busy: false,
    draft: { condaSource: "tsinghua", pipSource: "huawei" },
    onChange: () => undefined,
    onSave: () => undefined,
    saved: false,
    savedSettings: { condaSource: "upstream", pipSource: "upstream" },
  }));

  assert.match(html, /Global package sources/);
  assert.match(html, /environment-create environment-source-settings/);
  assert.match(html, /environment-source-pip/);
  assert.match(html, /environment-source-conda/);
  assert.match(html, /environment-source-summary/);
  assert.match(html, /system-wide, not Project-specific/);
  assert.match(html, /Global pip source/);
  assert.match(html, /Global conda source/);
  assert.match(html, /Official upstream/);
  assert.match(html, /Tsinghua TUNA/);
  assert.match(html, /USTC/);
  assert.match(html, /Huawei Cloud/);
  assert.match(html, /https:\/\/mirrors\.huaweicloud\.com\/repository\/pypi\/simple/);
  assert.match(html, /https:\/\/mirrors\.tuna\.tsinghua\.edu\.cn\/anaconda\/cloud\/conda-forge/);
  assert.match(html, /Save package sources/);

  const optionLabels = [...html.matchAll(/<option[^>]*>([^<]+)<\/option>/g)]
    .map((match) => match[1]);
  assert.deepEqual(optionLabels, [
    "Official upstream",
    "Tsinghua TUNA",
    "USTC",
    "Huawei Cloud",
    "Official upstream",
    "Tsinghua TUNA",
    "USTC",
  ]);
  assert.equal(optionLabels.filter((label) => label === "Huawei Cloud").length, 1);
  assert.doesNotMatch(html, /China mainland|中国大陆|地区|country|region/i);
});

function component(
  state: ScientificEnvironmentSetupComponentStatus["state"],
  phase: ScientificEnvironmentSetupComponentStatus["phase"],
  overrides: Partial<ScientificEnvironmentSetupComponentStatus> = {},
): ScientificEnvironmentSetupComponentStatus {
  return {
    action: null,
    completedAt: null,
    error: null,
    message: `${state} ${phase}`,
    phase,
    startedAt: "2026-08-23T00:00:00.000Z",
    state,
    updatedAt: "2026-08-23T00:00:00.000Z",
    ...overrides,
  };
}

function setup(components: ScientificEnvironmentSetup["components"]): ScientificEnvironmentSetup {
  return {
    allowedChannels: ["conda-forge"],
    completedAt: null,
    components,
    error: components.micromamba.error ?? components.conda.error,
    managedProvisioner: true,
    message: "Managed setup",
    networkPolicy: "allowed-channels",
    phase: "checking",
    provisioner: components.micromamba.state === "ready" ? "micromamba" : null,
    provisionerVersion: components.micromamba.state === "ready" ? "2.8.1-0" : null,
    startedAt: "2026-08-23T00:00:00.000Z",
    starterPackages: { python: ["python=3.12"], r: ["r-base=4.4"] },
    state: components.micromamba.state === "failed" || components.conda.state === "failed" ? "failed" : "installing",
    updatedAt: "2026-08-23T00:00:00.000Z",
  };
}

test("setup status shows micromamba installation separately from the pending Conda base", () => {
  const html = renderToStaticMarkup(createElement(EnvironmentSetupStatus, { setup: setup({
    conda: component("not-configured", "pending"),
    micromamba: component("installing", "downloading-provisioner"),
  }) }));
  assert.match(html, /micromamba bootstrap/);
  assert.match(html, /Downloading and verifying|installing downloading-provisioner/i);
  assert.match(html, /Phase: downloading-provisioner/);
  assert.match(html, /Conda environments/);
  assert.match(html, /Phase: pending/);
});

test("setup status preserves micromamba success beside an actionable Conda failure", () => {
  const failedSetup = setup({
    conda: component("failed", "failed", {
      action: "Review the configured Conda channels or offline cache, then retry setup.",
      error: "This operation was aborted",
      message: "Conda environment setup failed",
    }),
    micromamba: component("ready", "complete", { completedAt: "2026-08-23T00:00:01.000Z", message: "micromamba is ready" }),
  });
  const html = renderToStaticMarkup(createElement(EnvironmentSetupStatus, { setup: failedSetup }));
  assert.match(html, /micromamba 2\.8\.1-0/);
  assert.match(html, /micromamba is ready/);
  assert.match(html, /Conda environment setup failed/);
  assert.match(html, /Reported error/);
  assert.match(html, /This operation was aborted/);
  assert.match(html, /Review the configured Conda channels or offline cache, then retry setup/);
  assert.equal(environmentSetupActionLabel(failedSetup, false), "Retry Conda environment setup");
  assert.equal(environmentSetupActionLabel(setup({
    conda: component("not-configured", "pending"),
    micromamba: component("failed", "failed"),
  }), false), "Retry micromamba setup");
});
