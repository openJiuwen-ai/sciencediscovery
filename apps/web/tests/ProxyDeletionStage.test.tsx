// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { stageProxyDeletion } from "../src/App.js";

// Deleting a proxy entry that other surfaces still reference is the partial-
// save hazard the staging has to close: the server rejects deleting a
// referenced entry, while saveProxyDraft commits the default policy, the new
// entries and the Web/MCP writes *before* the delete call. Every reference
// must therefore be repointed at staging time.

const server = { id: "doomed" };
const other = { id: "survivor" };
const removed = "proxy:doomed";

test("staging a deletion repoints every reference source the server checks", () => {
  const webDraft = { values: { proxyPolicy: "none" } };
  const staged = stageProxyDeletion(removed, {
    proxyDraft: undefined,
    fallbackProxySettings: { defaultPolicy: removed, servers: [server, other] },
    mcpPolicies: { biomed: removed, uniprot: "none" },
    webDraft,
    persistedWebProxyPolicy: "none",
    createWebDraft: () => { throw new Error("must not be called when a draft exists"); },
    sandboxSettings: { egressProxyPolicy: removed },
    models: [{ proxyPolicy: removed }, { proxyPolicy: "inherit" }],
    providers: [{ proxyPolicy: removed }],
  });
  // The global default resets and the entry leaves the draft list.
  assert.equal(staged.proxyDraft.defaultPolicy, "none");
  assert.deepEqual(staged.proxyDraft.servers.map((item) => item.id), ["survivor"]);
  // MCP references to the entry are dropped; unrelated policies survive.
  assert.deepEqual(staged.mcpPolicies, { uniprot: "none" });
  // An existing Web draft that does not reference the entry is kept as-is.
  assert.equal(staged.webDraft, webDraft);
  // The sandbox egress policy is reset to inherit.
  assert.equal(staged.sandboxSettings?.egressProxyPolicy, "inherit");
  // Model and provider policies referencing the entry are reset.
  assert.deepEqual(staged.models.map((model) => model.proxyPolicy), ["inherit", "inherit"]);
  assert.deepEqual(staged.providers.map((provider) => provider.proxyPolicy), ["inherit"]);
});

test("a persisted Web policy becomes a staged draft when no Web draft exists", () => {
  const created = { values: { proxyPolicy: removed, deepseekEnabled: true } };
  const staged = stageProxyDeletion(removed, {
    proxyDraft: undefined,
    fallbackProxySettings: { defaultPolicy: "none", servers: [server] },
    mcpPolicies: {},
    webDraft: undefined,
    persistedWebProxyPolicy: removed,
    createWebDraft: () => created,
    sandboxSettings: undefined,
    models: [],
    providers: [],
  });
  // The draft is created from the persisted settings and repointed, so the
  // save commits the Web reset together with the deletion instead of leaving
  // the persisted policy pointing at a deleted entry. Repointing builds a
  // new draft object (the created one stays untouched), so compare values.
  assert.deepEqual(staged.webDraft, { values: { proxyPolicy: "inherit", deepseekEnabled: true } });
  assert.equal(created.values.proxyPolicy, removed);
  assert.equal(staged.webDraft?.values.proxyPolicy, "inherit");
});

test("no Web draft is created when the persisted policy references another entry", () => {
  const staged = stageProxyDeletion(removed, {
    proxyDraft: undefined,
    fallbackProxySettings: { defaultPolicy: "none", servers: [server] },
    mcpPolicies: {},
    webDraft: undefined,
    persistedWebProxyPolicy: "proxy:survivor",
    createWebDraft: () => { throw new Error("must not be called"); },
    sandboxSettings: { egressProxyPolicy: "inherit" },
    models: [],
    providers: [],
  });
  assert.equal(staged.webDraft, undefined);
  // A sandbox policy that does not reference the entry is passed through.
  assert.equal(staged.sandboxSettings?.egressProxyPolicy, "inherit");
});

test("an existing proxy draft is staged on top of the persisted list", () => {
  const draft = { defaultPolicy: removed, servers: [server, other] };
  const staged = stageProxyDeletion(removed, {
    proxyDraft: draft,
    fallbackProxySettings: { defaultPolicy: "none", servers: [] },
    mcpPolicies: {},
    webDraft: undefined,
    persistedWebProxyPolicy: undefined,
    createWebDraft: () => { throw new Error("must not be called"); },
    sandboxSettings: undefined,
    models: [],
    providers: [],
  });
  // Staging builds a new draft object (the input draft stays untouched).
  assert.deepEqual(staged.proxyDraft, { defaultPolicy: "none", servers: [other] });
  assert.equal(draft.defaultPolicy, removed);
  assert.equal(staged.proxyDraft.defaultPolicy, "none");
  assert.deepEqual(staged.proxyDraft.servers.map((item) => item.id), ["survivor"]);
});

test("staging snapshots the model and provider references it repointed", () => {
  const doomedModel = { id: "m1", proxyPolicy: removed };
  const keptModel = { id: "m2", proxyPolicy: "proxy:survivor" };
  const doomedProvider = { id: "p1", proxyPolicy: removed };
  const staged = stageProxyDeletion(removed, {
    proxyDraft: undefined,
    fallbackProxySettings: { defaultPolicy: "none", servers: [server] },
    mcpPolicies: {},
    webDraft: undefined,
    persistedWebProxyPolicy: undefined,
    createWebDraft: () => { throw new Error("must not be called"); },
    sandboxSettings: undefined,
    models: [doomedModel, keptModel],
    providers: [doomedProvider],
  });
  // The state arrays are rewritten to inherit...
  assert.deepEqual(staged.models.map((model) => model.proxyPolicy), ["inherit", "proxy:survivor"]);
  assert.deepEqual(staged.providers.map((provider) => provider.proxyPolicy), ["inherit"]);
  // ...so the save drives the server-side updateModel/updateProvider resets
  // from the pre-rewrite snapshot instead of the already-rewritten arrays.
  assert.deepEqual(staged.repointedReferences.models, [doomedModel]);
  assert.deepEqual(staged.repointedReferences.providers, [doomedProvider]);
  // Nothing to repoint leaves an empty snapshot.
  const untouched = stageProxyDeletion(removed, {
    proxyDraft: undefined,
    fallbackProxySettings: { defaultPolicy: "none", servers: [server] },
    mcpPolicies: {},
    webDraft: undefined,
    persistedWebProxyPolicy: undefined,
    createWebDraft: () => { throw new Error("must not be called"); },
    sandboxSettings: undefined,
    models: [keptModel],
    providers: [],
  });
  assert.deepEqual(untouched.repointedReferences.models, []);
  assert.deepEqual(untouched.repointedReferences.providers, []);
});
