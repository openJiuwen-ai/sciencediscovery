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

import type { DeletionImpact, RuntimeSettingsDetails } from "@science-agent/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  clampSidebarSplit,
  DeletionDialog,
  inlineRenameInputColumns,
  InlineRenameInput,
  normalizedInlineRename,
  ProjectOverflowMenu,
  ProjectCreationDialog,
  selectAfterRemoval,
  SessionFilterMenu,
  SessionOverflowMenu,
  SidebarPanelResizer,
  SidebarSectionHeader,
} from "../src/ManagementControls.js";

const impact: DeletionImpact = {
  activeSessionCount: 1,
  archivedSessionCount: 2,
  dataCategories: ["messages", "workspace files", "audit ledgers"],
  sessionIds: ["session-1", "session-2", "session-3"],
  targetId: "project-1",
  targetType: "project",
  totalSessionCount: 3,
};

const inheritedSettings: RuntimeSettingsDetails = {
  effective: {
    enabledConnectorIds: [],
    enabledSkillIds: [],
    semanticReviewEnabled: true,
  },
  overrides: { semanticReviewEnabled: false },
  sources: {
    enabledConnectorIds: "global",
    enabledSkillIds: "global",
    modelId: "unset",
    reviewModelId: "unset",
    semanticReviewEnabled: "global",
  },
};

test("renders Project creation in a popup with inherited settings", () => {
  const dialog = renderToStaticMarkup(createElement(ProjectCreationDialog, {
    connectors: [],
    details: inheritedSettings,
    models: [],
    onCancel: () => undefined,
    onCreate: () => undefined,
    skills: [],
  }));

  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /Project name/);
  assert.match(dialog, /All settings inherit by default/);
  assert.match(dialog, /value="inherit" selected=""/);
  assert.match(dialog, />Create Project<\/button>/);
});

test("renders a collapsible sidebar header with an add button", () => {
  const header = renderToStaticMarkup(createElement(SidebarSectionHeader, {
    addLabel: "Add project",
    count: 3,
    expanded: false,
    label: "Projects",
    onAdd: () => undefined,
    onToggle: () => undefined,
    panelId: "projects-panel-content",
  }));

  assert.match(header, /aria-controls="projects-panel-content"/);
  assert.match(header, /aria-expanded="false"/);
  assert.match(header, />Projects</);
  assert.match(header, /aria-label="Add project"/);
  assert.match(header, /class="icon-button sidebar-add-button"[^>]*><svg/);
});

test("can disable a sidebar add button while creation is pending", () => {
  const header = renderToStaticMarkup(createElement(SidebarSectionHeader, {
    addDisabled: true,
    addLabel: "Add session",
    count: 2,
    expanded: true,
    label: "Sessions",
    onAdd: () => undefined,
    onToggle: () => undefined,
    panelId: "sessions-panel-content",
  }));

  assert.match(header, /aria-label="Add session"[^>]*disabled=""/);
});

test("renders Project actions behind one ellipsis menu trigger", () => {
  const closed = renderToStaticMarkup(createElement(ProjectOverflowMenu, {
    label: "Cancer research",
    onDelete: () => undefined,
    onRename: () => undefined,
    onSettings: () => undefined,
    onToggle: () => undefined,
    open: false,
    projectId: "project-1",
  }));
  const open = renderToStaticMarkup(createElement(ProjectOverflowMenu, {
    label: "Cancer research",
    onDelete: () => undefined,
    onRename: () => undefined,
    onSettings: () => undefined,
    onToggle: () => undefined,
    open: true,
    projectId: "project-1",
  }));

  assert.match(closed, /aria-label="More actions for Cancer research"/);
  assert.match(closed, /class="resource-menu project-menu"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /class="icon-button resource-menu-trigger"[^>]*><svg/);
  assert.doesNotMatch(closed, /role="menu"/);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /class="resource-menu project-menu open"/);
  assert.match(open, /role="menu"/);
  assert.match(open, />Rename<\/span>/);
  assert.match(open, />Settings<\/span>/);
  assert.match(open, />Delete<\/span>/);
});

test("keeps Session filters in a header popover", () => {
  const closed = renderToStaticMarkup(createElement(SessionFilterMenu, {
    onChange: () => undefined,
    onToggle: () => undefined,
    open: false,
    value: "active",
  }));
  const open = renderToStaticMarkup(createElement(SessionFilterMenu, {
    onChange: () => undefined,
    onToggle: () => undefined,
    open: true,
    value: "archived",
  }));

  assert.match(closed, /aria-label="Filter Sessions, currently active"/);
  assert.doesNotMatch(closed, /role="menu"/);
  assert.match(open, /aria-label="Session state filter"/);
  assert.match(open, /role="menuitemradio"/);
  assert.match(open, />Active<\/span>/);
  assert.match(open, />Archived<\/span>/);
  assert.match(open, />All<\/span>/);
});

test("renders settings and lifecycle actions behind every Session ellipsis", () => {
  const menu = renderToStaticMarkup(createElement(SessionOverflowMenu, {
    archived: false,
    label: "Literature review",
    onArchive: () => undefined,
    onDelete: () => undefined,
    onRename: () => undefined,
    onRestore: () => undefined,
    onSettings: () => undefined,
    onToggle: () => undefined,
    open: true,
    sessionId: "session-1",
  }));
  const archivedMenu = renderToStaticMarkup(createElement(SessionOverflowMenu, {
    archived: true,
    label: "Archived review",
    onArchive: () => undefined,
    onDelete: () => undefined,
    onRename: () => undefined,
    onRestore: () => undefined,
    onSettings: () => undefined,
    onToggle: () => undefined,
    open: true,
    sessionId: "session-2",
  }));

  assert.match(menu, /aria-label="More actions for Literature review"/);
  assert.match(menu, /class="resource-menu session-menu open"/);
  assert.match(menu, />Rename<\/span>/);
  assert.match(menu, />Settings<\/span>/);
  assert.match(menu, />Archive<\/span>/);
  assert.match(menu, />Delete<\/span>/);
  assert.match(archivedMenu, /disabled=""[^>]*><span aria-hidden="true"><svg.*<\/svg><\/span><span>Rename<\/span>/);
  assert.match(archivedMenu, />Restore<\/span>/);
});

test("renders a compact inline rename input without confirmation controls", () => {
  const input = renderToStaticMarkup(createElement(InlineRenameInput, {
    ariaLabel: "Rename Session Literature review",
    onChange: () => undefined,
    onCommit: () => undefined,
    size: 18,
    value: "Literature review",
  }));

  assert.match(input, /^<input /);
  assert.match(input, /aria-label="Rename Session Literature review"/);
  assert.match(input, /autofocus=""/);
  assert.match(input, /maxLength="120"/);
  assert.match(input, /size="18"/);
  assert.match(input, /value="Literature review"/);
  assert.doesNotMatch(input, /button|dialog/);
});

test("sizes inline rename inputs from Unicode title length within stable bounds", () => {
  assert.equal(inlineRenameInputColumns("short"), 8);
  assert.equal(inlineRenameInputColumns("分析 RNA 数据"), 10);
  assert.equal(inlineRenameInputColumns("x".repeat(80)), 40);
});

test("normalizes inline names and ignores empty or unchanged edits", () => {
  assert.equal(normalizedInlineRename("  Updated title  ", "Original title"), "Updated title");
  assert.equal(normalizedInlineRename("Original title", "Original title"), undefined);
  assert.equal(normalizedInlineRename("   ", "Original title"), undefined);
});

test("renders an accessible draggable sidebar separator and clamps its split", () => {
  const separator = renderToStaticMarkup(createElement(SidebarPanelResizer, {
    onChange: () => undefined,
    onResizeEnd: () => undefined,
    onResizeStart: () => undefined,
    resizing: false,
    value: 36,
  }));

  assert.match(separator, /role="separator"/);
  assert.match(separator, /aria-orientation="horizontal"/);
  assert.match(separator, /aria-valuenow="36"/);
  assert.equal(clampSidebarSplit(5), 20);
  assert.equal(clampSidebarSplit(50), 50);
  assert.equal(clampSidebarSplit(90), 75);
});

test("keeps every session lifecycle action reachable from the sidebar overflow menu", () => {
  const activeMenu = renderToStaticMarkup(createElement(SessionOverflowMenu, {
    archived: false,
    label: "Session A",
    onArchive: () => undefined,
    onDelete: () => undefined,
    onRename: () => undefined,
    onRestore: () => undefined,
    onSettings: () => undefined,
    onToggle: () => undefined,
    open: true,
    sessionId: "session-1",
  }));
  const archivedMenu = renderToStaticMarkup(createElement(SessionOverflowMenu, {
    archived: true,
    label: "Session A",
    onArchive: () => undefined,
    onDelete: () => undefined,
    onRename: () => undefined,
    onRestore: () => undefined,
    onSettings: () => undefined,
    onToggle: () => undefined,
    open: true,
    sessionId: "session-1",
  }));

  for (const label of ["Rename", "Settings", "Archive", "Delete"]) {
    assert.match(activeMenu, new RegExp(`<span>${label}</span>`));
  }
  assert.match(archivedMenu, /<span>Restore<\/span>/);
  assert.doesNotMatch(archivedMenu, /<span>Archive<\/span>/);
});

test("renders the server deletion preview and requires an exact typed confirmation", () => {
  const blocked = renderToStaticMarkup(createElement(DeletionDialog, {
    confirmation: "wrong",
    impact,
    label: "Cancer research",
    onCancel: () => undefined,
    onChangeConfirmation: () => undefined,
    onConfirm: () => undefined,
  }));
  const confirmed = renderToStaticMarkup(createElement(DeletionDialog, {
    confirmation: "Cancer research",
    impact,
    label: "Cancer research",
    onCancel: () => undefined,
    onChangeConfirmation: () => undefined,
    onConfirm: () => undefined,
  }));

  assert.match(blocked, /Total Sessions/);
  assert.match(blocked, /workspace files/);
  assert.match(blocked, /Permanently delete/);
  assert.match(blocked, /disabled=""[^>]*>Permanently delete/);
  assert.doesNotMatch(confirmed, /disabled=""[^>]*>Permanently delete/);
});

test("keeps a valid selection and chooses the next resource after removal", () => {
  const items = [{ id: "one" }, { id: "two" }, { id: "three" }];

  assert.equal(selectAfterRemoval(items, "two", "one"), "one");
  assert.equal(selectAfterRemoval(items, "two", "two"), "one");
  assert.equal(selectAfterRemoval([{ id: "two" }], "two", "two"), undefined);
});
