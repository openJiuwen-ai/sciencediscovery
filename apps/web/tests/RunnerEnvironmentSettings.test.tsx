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
  assert.match(html, /Local Runner/);
});

test("Runner scoped client routes environments only, keeping sources global and local unchanged", async (context) => {
  const paths: string[] = [];
  context.mock.method(globalThis, "fetch", async (path: string) => { paths.push(path); return new Response("[]", { status: 200 }); });
  const client = new ApiClient("");
  assert.equal(client.forEnvironmentRunner("local"), client);
  const remote = client.forEnvironmentRunner("runner/b");
  await remote.listEnvironments();
  await remote.getEnvironmentSetup();
  await remote.listEnvironmentRevisions();
  await remote.getEnvironmentSourceSettings();
  await client.listEnvironments();
  await client.deleteRunnerWorkspace("runner/b", "session/a");
  assert.deepEqual(paths, ["/api/remote-hosts/runner%2Fb/environments", "/api/remote-hosts/runner%2Fb/environment-setup", "/api/remote-hosts/runner%2Fb/environment-revisions", "/api/environment-source-settings", "/api/environments", "/api/remote-hosts/runner%2Fb/workspaces/session%2Fa"]);
});
