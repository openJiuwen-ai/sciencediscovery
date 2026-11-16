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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stagedProxyServer } from "../src/App.js";

// Switching an existing custom_url proxy entry to environment/system must not
// carry the stored URL into the save: the server rejects a url on
// non-custom_url kinds, and the edit form prefills the URL from the entry and
// then hides the input on the kind switch, so no UI path clears it. The staged
// record is what the PUT body is built from, so dropping the field here is
// what keeps the documented kind switch savable (it used to 500).

const stored = {
  createdAt: "2026-01-01T00:00:00Z",
  hasUrl: true,
  id: "primary",
  kind: "custom_url",
  name: "Primary corporate proxy",
  updatedAt: "2026-01-01T00:00:00Z",
  url: "http://research%40team:p%40ss%3Aword@proxy.example.test:8080/",
};

test("switching a custom_url entry to environment drops the stored URL from the staged record and the PUT body", () => {
  const staged = stagedProxyServer(stored, { kind: "environment", name: stored.name, url: stored.url });
  // The staged record no longer carries the URL: saveProxyDraft's PUT gate
  // (`server.url !== undefined`) therefore omits it, and JSON.stringify drops
  // the explicit undefined, so the request body has no url field at all.
  assert.equal(staged.kind, "environment");
  assert.equal("url" in staged && staged.url, undefined);
  const body = JSON.stringify({ name: staged.name, kind: staged.kind, ...(staged.url !== undefined ? { url: staged.url } : {}) });
  assert.doesNotMatch(body, /proxy\.example\.test/);
  assert.doesNotMatch(body, /"url"/);
});

test("the same switch to system drops the URL too", () => {
  const staged = stagedProxyServer(stored, { kind: "system", name: stored.name, url: stored.url });
  assert.equal(staged.kind, "system");
  assert.equal(staged.url, undefined);
});

test("a plain rename keeps the custom_url URL, and a custom_url target keeps a typed one", () => {
  const renamed = stagedProxyServer(stored, { kind: "custom_url", name: "Renamed", url: stored.url });
  assert.equal(renamed.url, stored.url);
  const promoted = stagedProxyServer({ ...stored, kind: "environment", url: undefined }, { kind: "custom_url", name: "Promoted", url: "http://proxy.example.test:8080" });
  assert.equal(promoted.url, "http://proxy.example.test:8080");
});

test("the editor submit path gates the URL on the target kind", () => {
  const source = readFileSync(new URL("../src/ProxySettingsEditor.tsx", import.meta.url), "utf8");
  // The edit path must match the create path's kind gate: forwarding a URL
  // for a non-custom_url kind is what made the switch unsavable.
  assert.match(source, /if \(editing\) \{\s*await onUpdate\(editing\.id, \{\s*kind: draft\.kind,\s*name: draft\.name,\s*\.\.\.\(draft\.kind === "custom_url" && draft\.url\.trim\(\) \? \{ url: draft\.url\.trim\(\) \} : \{\}\),/);
});

test("saveProxyDraft stages both the edit and the create path through the kind gate", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  // The edit merge goes through stagedProxyServer; the deferred create (form
  // open, global save clicked) applies the same gate before staging the new
  // entry, and its hasUrl flag follows the target kind as well.
  assert.match(source, /server\.id === editingId \? stagedProxyServer\(server, form\) : server/);
  assert.match(source, /const staged = form\.kind === "custom_url" \? \{ \.\.\.form \} : \{ \.\.\.form, url: undefined \};/);
  assert.match(source, /hasUrl: form\.kind === "custom_url" && Boolean\(form\.url\)/);
});
