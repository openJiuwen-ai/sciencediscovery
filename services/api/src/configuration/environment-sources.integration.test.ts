// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { configurationFramework } from "./framework.js";
import { discoverConfiguration } from "./discovery.js";
import type { ConfigurationRequestView } from "@sciencediscovery/schema";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });

async function fixture(t: { after(action: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "sd-package-sources-"));
  const store = new SessionStore(root);
  await store.load();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const project = await store.createProject("Package sources");
  const session = await store.createSession(project.id, "Configuration", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined });
  const propose = (values: Record<string, string> = {}) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "environment.sources", values });
  const decide = async (view: ConfigurationRequestView, decision: "apply" | "dismiss" = "apply") => {
    if (decision === "dismiss") view = await framework.preview(session.id, view.id, { expectedRevision: view.revision, values: {}, selectedOptionId: "dismiss" });
    assert.ok(view.previewDigest);
    return framework.decide(session.id, view.id, { revision: view.revision, previewDigest: view.previewDigest, decision, selectedOptionId: decision === "apply" ? "persist" : "dismiss" });
  };
  return { root, store, session, framework, propose, decide };
}

test("CFG-X01: package-source discovery is bounded, deployment-wide and uses formal preset values", async t => {
  const h = await fixture(t);
  const search = await discoverConfiguration(h.store, h.session.id, "none", "search", { query: "pip 包源" });
  assert.ok(JSON.stringify(search).includes("environment.sources"));
  const detail = await discoverConfiguration(h.store, h.session.id, "none", "describe", { capabilityId: "environment.sources" });
  assert.deepEqual(detail.current, h.store.getEnvironmentSourceSettings());
  assert.deepEqual(detail.scopes, ["global"]);
  const view = await h.propose();
  assert.equal(view.state, "collecting_input");
  assert.deepEqual(view.fields.map(f => f.id), ["pipSource", "condaSource"]);
  assert.ok(view.fields.every(f => f.kind === "enum"));
  assert.deepEqual(view.verificationPlan, { targets: [], actions: [], maxRequests: 0, mayCharge: false });
});

test("CFG-X01: confirmation persists a partial source update and is idempotent after reopening", async t => {
  const h = await fixture(t);
  const before = h.store.getEnvironmentSourceSettings();
  const view = await h.propose({ pipSource: "tsinghua" });
  assert.deepEqual(h.store.getEnvironmentSourceSettings(), before);
  assert.equal(view.scope.kind, "global");
  assert.equal(view.activation.mode, "next_run");
  assert.equal(view.autoApplyAt, undefined);
  const saved = await h.decide(view);
  assert.equal(saved.state, "applied");
  assert.deepEqual(h.store.getEnvironmentSourceSettings(), { ...before, pipSource: "tsinghua" });
  assert.equal((await h.decide(view)).id, saved.id);
  const reopened = new SessionStore(h.root); await reopened.load();
  try { assert.deepEqual(reopened.getEnvironmentSourceSettings(), { ...before, pipSource: "tsinghua" }); }
  finally { reopened.close(); }
});

test("CFG-X01: unsupported presets, fields and scopes cannot save a package source", async t => {
  const h = await fixture(t);
  const before = h.store.getEnvironmentSourceSettings();
  const invalidValues: Array<Record<string, string>> = [{ condaSource: "huawei" }, { pipSource: "https://untrusted.invalid/simple" }, { command: "pip install anything" }];
  for (const values of invalidValues) {
    await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" });
  }
  await assert.rejects(h.framework.propose(h.session.id, { protocolVersion: 3, capabilityId: "environment.sources", values: { pipSource: "ustc" }, scope: { kind: "session", id: h.session.id } }), { code: "INVALID_CONFIGURATION_SCOPE" });
  assert.deepEqual(h.store.getEnvironmentSourceSettings(), before);
});

test("CFG-X01: refusal and stale approval preserve the formal source settings", async t => {
  const h = await fixture(t);
  const before = h.store.getEnvironmentSourceSettings();
  await assert.rejects(h.propose({ pipSource: before.pipSource }), { code: "CONFIGURATION_NO_CHANGE" });
  const declined = await h.propose({ condaSource: "ustc" });
  await h.decide(declined, "dismiss");
  assert.deepEqual(h.store.getEnvironmentSourceSettings(), before);
  const stale = await h.propose({ pipSource: "tsinghua" });
  await h.store.updateEnvironmentSourceSettings({ pipSource: "ustc" });
  await assert.rejects(h.decide(stale), { code: "RESOURCE_VERSION_CONFLICT" });
  assert.deepEqual(h.store.getEnvironmentSourceSettings(), { ...before, pipSource: "ustc" });
});
