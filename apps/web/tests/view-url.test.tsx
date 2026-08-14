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

import { isPrimaryViewChange, parseViewState, serializeViewState, type ViewState } from "../src/view-url.js";

function assertRoundTrip(view: ViewState): void {
  const { pathname, search } = serializeViewState(view);
  assert.deepEqual(parseViewState(pathname, search), view, `${pathname}${search}`);
}

test("the full path table serializes and parses back", () => {
  assert.equal(serializeViewState({}).pathname, "/");
  assert.equal(serializeViewState({ view: "usage" }).pathname, "/usage");
  assert.equal(serializeViewState({ settingsKind: "system", settingsGroup: "models" }).pathname, "/settings/models");
  assert.equal(serializeViewState({ projectId: "p1" }).pathname, "/projects/p1");
  assert.equal(serializeViewState({ projectId: "p1", settingsKind: "project", settingsTargetId: "p1" }).pathname, "/projects/p1/settings");
  assert.equal(serializeViewState({ projectId: "p1", sessionId: "s1" }).pathname, "/projects/p1/sessions/s1");
  assert.equal(
    serializeViewState({ projectId: "p1", sessionId: "s1", settingsKind: "session", settingsTargetId: "s1" }).pathname,
    "/projects/p1/sessions/s1/settings",
  );

  assertRoundTrip({ view: "usage" });
  assertRoundTrip({ settingsKind: "system", settingsGroup: "timeouts" });
  assertRoundTrip({ projectId: "p1" });
  assertRoundTrip({ projectId: "p1", settingsKind: "project", settingsTargetId: "p1" });
  assertRoundTrip({ projectId: "p1", sessionId: "s1" });
  assertRoundTrip({ projectId: "p1", sessionId: "s1", settingsKind: "session", settingsTargetId: "s1" });
  // A scoped settings dialog for a non-active resource names its target.
  assert.equal(serializeViewState({ projectId: "p1", settingsKind: "project", settingsTargetId: "p9" }).pathname, "/projects/p9/settings");
  assert.equal(
    serializeViewState({ projectId: "p1", sessionId: "s1", settingsKind: "session", settingsTargetId: "s9" }).pathname,
    "/projects/p1/sessions/s9/settings",
  );
});

test("settings layer wins the path over usage and session", () => {
  // While a settings dialog is open the path names the dialog; the underlying
  // view is restored when it closes (app state), not from the URL.
  assert.equal(serializeViewState({ settingsKind: "system", settingsGroup: "global", view: "usage" }).pathname, "/settings/global");
  assert.equal(
    serializeViewState({ projectId: "p1", sessionId: "s1", settingsKind: "session", settingsTargetId: "s1", view: "usage" }).pathname,
    "/projects/p1/sessions/s1/settings",
  );
});

test("query keys: only filter, panel and artifact, defaults omitted", () => {
  assert.deepEqual(serializeViewState({ projectId: "p1", sessionId: "s1" }), { pathname: "/projects/p1/sessions/s1", search: "" });
  assert.equal(serializeViewState({ sessionFilter: "active", workspaceOpen: true }).search, "?panel=open");
  assert.equal(serializeViewState({ sessionFilter: "archived" }).search, "?filter=archived");
  assert.equal(serializeViewState({ sessionFilter: "all", workspaceOpen: false }).search, "?filter=all&panel=collapsed");
  assertRoundTrip({ projectId: "p1", sessionFilter: "archived", sessionId: "s9" });
  assertRoundTrip({ workspaceOpen: false });
  assertRoundTrip({ workspaceOpen: true });
});

test("artifact keeps slashes readable and round-trips nested paths", () => {
  const { search } = serializeViewState({ artifact: "figures/chart.svg" });
  assert.equal(search, "?artifact=figures/chart.svg");
  assert.ok(!search.includes("%2F"));
  assertRoundTrip({ artifact: "subagents/agent-9/report final.html", projectId: "p1", sessionId: "s1" });
  // Both raw and percent-encoded slashes parse to the same name.
  assert.equal(parseViewState("/", "?artifact=figures%2Fchart.svg").artifact, "figures/chart.svg");
  assert.equal(parseViewState("/", "?artifact=figures/chart.svg").artifact, "figures/chart.svg");
});

test("unknown paths and legacy query-only links land on the default view", () => {
  assert.deepEqual(parseViewState("/no-such-page", ""), {});
  assert.deepEqual(parseViewState("/settings", ""), {});
  assert.deepEqual(parseViewState("/settings/Not A Group", ""), {});
  assert.deepEqual(parseViewState("/projects", ""), {});
  // The legacy query-only form is not parsed at all.
  assert.deepEqual(parseViewState("/", "?project=p1&session=s1&settings=system&workspace=open"), {});
  // Unknown trailing segments degrade to the nearest known resource.
  assert.deepEqual(parseViewState("/projects/p1/unknown", ""), { projectId: "p1" });
  assert.deepEqual(parseViewState("/projects/p1/sessions/s1/extra/deep", ""), { projectId: "p1", sessionId: "s1" });
  // Unknown query keys and values are ignored.
  assert.deepEqual(parseViewState("/usage", "?filter=everything&panel=sideways&menu=1"), { view: "usage" });
});

test("only crossing a main-view boundary counts as a primary change", () => {
  const base: ViewState = { projectId: "p1", sessionId: "s1", workspaceOpen: true };
  // Refinements: settings group, list filter, panel.
  assert.equal(isPrimaryViewChange({ ...base, settingsKind: "system", settingsGroup: "global" }, { ...base, settingsKind: "system", settingsGroup: "models" }), false);
  assert.equal(isPrimaryViewChange(base, { ...base, sessionFilter: "archived" }), false);
  assert.equal(isPrimaryViewChange(base, { ...base, workspaceOpen: false }), false);
  // Main-view boundaries.
  assert.equal(isPrimaryViewChange(base, { ...base, sessionId: "s2" }), true);
  assert.equal(isPrimaryViewChange(base, { ...base, projectId: "p2" }), true);
  assert.equal(isPrimaryViewChange(base, { ...base, view: "usage" }), true);
  assert.equal(isPrimaryViewChange(base, { ...base, settingsKind: "system", settingsGroup: "global" }), true);
  assert.equal(isPrimaryViewChange({ ...base, settingsKind: "system" }, base), true);
  assert.equal(isPrimaryViewChange(base, { ...base, settingsKind: "session", settingsTargetId: "s1" }), true);
  assert.equal(isPrimaryViewChange(base, { ...base, artifact: "a.csv" }), true);
});
