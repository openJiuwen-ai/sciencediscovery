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

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BrandIcon, CheckIcon, SettingsIcon } from "../src/icons.js";

test("renders hidden-from-a11y SVG icons with a shared stroke system", () => {
  const html = renderToStaticMarkup(createElement(CheckIcon));

  assert.match(html, /<svg/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /stroke="currentColor"/);
  assert.match(html, /stroke-linecap="round"/);
  assert.match(html, /viewBox="0 0 24 24"/);
});

test("honours size, stroke width, and an accessible title", () => {
  const branded = renderToStaticMarkup(createElement(BrandIcon, { size: 30, title: "ScienceDiscovery" }));

  assert.match(branded, /width="30"/);
  assert.match(branded, /height="30"/);
  assert.match(branded, /role="img"/);
  assert.match(branded, /<title>ScienceDiscovery<\/title>/);
  assert.doesNotMatch(branded, /aria-hidden/);

  const gear = renderToStaticMarkup(createElement(SettingsIcon, { strokeWidth: 2.2 }));
  assert.match(gear, /stroke-width="2.2"/);
});
