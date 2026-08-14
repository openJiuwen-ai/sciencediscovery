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

import { ReviewerControlCard } from "../src/ReviewerControlCard.js";

test("Reviewer control card shows read-only settings and the manual action", () => {
  const html = renderToStaticMarkup(createElement(ReviewerControlCard, {
    busy: false,
    onRun: () => undefined,
    settings: { enabled: true, level: "deep" },
  }));

  assert.match(html, /Reviewer Specialist/);
  assert.match(html, /Built-in Specialist/);
  assert.match(html, />On</);
  assert.match(html, />Level</);
  assert.match(html, />Deep</);
  assert.match(html, />Run review</);
  assert.doesNotMatch(html, /<select/);
  assert.doesNotMatch(html, /role="switch"/);
});

test("Reviewer control card exposes Reviewing while a review is running", () => {
  const html = renderToStaticMarkup(createElement(ReviewerControlCard, {
    busy: true,
    onRun: () => undefined,
    settings: { enabled: true, level: "quick" },
  }));

  assert.match(html, /Reviewing…/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, />Run review</);
});

test("Reviewer control card is absent when settings are off", () => {
  const html = renderToStaticMarkup(createElement(ReviewerControlCard, {
    busy: false,
    onRun: () => undefined,
    settings: { enabled: false, level: "deep" },
  }));

  assert.equal(html, "");
});
