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

import type { ModelProfile } from "@science-agent/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EMPTY_MODEL_DRAFT, ModelDraftFields, modelDraftFromProfile } from "../src/App.js";
import { LocaleProvider } from "../src/i18n/index.js";

function renderFields(locale: "en" | "zh-CN", draft = EMPTY_MODEL_DRAFT): string {
  return renderToStaticMarkup(createElement(
    LocaleProvider,
    { initialLocale: locale },
    createElement(ModelDraftFields, { draft, onChange: () => undefined }),
  ));
}

function inputForLabel(html: string, label: string): string {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<label><span>${escapedLabel}<\\/span>(<input [^>]*\\/>)<\\/label>`));
  assert.ok(match, `input for ${label} should be rendered`);
  return match[1]!;
}

test("new model drafts leave provider URL and model ID empty", () => {
  assert.deepEqual(EMPTY_MODEL_DRAFT, {
    baseUrl: "",
    model: "",
    name: "",
    proxyPolicy: "inherit",
    vision: false,
  });

  const html = renderFields("en");
  const baseUrlInput = inputForLabel(html, "OpenAI-compatible base URL");
  const modelInput = inputForLabel(html, "Model ID");
  assert.match(baseUrlInput, /value=""/);
  assert.match(baseUrlInput, /placeholder="Usually ends with v1"/);
  assert.match(modelInput, /value=""/);
  assert.doesNotMatch(modelInput, /placeholder=/);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /gpt-4o-mini/i);
});

test("model URL guidance is localized without becoming the field value", () => {
  const english = renderFields("en");
  const chinese = renderFields("zh-CN");

  assert.match(inputForLabel(english, "OpenAI-compatible base URL"), /placeholder="Usually ends with v1"/);
  assert.match(inputForLabel(chinese, "OpenAI 兼容的基础 URL"), /placeholder="一般以 v1 结尾"/);
  assert.match(inputForLabel(english, "OpenAI-compatible base URL"), /value=""/);
  assert.match(inputForLabel(chinese, "OpenAI 兼容的基础 URL"), /value=""/);
  assert.doesNotMatch(`${english}${chinese}`, /https?:\/\//i);
});

test("editing a saved model preserves its URL and model ID", () => {
  const profile: ModelProfile = {
    baseUrl: "https://saved.example.test/v1",
    createdAt: "2026-08-13T00:00:00.000Z",
    hasApiToken: true,
    id: "saved-model",
    model: "saved-model-id",
    name: "Saved model",
    proxyPolicy: "none",
    updatedAt: "2026-08-13T00:00:00.000Z",
    vision: true,
  };

  const draft = modelDraftFromProfile(profile);
  assert.deepEqual(draft, {
    baseUrl: profile.baseUrl,
    model: profile.model,
    name: profile.name,
    proxyPolicy: profile.proxyPolicy,
    vision: profile.vision,
  });

  const html = renderFields("en", draft);
  assert.match(inputForLabel(html, "OpenAI-compatible base URL"), /value="https:\/\/saved\.example\.test\/v1"/);
  assert.match(inputForLabel(html, "Model ID"), /value="saved-model-id"/);
});
