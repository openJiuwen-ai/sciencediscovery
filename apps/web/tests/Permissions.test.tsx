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

import type { PermissionGrant, PermissionRequest } from "@science-agent/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PermissionCards, PermissionGrantManager } from "../src/Permissions.js";
import { permissionMatchingKey } from "../src/PermissionDecisionActions.js";
import { activityCardId } from "../src/session/run-activity.js";

const noopToggle = () => undefined;

test("allow-matching UI groups the same permission resources as the backend", () => {
  const request = {
    action: "artifact_download" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "request-download",
    resource: "pubmed:download:first.pdf",
    sessionId: "session-1",
    state: "pending" as const,
    summary: "Download first.pdf",
  };
  assert.equal(permissionMatchingKey(request), "artifact_download:pubmed:download");
  assert.equal(
    permissionMatchingKey({ ...request, id: "request-2", resource: "pubmed:download:second.pdf" }),
    permissionMatchingKey(request),
  );
  assert.notEqual(
    permissionMatchingKey({ ...request, id: "request-3", resource: "biorxiv:download:paper.pdf" }),
    permissionMatchingKey(request),
  );
});

test("permission cards collapse to a summary and fold the decision buttons away", () => {
  const request: PermissionRequest = {
    action: "code",
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "request-1",
    projectId: "project-1",
    resource: "workspace-code",
    sessionId: "session-1",
    state: "pending",
    summary: "Run Python code in the Session workspace",
  };
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    busy: false,
    expandedCards: {},
    onDecision: () => undefined,
    onToggleCard: noopToggle,
    requests: [request],
  }));
  assert.match(html, /Permission required/);
  assert.match(html, /Run local code/);
  assert.match(html, /Run Python code in the Session workspace/);
  assert.match(html, /aria-expanded="false"/);
  // The resource and decision buttons stay folded away until expanded.
  assert.doesNotMatch(html, /workspace-code/);
  assert.doesNotMatch(html, /Allow once/);
});

test("expanded permission card exposes the independent decisions", () => {
  const request: PermissionRequest = {
    action: "code",
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "request-1",
    projectId: "project-1",
    resource: "workspace-code",
    sessionId: "session-1",
    state: "pending",
    summary: "Run Python code in the Session workspace",
  };
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    busy: false,
    expandedCards: { [activityCardId("permission", request.id)]: true },
    onDecision: () => undefined,
    onToggleCard: noopToggle,
    requests: [request],
  }));
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /workspace-code/);
  assert.match(html, /class="plan-actions permission-decision-actions"/);
  assert.equal(html.match(/class="secondary-button"/g)?.length, 2);
  assert.match(html, /class="secondary-button"[^>]*>Allow once</);
  assert.match(html, /class="secondary-button"[^>]*>Allow same type</);
  assert.match(html, /class="danger-button"[^>]*>Deny</);
});

test("permission cards hide decided requests", () => {
  const request: PermissionRequest = {
    action: "connector",
    createdAt: "2026-01-01T00:00:00.000Z",
    decidedAt: "2026-01-01T00:00:05.000Z",
    decision: "allowed",
    id: "request-1",
    projectId: "project-1",
    resource: "arxiv",
    sessionId: "session-1",
    state: "allowed",
    summary: "Query the arxiv connector",
  };
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    expandedCards: {},
    onDecision: () => undefined,
    onToggleCard: noopToggle,
    requests: [request],
  }));
  assert.equal(html, "");
});

test("standing grants are listable and revocable", () => {
  const grant: PermissionGrant = {
    action: "connector",
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "grant-1",
    projectId: "project-1",
    resource: "pubmed",
    scope: "project",
    state: "active",
  };
  const html = renderToStaticMarkup(createElement(PermissionGrantManager, {
    grants: [grant],
    onRevoke: () => undefined,
  }));
  assert.match(html, /Standing permission grants/);
  assert.match(html, /pubmed · this Session/);
  assert.match(html, /Revoke/);
});
