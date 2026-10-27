// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import type { ChatMessage, ConnectorConfigurationRequest, SessionRun } from "@sciencediscovery/schema";
import { connectorConfigurationPresentation } from "../src/configuration/presentation.js";

const request: ConnectorConfigurationRequest = {
  id: "request-1", sessionId: "session-1", projectId: "project-1", runId: "run-1",
  connectorId: "pubmed", connectorName: "PubMed", reason: "CONNECTOR_REQUIRED_FOR_TASK",
  baselineConnectorIds: [], state: "applied", continuationRunId: "configuration-request-1",
  createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:03.000Z",
};
const continuation: SessionRun = {
  id: "configuration-request-1", sessionId: "session-1", prompt: "Search PubMed",
  createdAt: "2026-10-15T00:00:02.000Z", queueOrder: 2, status: "running",
  userMessageId: "notice-1", annotationIds: [], references: [],
  settingsSnapshot: { enabledConnectorIds: ["pubmed"], enabledSkillIds: [], enabledSkillLibraries: [],
    modelId: "model-1", semanticReviewEnabled: false, skillSelectionMode: "all", thinkingMode: "auto" },
  configurationContinuation: { requestId: "request-1", sourceRunId: "run-1", connectorName: "PubMed" },
};
const notice: ChatMessage = {
  id: "notice-1", role: "user", kind: "configuration_notice", content: "",
  createdAt: "2026-10-15T00:00:04.000Z",
};

test("CFG applied connector leaves one receipt after the continuation notice is saved", () => {
  const before = connectorConfigurationPresentation([request], [continuation], [], "session-1");
  assert.deepEqual(before.visibleRequests.map((item) => item.id), ["request-1"]);
  const after = connectorConfigurationPresentation([request], [continuation], [notice], "session-1");
  assert.deepEqual(after.visibleRequests, []);
  assert.equal(after.continuationByNoticeId.get(notice.id)?.connectorName, "PubMed");
});

test("CFG same-run resume anchors one receipt to its deterministic notice", () => {
  const resumed: SessionRun = {
    ...continuation,
    id: "run-1",
    queueOrder: 1,
    createdAt: "2026-10-15T00:00:00.000Z",
    userMessageId: "original-question",
    configurationContinuation: undefined,
    configurationResume: { requestId: "request-1", decision: "apply", connectorName: "PubMed" },
    configurationNoticeMessageId: notice.id,
  };
  const presentation = connectorConfigurationPresentation([request], [resumed], [notice], "session-1");
  assert.deepEqual(presentation.visibleRequests, []);
  assert.equal(presentation.continuationByNoticeId.get(notice.id)?.sourceRunId, resumed.id);
});

test("CFG standalone connector setup keeps a compact receipt without a continuation", () => {
  const standalone = { ...request, runId: "user-request:1", continuationRunId: undefined };
  assert.deepEqual(connectorConfigurationPresentation([standalone], [], [], "session-1").visibleRequests, [standalone]);
});
