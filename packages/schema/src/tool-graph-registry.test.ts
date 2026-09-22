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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import {
  TOOL_GRAPH_REGISTRY,
  toolGraphSpec,
  toolGraphType,
  type ToolGraphProduct,
  type ToolGraphType,
} from "./tool-graph-registry.js";

const VALID_TYPES: ToolGraphType[] = ["execution", "search"];
const VALID_PRODUCTS: ToolGraphProduct[] = ["code", "paper", "web_page", "db_record"];

// The registry's rows are grouped by the product they emit. Assertions live on
// `product` because that is what differs row to row (and what the emitter
// dispatches on); `type` only splits execution from everything else, so it is
// asserted once per group rather than per tool.
const PAPER_TOOLS = [
  "mcp__arxiv__search",
  "mcp__pubmed__search",
  "mcp__europe-pmc__search",
  "mcp__biorxiv__search_preprints",
  "mcp__medrxiv__search_preprints",
];
const WEB_PAGE_TOOLS = [
  "web_search",
  "web_fetch",
  "mcp__llm-wiki__search",
  "mcp__llm-wiki__get_page",
  "mcp__llm-wiki__get_pages",
];
const DB_RECORD_TOOLS = [
  "mcp__uniprot__search",
  "mcp__pdb__search_structures",
  "mcp__reactome__search_pathways",
  "mcp__clinvar__search_variants",
  "mcp__chembl__search_molecules",
  "mcp__chembl__search_targets",
  "mcp__chembl__search_activities",
  "mcp__chembl__similarity_search",
  "mcp__geo__search_studies",
];
const CODE_TOOLS = ["run_shell", "run_npu_job"];

test("workspace tools are registered", () => {
  assert.equal(toolGraphType("run_shell"), "execution");
  assert.equal(toolGraphType("run_npu_job"), "execution");
  assert.equal(toolGraphType("web_search"), "search");
});

test("literature source search tools emit Paper", () => {
  for (const tool of PAPER_TOOLS) {
    assert.equal(toolGraphSpec(tool)?.product, "paper", tool);
    assert.equal(toolGraphType(tool), "search", tool);
  }
});

test("database source search tools emit DbRecord", () => {
  for (const tool of DB_RECORD_TOOLS) {
    assert.equal(toolGraphSpec(tool)?.product, "db_record", tool);
    assert.equal(toolGraphType(tool), "search", tool);
  }
});

test("llm-wiki search emits WebPage", () => {
  assert.equal(toolGraphSpec("mcp__llm-wiki__search")?.product, "web_page");
});

test("page-fetch tools (web_fetch + llm-wiki get_page/get_pages) emit WebPage", () => {
  // fetch/lookup tools produce WebPage nodes too — same write path, the
  // difference is their products additionally carry content_hash.
  for (const tool of ["web_fetch", "mcp__llm-wiki__get_page", "mcp__llm-wiki__get_pages"]) {
    assert.equal(toolGraphSpec(tool)?.product, "web_page", tool);
    assert.equal(toolGraphType(tool), "search", tool);
  }
});

test("execution tools emit Code", () => {
  for (const tool of CODE_TOOLS) {
    assert.equal(toolGraphSpec(tool)?.product, "code", tool);
  }
});

test("unregistered tools return undefined", () => {
  assert.equal(toolGraphSpec("mcp__pdb__lookup_structure"), undefined);
  assert.equal(toolGraphSpec("totally_made_up"), undefined);
  assert.equal(toolGraphType("mcp__pdb__lookup_structure"), undefined);
  assert.equal(toolGraphType("totally_made_up"), undefined);
});

test("registry size matches expectation", () => {
  assert.equal(Object.keys(TOOL_GRAPH_REGISTRY).length, 21);
});

test("every registry key is a string", () => {
  for (const key of Object.keys(TOOL_GRAPH_REGISTRY)) {
    assert.equal(typeof key, "string", key);
  }
});

test("every registry value is a valid spec", () => {
  for (const [key, value] of Object.entries(TOOL_GRAPH_REGISTRY)) {
    assert.ok(VALID_TYPES.includes(value.type), `unexpected graph type on ${key}: ${value.type}`);
    assert.ok(VALID_PRODUCTS.includes(value.product), `unexpected product on ${key}: ${value.product}`);
    assert.equal(Object.keys(value).length, 2, `${key} carries exactly type + product`);
  }
});

test("no tool type is also a registered tool name", () => {
  // The rule this vocabulary exists to enforce: a tool's *type* must never be
  // another tool's *name* — "web_fetch is a web_search" reads as if the fetch
  // tool were the search tool, and gives the reader no way to tell which half
  // of the pair is the classification.
  const toolNames = new Set(Object.keys(TOOL_GRAPH_REGISTRY));
  for (const type of [...VALID_TYPES, "program_evolution"]) {
    assert.ok(!toolNames.has(type), `graph type "${type}" collides with a tool name`);
  }
});

test("the registry only ever produces execution / search", () => {
  // Vocabulary freeze. `program_evolution` is written directly by the evolve
  // path (search_graph.py) and deliberately has no registry row, so a third
  // value appearing *here* means someone added a tool with a classification
  // the rest of the system does not know about — that must be a loud failure,
  // not a chip that silently renders the raw string.
  const used = new Set(Object.values(TOOL_GRAPH_REGISTRY).map((spec) => spec.type));
  assert.deepEqual([...used].sort(), ["execution", "search"]);
});
