// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseViewState, serializeViewState } from "../src/view-url.js";
import { ApiClient } from "../src/api/client.js";
import { RunnerEnvironmentSettings } from "../src/RunnerEnvironmentSettings.js";

test("Runner details keep machine, workspace and science controls under one selected Runner", () => {
  const html = renderToStaticMarkup(createElement(RunnerEnvironmentSettings, {
    client: new ApiClient(""), onError: () => undefined, runnerId: "local", machine: createElement("p", null, "Machine identity"),
  }));
  assert.match(html, /Local Runner/);
  assert.match(html, /Scientific environments/);
  assert.match(html, /Workspaces/);
  assert.match(html, /Machine identity/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /<select|Manage Runner/);
});

for (const id of ["local", "runner/b"]) {
  test(`${id} client uses the same environment/workspace routes and global sources`, async (context) => {
    const paths: string[] = [];
    context.mock.method(globalThis, "fetch", async (path: string) => { paths.push(path); return new Response("[]", { status: 200 }); });
    const client = new ApiClient("");
    const selected = client.forEnvironmentRunner(id);
    await selected.listEnvironments();
    await selected.getEnvironmentSetup();
    await selected.listEnvironmentRevisions();
    await selected.getEnvironmentSourceSettings();
    await client.listRunnerWorkspaces(id);
    await client.listRunnerWorkspaceFiles(id, "session/a");
    const base = `/api/runners/${encodeURIComponent(id)}`;
    assert.deepEqual(paths, [`${base}/environments`, `${base}/environment-setup`, `${base}/environment-revisions`, "/api/environment-source-settings", `${base}/workspaces`, `${base}/workspaces/session%2Fa/files`]);
  });
}


test("Runner settings URLs preserve opaque IDs through reload and retain old settings links", () => {
  for (const group of ["runner:local", "runner:lab/a b?#", "remote", "environments", "runner-add"]) {
    const encoded = serializeViewState({ settingsKind: "system", settingsGroup: group });
    assert.equal(parseViewState(encoded.pathname, encoded.search).settingsGroup, group);
  }
});
