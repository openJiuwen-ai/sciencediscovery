// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiClient } from "../src/api/client.js";
import { RunnerEnvironmentSettings } from "../src/RunnerEnvironmentSettings.js";

test("global manager identifies the Runner and separates workspaces from Python/R", () => {
  const html = renderToStaticMarkup(createElement(RunnerEnvironmentSettings, { client: new ApiClient(""), onError: () => undefined }));
  assert.match(html, /Manage Runner/);
  assert.match(html, /Python \/ R environments/);
  assert.match(html, /Workspaces/);
  assert.doesNotMatch(html, /<option[^>]*>Local Runner/, "Runner options come from the catalog, never hardcoded health");
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
