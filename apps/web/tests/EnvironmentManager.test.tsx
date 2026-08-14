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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { EnvironmentSourceSettingsEditor } from "../src/EnvironmentManager.js";

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
