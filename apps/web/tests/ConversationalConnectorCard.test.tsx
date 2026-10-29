// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ConnectorConfigurationRequest } from "@sciencediscovery/schema";
import { ConversationalConnectorCard } from "../src/configuration/ConversationalConnectorCard.js";
import { LocaleProvider } from "../src/i18n/index.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("CFG connector card waits for user confirmation and shows the session-only impact", async () => {
  const decisions: string[] = [];
  const request: ConnectorConfigurationRequest = {
    id: "request-1", sessionId: "session-1", projectId: "project-1", runId: "run-1",
    connectorId: "pubmed", connectorName: "PubMed", reason: "Needed for this task",
    baselineConnectorIds: [], state: "awaiting_confirmation", createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z",
  };
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ConversationalConnectorCard, {
      request, runActive: false, onDecision: async (decision) => { decisions.push(decision); },
    })));
  });
  const rendered = JSON.stringify(renderer!.toJSON());
  assert.match(rendered, /Enable PubMed/);
  assert.match(rendered, /This session only; other sessions stay unchanged/);
  assert.deepEqual(decisions, []);
  await act(async () => {
    renderer!.root.findByProps({ className: "primary-button" }).props.onClick();
  });
  assert.deepEqual(decisions, ["apply"]);
  await act(async () => {
    renderer!.update(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ConversationalConnectorCard, {
      request: { ...request, reason: "USER_REQUESTED_CONNECTOR" }, runActive: false,
      onDecision: async () => undefined,
    })));
  });
  assert.match(JSON.stringify(renderer!.toJSON()), /You requested PubMed for this session/);
});

test("CFG low-risk connector card shows the cancel window and automatic task continuation", async () => {
  const request: ConnectorConfigurationRequest = {
    id: "request-auto", sessionId: "session-1", projectId: "project-1", runId: "run-1",
    connectorId: "pubmed", connectorName: "PubMed", reason: "CONNECTOR_REQUIRED_FOR_TASK",
    baselineConnectorIds: [], state: "awaiting_confirmation",
    autoApplyAt: new Date(Date.now() + 30_000).toISOString(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ConversationalConnectorCard, {
      request, runActive: false, onDecision: async () => undefined,
    })));
  });
  assert.match(JSON.stringify(renderer!.toJSON()), /Pre-authorized low-risk change: applies automatically in 30s/);
  await act(async () => {
    renderer!.update(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ConversationalConnectorCard, {
      request: { ...request, state: "applied", continuationRunId: "configuration-request-auto" },
      runActive: false, onDecision: async () => undefined,
    })));
  });
  const applied = JSON.stringify(renderer!.toJSON());
  assert.match(applied, /PubMed enabled · this session only/);
  const disclosure = renderer!.root.findByType("details");
  assert.equal(disclosure.props.open, false);
  assert.equal(renderer!.root.findAllByType("button").length, 0);
  assert.match(applied, /The paused task is resuming/);
  await act(async () => {
    const target = { open: true };
    disclosure.props.onToggle({ target, currentTarget: target });
  });
  assert.equal(renderer!.root.findByType("details").props.open, true);
  await act(async () => {
    const target = { open: false };
    renderer!.root.findByType("details").props.onToggle({ target, currentTarget: target });
  });
  assert.equal(renderer!.root.findByType("details").props.open, false);
  await act(async () => { renderer!.unmount(); });
});

test("CFG actions stay disabled until the source tool batch reaches its checkpoint", async () => {
  const request: ConnectorConfigurationRequest = {
    id: "request-running", sessionId: "session-1", projectId: "project-1", runId: "run-1",
    connectorId: "pubmed", connectorName: "PubMed", reason: "CONNECTOR_REQUIRED_FOR_TASK",
    baselineConnectorIds: [], state: "awaiting_confirmation",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(LocaleProvider, { initialLocale: "en" },
    createElement(ConversationalConnectorCard, { request, runActive: true, onDecision: async () => undefined }))); });
  assert.equal(renderer!.root.findByProps({ className: "primary-button" }).props.disabled, true);
  assert.equal(renderer!.root.findByProps({ className: "secondary-button" }).props.disabled, true);
  await act(async () => { renderer!.unmount(); });
});
