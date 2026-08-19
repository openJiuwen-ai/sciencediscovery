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

import type { ModelProfile } from "@sciencediscovery/schema";
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
    apiProtocol: "openai-chat-completions",
    apiVariant: "openai",
    baseUrl: "",
    model: "",
    name: "",
    proxyPolicy: "inherit",
    thinkingEffort: "high",
    thinkingMode: "auto",
    vision: false,
  });

  const html = renderFields("en");
  const baseUrlInput = inputForLabel(html, "Chat Completions base URL");
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

  assert.match(inputForLabel(english, "Chat Completions base URL"), /placeholder="Usually ends with v1"/);
  assert.match(inputForLabel(chinese, "Chat Completions 基础 URL"), /placeholder="一般以 v1 结尾"/);
  assert.match(inputForLabel(english, "Chat Completions base URL"), /value=""/);
  assert.match(inputForLabel(chinese, "Chat Completions 基础 URL"), /value=""/);
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
    apiProtocol: "openai-chat-completions",
    apiVariant: "openai",
    baseUrl: profile.baseUrl,
    model: profile.model,
    name: profile.name,
    proxyPolicy: profile.proxyPolicy,
    thinkingEffort: "high",
    thinkingMode: "auto",
    vision: profile.vision,
  });

  const html = renderFields("en", draft);
  assert.match(inputForLabel(html, "Chat Completions base URL"), /value="https:\/\/saved\.example\.test\/v1"/);
  assert.match(inputForLabel(html, "Model ID"), /value="saved-model-id"/);
});

test("saved protocol, variant, thinking mode, and effort are shown again", () => {
  const draft = modelDraftFromProfile({
    apiProtocol: "anthropic-messages",
    apiVariant: "anthropic-legacy",
    baseUrl: "https://api.example.test/v1",
    createdAt: "2026-08-13T00:00:00.000Z",
    hasApiToken: true,
    id: "saved-anthropic",
    model: "claude-test",
    name: "Saved Anthropic",
    proxyPolicy: "inherit",
    thinkingEffort: "max",
    thinkingMode: "enabled",
    updatedAt: "2026-08-13T00:00:00.000Z",
    vision: false,
  });
  const html = renderFields("en", draft);

  assert.match(html, /<option value="anthropic-messages" selected="">Anthropic Messages<\/option>/);
  assert.match(html, /<option value="anthropic-legacy" selected="">Anthropic legacy thinking budget<\/option>/);
  assert.match(html, /<option value="enabled" selected="">Enabled<\/option>/);
  assert.match(html, /<option value="max" selected="">Max<\/option>/);
  assert.match(inputForLabel(html, "Anthropic API base URL"), /placeholder="API root or v1 endpoint"/);
});
