// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createBuiltinMcpSourceRegistry, createMcpSourceRegistry } from "./index.js";
import { createPluginScope, mergePluginSettings } from "@sciencediscovery/plugin-sdk";
import { builtinMcpSourcePlugins, builtinMcpSourceManifests, filterEnabledMcpSources } from "./plugin.js";
import { connectorManifest } from "./manifest.js";

test("connector manifests share a contract without sharing mutable configuration", () => {
  const first = connectorManifest("uniprot");
  const second = connectorManifest("pubmed");
  assert.deepEqual({ ...first, id: second.id }, second);
  assert.notEqual(first.configuration, second.configuration);
  assert.notEqual(first.services, second.services);
  for (const manifest of builtinMcpSourceManifests) {
    assert.deepEqual(manifest, connectorManifest(manifest.id.slice("connector.".length)));
  }
});

test("plugin installation preserves every built-in manifest, tool and governance contract", async () => {
  const scope = await createPluginScope(builtinMcpSourcePlugins);
  const registry = createMcpSourceRegistry();
  await scope.start(new AbortController().signal);
  for (const contribution of scope.contributions) for (const source of contribution.sources) registry.register(source);
  assert.equal(builtinMcpSourceManifests.length, 13);
  assert.deepEqual(registry.listManifests(), createBuiltinMcpSourceRegistry().listManifests());
  assert.equal(new Set(scope.manifests.map(manifest => manifest.id)).size, 13);
  await scope.dispose();
});

test("each built-in can be excluded from installation without creating or removing another source", async () => {
  for (const excluded of builtinMcpSourceManifests) {
    const scope = await createPluginScope(builtinMcpSourcePlugins, [excluded.id]);
    const ids = scope.contributions.flatMap(contribution => contribution.sources.map(source => `connector.${source.manifest.id}`));
    assert.deepEqual(ids, builtinMcpSourceManifests.filter(item => item.id !== excluded.id).map(item => item.id));
    await scope.dispose();
  }
});

test("project and session plugin filters intersect selection, retain custom MCP and never mutate snapshots", () => {
  const selected = builtinMcpSourceManifests.map(manifest => manifest.id.slice("connector.".length));
  selected.push("custom:lab");
  for (const manifest of builtinMcpSourceManifests) {
    const project = { [manifest.id]: { enabled: false } };
    const before = structuredClone(selected);
    const filtered = filterEnabledMcpSources(selected, project);
    assert.deepEqual(filtered, selected.filter(id => `connector.${id}` !== manifest.id));
    assert.deepEqual(selected, before);
    assert.deepEqual(filterEnabledMcpSources(selected, undefined), selected); // another project
    assert.deepEqual(filterEnabledMcpSources(selected, mergePluginSettings(project, { [manifest.id]: { enabled: true } })), selected);
    assert.deepEqual(filterEnabledMcpSources([], project), []);
    assert.deepEqual(filterEnabledMcpSources(selected, { ...project, mcp: { enabled: false } }), []);
  }
});

test("invalid optional Wiki configuration does not prevent other source plugins from loading", async () => {
  const previous = process.env.SCIENCE_AGENT_LLM_WIKI_URL;
  try {
    process.env.SCIENCE_AGENT_LLM_WIKI_URL = "not-a-url";
    const scope = await createPluginScope(builtinMcpSourcePlugins);
    assert.equal(scope.contributions.flatMap(item => item.sources).length, 12);
    assert.deepEqual(scope.contributions.flatMap(item => item.diagnostics ?? []), [{ pluginId: "connector.llm-wiki", code: "invalid_configuration" }]);
    await scope.dispose();
  } finally {
    if (previous === undefined) delete process.env.SCIENCE_AGENT_LLM_WIKI_URL;
    else process.env.SCIENCE_AGENT_LLM_WIKI_URL = previous;
  }
});
