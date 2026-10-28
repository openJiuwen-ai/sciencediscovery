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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { translate } from "../src/i18n/index.js";

const sourceRoot = new URL("../src/", import.meta.url);

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, sourceRoot), "utf8");
}

// Issue #40: at ~900px the sidebar used to become a full-width block stacked
// over the top half of the page, pushing the conversation and the composer
// out of the first screen. Below ~1024px it is now an off-canvas drawer.
test("below ~1024px the sidebar leaves the grid and hides off-canvas until opened", () => {
  const responsive = source("styles/responsive.css");

  assert.match(responsive, /@media \(max-width: 1024px\) \{\s*\.app-shell \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(responsive, /@media \(max-width: 1024px\)[\s\S]*?\.sidebar \{ position: fixed;[^}]*z-index: var\(--z-overlay-high\);[^}]*width: min\(320px, 88vw\);[^}]*transform: translateX\(-102%\);[^}]*visibility: hidden;/);
  assert.match(responsive, /\.sidebar\.drawer-open \{ transform: translateX\(0\); visibility: visible;/);
  assert.match(responsive, /@media \(max-width: 1024px\)[\s\S]*?\.sidebar-drawer-toggle \{ display: grid; \}/);
  assert.match(responsive, /@media \(max-width: 1024px\)[\s\S]*?\.sidebar-drawer-backdrop \{ display: block; \}/);
  assert.match(responsive, /@media \(max-width: 1024px\)[\s\S]*?\.sidebar-drawer-close \{ display: grid; \}/);

  // The stacked layout that pushed the composer out of the first screen is gone.
  assert.doesNotMatch(responsive, /\.app-shell \{ display: block; \}/);
  assert.doesNotMatch(responsive, /\.sidebar \{ position: relative; width: 100%/);
  assert.doesNotMatch(responsive, /\.main-area \{ height: auto; min-height: 100vh; \}/);

  // The wide sidebar keeps its in-flow column above the drawer band.
  assert.match(responsive, /@media \(max-width: 1180px\) \{\s*\.app-shell \{ grid-template-columns: 240px minmax\(0, 1fr\); \}/);
});

test("at ~900px the conversation and composer keep the first screen", () => {
  const responsive = source("styles/responsive.css");

  // Messages scroll inside the conversation instead of growing the page, and
  // the workspace panel becomes a capped bottom strip instead of competing
  // for the first screen.
  assert.match(responsive, /@media \(max-width: 900px\) \{\s*\.content-grid \{ display: flex; flex-direction: column; \}/);
  assert.match(responsive, /\.conversation \{ flex: 1 1 auto; min-height: 0; border-right: 0; \}/);
  assert.match(responsive, /\.workspace-panel \{ flex: 0 0 auto; max-height: 42vh; border-top: 1px solid var\(--border\); \}/);
  assert.doesNotMatch(responsive, /\.conversation \{ min-height: 720px/);
});

test("the drawer is wired with a toggle, dialog semantics, and close affordances", () => {
  const app = source("App.tsx");

  // A persistent toggle opens the drawer and controls the sidebar region.
  assert.match(app, /className="sidebar-drawer-toggle"/);
  assert.match(app, /aria-controls="app-sidebar"/);
  assert.match(app, /aria-expanded=\{sidebarDrawerOpen\}/);
  // The open drawer presents itself as a modal dialog with a close button.
  assert.match(app, /className=\{sidebarDrawerOpen \? "sidebar drawer-open" : "sidebar"\}/);
  assert.match(app, /role=\{sidebarDrawerOpen \? "dialog" : undefined\}/);
  assert.match(app, /aria-modal=\{sidebarDrawerOpen \? "true" : undefined\}/);
  assert.match(app, /className="icon-button sidebar-drawer-close"/);
  assert.match(app, /className="sidebar-drawer-backdrop"/);
  // Escape closes the drawer, and widening past the breakpoint cannot leave an
  // invisible drawer marked open.
  assert.match(app, /matchMedia\("\(max-width: 1024px\)"\)/);
  // Navigation and modal entries reached from the drawer close it.
  assert.match(app, /useEffect\(\(\) => \{\s*setSidebarDrawerOpen\(false\);\s*\}, \[activeProjectId, activeSessionId, workspaceView\]\)/);
  // The fixed drawer takes no layout width, so the workspace budget ignores it.
  assert.match(app, /getComputedStyle\(sidebar\)\.position === "fixed"/);
});

test("drawer chrome labels are localized", () => {
  assert.equal(translate("en", "app.openNavigation"), "Open navigation");
  assert.equal(translate("en", "app.closeNavigation"), "Close navigation");
  assert.equal(translate("zh-CN", "app.openNavigation"), "打开导航");
  assert.equal(translate("zh-CN", "app.closeNavigation"), "关闭导航");
});
