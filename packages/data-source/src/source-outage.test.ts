// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import type { McpCatalog, McpSourceManifest } from "@sciencediscovery/schema";
import { McpSourceCatalog } from "./catalog.js";
import { SOURCE_OUTAGE_TTL_MS, SourceOutages } from "./source-outage.js";
import type { McpSourceRegistry } from "@sciencediscovery/mcp-sources";

const at = "2026-11-11T12:00:00.000Z";
const outage = { at, code: "ENDPOINT_UNAVAILABLE", detail: "HTTP 404 from example.org", sourceId: "pubmed", toolId: "search" };

test("a recorded outage is reported for the readiness window and then forgotten", () => {
  let now = Date.parse(at);
  const outages = new SourceOutages(() => now);
  outages.note(outage);

  assert.deepEqual(outages.read("pubmed"), outage);
  assert.equal(outages.read("uniprot"), undefined, "an outage is per source");

  now += SOURCE_OUTAGE_TTL_MS;
  assert.deepEqual(outages.read("pubmed"), outage, "the last second of the window still reports");

  now += 1;
  assert.equal(outages.read("pubmed"), undefined, "after the window readiness stops claiming an outage");
});

test("the catalog reports the outage beside the status instead of changing it", () => {
  const manifest = {
    id: "pubmed",
    tools: { search: { inputSchema: { properties: {}, type: "object" }, mcpToolName: "search" } },
    transport: { mcpServerId: "pubmed" },
  } as unknown as McpSourceManifest;
  const registry = { get: () => ({ manifest }), list: () => [{ manifest }] } as unknown as McpSourceRegistry;
  const remote: McpCatalog = {
    loadedAt: at,
    revision: "r1",
    servers: [{ enabled: true, id: "pubmed", tools: [{ description: "search", inputSchema: { properties: {}, type: "object" }, name: "search" }] }],
  } as unknown as McpCatalog;
  const outages = new SourceOutages(() => Date.parse(at));
  const catalog = new McpSourceCatalog(registry, { catalog: async () => remote, reload: async () => remote } as never, undefined, undefined, outages);

  return catalog.refresh().then(() => {
    const before = catalog.getStatus("pubmed");
    assert.equal(before.status, "ready");
    assert.equal(before.lastOutage, undefined);

    outages.note(outage);
    const during = catalog.getStatus("pubmed");
    // Advisory by construction: the status the gates read is untouched, and the
    // outage rides beside it (#1081).
    assert.equal(during.status, "ready");
    assert.deepEqual(during.lastOutage, outage);
    assert.deepEqual(during.availableTools, before.availableTools);
  });
});
