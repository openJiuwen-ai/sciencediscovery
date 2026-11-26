// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { getIdeaResearchView, ideaResearchEndpoint, listIdeaResearches, type IdeaResearchRequest } from "./idea-research-api.ts";
import { createTest } from "../support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

test("the journey helper lists summaries and gets the full tree for one id", async () => {
  const calls: Array<{ method: string; url: string; options: Record<string, any> }> = [];
  const request = {
    get: async (url: string, options: Record<string, any>) => {
      calls.push({ method: "GET", url, options });
      return { ok: () => true, status: () => 200, json: async () => ({ items: [{ research: { id: "r1", status: "paused" } }] }) } as any;
    },
    post: async (url: string, options: Record<string, any>) => {
      calls.push({ method: "POST", url, options });
      return { ok: () => true, status: () => 200, json: async () => ({ research: { id: "r1", status: "completed" }, graph: { nodes: [{ id: "ROOT" }] } }) } as any;
    },
  } as unknown as IdeaResearchRequest;
  const options = { baseUrl: "http://stack.test/base", headers: { authorization: "Bearer test" }, timeout: 1234, maxRetries: 2 };
  const endpoint = ideaResearchEndpoint("session one", options.baseUrl);

  const items = await listIdeaResearches(request, "session one", options);
  assert.equal(items[0]!.research.id, "r1");
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.url, endpoint);
  assert.deepEqual(calls[0]!.options.headers, options.headers);
  assert.equal(calls[0]!.options.maxRetries, 2);

  const view = await getIdeaResearchView(request, "session one", "r1", options);
  assert.equal(view.research.status, "completed");
  assert.equal(view.graph.nodes[0]!.id, "ROOT");
  assert.equal(calls[1]!.method, "POST");
  assert.equal(calls[1]!.url, endpoint);
  assert.deepEqual(calls[1]!.options.data, { operation: "get", researchId: "r1" });
});

test("the journey helper names an HTTP failure instead of returning an empty list", async () => {
  const request = {
    get: async () => ({ ok: () => false, status: () => 503, text: async () => "unavailable" }) as any,
  } as unknown as IdeaResearchRequest;
  await assert.rejects(listIdeaResearches(request, "s1", { baseUrl: "http://stack.test" }), /GET .* -> 503: unavailable/);
});
