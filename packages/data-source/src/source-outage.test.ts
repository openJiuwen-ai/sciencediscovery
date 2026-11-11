// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import type { McpCatalog, McpSourceManifest } from "@sciencediscovery/schema";
import { McpSourceCatalog } from "./catalog.js";
import { recordedOutage, SOURCE_OUTAGE_TTL_MS, SourceOutages } from "./source-outage.js";
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

test("only a provider-level failure is remembered, not a tool-level rejection", () => {
  // A routine tool failure (invalid query, unresolvable DOI) arrives as
  // `semantic-error`; `upstreamError` still falls back to UPSTREAM_UNAVAILABLE
  // for it, so the old predicate recorded a ten-minute outage and the readiness
  // line read `Last upstream outage: SEMANTIC_ERROR` (#1102 review).
  const at = () => Date.parse("2026-11-11T12:00:00.000Z");
  const semantic = { code: "UPSTREAM_UNAVAILABLE", message: "DOI not found", upstreamCode: "SEMANTIC_ERROR" };
  assert.equal(recordedOutage({ status: "semantic-error" }, "pubmed", "search", semantic, at), undefined);
  assert.equal(recordedOutage({ status: "rate-limited" }, "pubmed", "search", semantic, at), undefined);
  // A broker cooldown / cancellation is not evidence about the endpoint either.
  assert.equal(recordedOutage(undefined, "pubmed", "search", semantic, at), undefined);

  // A record-scoped 404 keeps NOT_FOUND and is not an outage.
  const notFound = { code: "NOT_FOUND", message: "HTTP 404", upstreamCode: "NOT_FOUND" };
  assert.equal(recordedOutage({ status: "semantic-error", upstream: { statusCode: 404 } }, "pubmed", "search", notFound, at), undefined);

  // Transport and server failures are.
  const transport = recordedOutage({ status: "transport-error" }, "pubmed", "search", semantic, at);
  assert.equal(transport?.code, "UPSTREAM_UNAVAILABLE");
  assert.equal(transport?.sourceId, "pubmed");
  assert.equal(transport?.toolId, "search");
  assert.equal(transport?.at, "2026-11-11T12:00:00.000Z");
  assert.equal(recordedOutage({ status: "server-error" }, "pubmed", "search", semantic, at)?.code, "UPSTREAM_UNAVAILABLE");
});

test("an endpoint-scoped failure is recorded with the endpoint code", () => {
  // The 406 endpoint refusal is the one endpoint-level signal that exists today:
  // http_errors.py sets `failureScope: "endpoint"` and SourceHealth keys its
  // cooldown on exactly that. It used to be stored as SEMANTIC_ERROR, i.e.
  // indistinguishable from a request-scoped rejection (#1102 review).
  const at = () => Date.parse("2026-11-11T12:00:00.000Z");
  const outage = recordedOutage(
    { status: "semantic-error", upstream: { endpoint: "https://example.org", failureScope: "endpoint", statusCode: 406 } },
    "pubmed",
    "search",
    { code: "UPSTREAM_UNAVAILABLE", message: "HTTP 406 from example.org", upstreamCode: "SEMANTIC_ERROR" },
    at,
  );
  assert.equal(outage?.code, "ENDPOINT_UNAVAILABLE");
  assert.equal(outage?.detail, "HTTP 406 from example.org");
  assert.equal(outage?.sourceId, "pubmed");

  // And it is what `getStatus` then reports, next to an unchanged status.
  const outages = new SourceOutages(at);
  outages.note(outage!);
  assert.deepEqual(outages.read("pubmed"), outage);
});
