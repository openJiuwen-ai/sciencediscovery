// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ModelProfile } from "@sciencediscovery/schema";
import type { SettingsApiClient } from "../src/api/settings.js";
import { ConversationalModelCard } from "../src/configuration/ConversationalModelCard.js";
import { ModelConnectWizard } from "../src/ModelConnectWizard.js";
import { LocaleProvider } from "../src/i18n/index.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("an existing model is applied only after the user confirms the visible session scope", async () => {
  const model = { id: "vision", model: "vision", name: "Vision model", providerId: "provider" } as ModelProfile;
  const applied: string[] = [];
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ConversationalModelCard, {
      client: {} as SettingsApiClient,
      models: [model],
      onApply: async (selected) => { applied.push(selected.id); },
      onDismiss: () => undefined,
      onModelsChange: () => undefined,
      onProvidersChange: () => undefined,
      pendingTask: true,
      presets: [],
      providers: [],
    })));
  });
  assert.deepEqual(applied, []);
  const card = renderer!.root.findByProps({ id: "conversation-configuration-card" });
  const text = JSON.stringify(renderer!.toJSON());
  assert.match(text, /This session only; other sessions stay unchanged/);
  assert.match(text, /Submit the draft task after the model is applied/);
  await act(async () => {
    await card.findByProps({ className: "primary-button" }).props.onClick();
  });
  assert.deepEqual(applied, ["vision"]);
  await act(async () => {
    card.findByProps({ className: "secondary-button conversation-configuration-connect-more" }).props.onClick();
  });
  assert.match(JSON.stringify(renderer!.toJSON()), /Select a provider and enter its API key/);
  assert.equal(renderer!.root.findByType(ModelConnectWizard).props.setFirstModelAsGlobalDefault, false);
});

test("an empty registry offers first-model connection with an explicit global scope", async () => {
  let savedOverrides: unknown;
  const applied: Array<{ id: string; firstModelSetup: boolean }> = [];
  const client = {
    getGlobalSettings: async () => ({ overrides: { enabledConnectorIds: ["pubmed"] } }),
    replaceGlobalSettings: async (overrides: unknown) => { savedOverrides = overrides; },
  } as SettingsApiClient;
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ConversationalModelCard, {
      client,
      models: [],
      onApply: async (model, firstModelSetup) => { applied.push({ id: model.id, firstModelSetup }); },
      onDismiss: () => undefined,
      onModelsChange: () => undefined,
      onProvidersChange: () => undefined,
      pendingTask: false,
      presets: [],
      providers: [],
    })));
  });
  const text = JSON.stringify(renderer!.toJSON());
  assert.match(text, /Connect your first model/);
  assert.match(text, /Global default; existing and future sessions that inherit it/);
  const wizard = renderer!.root.findByType(ModelConnectWizard);
  assert.equal(wizard.props.setFirstModelAsGlobalDefault, true);
  await wizard.props.onDefaultModelSet("first-model");
  assert.deepEqual(savedOverrides, { enabledConnectorIds: ["pubmed"], modelId: "first-model" });
  await act(async () => {
    wizard.props.onSuccess({ id: "first-model", model: "first-model", name: "First", providerId: "provider" } as ModelProfile);
  });
  assert.deepEqual(applied, [{ id: "first-model", firstModelSetup: true }]);
});
