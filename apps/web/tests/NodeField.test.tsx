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


import type { MemoryGraphEdge, MemoryGraphNode, MemorySubgraph } from "@sciencediscovery/schema";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ApiClient } from "../src/api.js";
import { LocaleProvider } from "../src/i18n/LocaleProvider.js";
import {
  firstContentValue,
  humanizeKey,
  LinkField,
  LongText,
  partitionEvidenceExtra,
  TimeField,
} from "../src/NodeField.js";
import {
  LEGACY_CLASSIFICATION_ALIASES,
  MemoryGraphNodeDetail,
  taskTypeLabel,
  type ClassificationLabelKey,
} from "../src/MemoryGraphProduct.js";

// Render a node-detail tree under a zh-CN LocaleProvider so the SSR snapshot
// carries the Chinese labels the assertions check (without the provider,
// useLocale falls back to "en" and every label renders in English).
function renderZh(node: ReactElement): string {
  return renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: "zh-CN" }, node));
}

// --- pure helpers ----------------------------------------------------------

test("humanizeKey converts snake_case to Title Case", () => {
  assert.equal(humanizeKey("evidence_type"), "Evidence Type");
  assert.equal(humanizeKey("core_objective"), "Core Objective");
  assert.equal(humanizeKey("simple"), "Simple");
});

test("partitionEvidenceExtra buckets content/meta/raw and drops empty values", () => {
  const extra = {
    content: "a claim",
    evidence_type: "experimental",
    confidence: "high",
    strength: "strong",
    locator: "p.4",
    source_paper_link: "https://doi.org/10.1/x",
    empty: "",
    nul: null,
  };
  const { contentNodes, metaPairs, rawPairs } = partitionEvidenceExtra(extra);
  assert.equal(contentNodes.length, 1);
  assert.equal(contentNodes[0].key, "content");
  // Only confidence + locator are meta now; evidence_type/strength were
  // dropped from EVIDENCE_META_KEYS and fall through to raw.
  assert.equal(metaPairs.length, 2);
  assert.equal(metaPairs[0].key, "confidence");
  assert.equal(metaPairs[1].key, "locator");
  assert.equal(rawPairs.length, 3);
  assert.equal(rawPairs[0].key, "evidence_type");
  assert.equal(rawPairs[1].key, "strength");
  assert.equal(rawPairs[2].key, "source_paper_link");
});

test("firstContentValue returns the first string content field", () => {
  assert.equal(firstContentValue({ content: "x", source_excerpt: "y" }), "x");
  assert.equal(firstContentValue({ source_excerpt: "y" }), "y");
  assert.equal(firstContentValue({ content: 7 }), undefined);
  assert.equal(firstContentValue(undefined), undefined);
});

// --- primitive components (SSR snapshot) -----------------------------------

test("LongText renders the clamped paragraph for long text (toggle is client-gated)", () => {
  // SSR does not run useLayoutEffect, so the clamp-overflow measurement that
  // gates the expand toggle cannot fire server-side — the toggle appears only
  // after hydration. Assert the clamped paragraph + full text render; the
  // toggle/hover-title are verified visually (client-only behavior).
  //
  // NOTE: the "expand then collapse button vanishes" regression is NOT covered
  // here — it needs a client DOM (jsdom) to run useLayoutEffect. It is guarded
  // by the sticky-`overflow` contract in NodeField.tsx (overflow is measured
  // only while collapsed, never re-measured after expanding).
  const long = "x".repeat(200);
  const html = renderToStaticMarkup(createElement(LongText, { value: long, maxLines: 3 }));
  assert.ok(html.includes("node-longtext"), "has clamp class");
  assert.ok(html.includes(long), "full text present in the paragraph");
  // The toggle is gated on a client-measured `overflow` flag, so it is absent
  // from the SSR snapshot (no layout effect ran). This is the fix for the old
  // heuristic that showed a toggle even when the text fit.
  assert.ok(!html.includes("node-longtext-toggle"), "no toggle in SSR (client-gated)");
});

test("LongText has no toggle for short text", () => {
  const html = renderToStaticMarkup(createElement(LongText, { value: "short", maxLines: 3 }));
  assert.ok(!html.includes("node-longtext-toggle"), "no toggle for short text");
});

test("TimeField formats ISO timestamps and passes through non-ISO", () => {
  const html = renderToStaticMarkup(createElement(TimeField, { value: "2025-01-15T10:30:00Z" }));
  assert.ok(html.includes("node-time"), "has time class");
  assert.ok(html.includes("dateTime="), "carries machine datetime attr");
  // Non-ISO passes through as raw text, still in a <time> wrapper.
  const raw = renderToStaticMarkup(createElement(TimeField, { value: "not-a-date" }));
  assert.ok(raw.includes("not-a-date"), "non-ISO passes through");
});

test("LinkField renders an anchor with href and target=_blank", () => {
  const html = renderToStaticMarkup(createElement(LinkField, { href: "https://example.com/paper/123" }));
  assert.ok(html.includes('href="https://example.com/paper/123"'), "has href");
  assert.ok(html.includes('target="_blank"'), "opens in new tab");
  assert.ok(html.includes('rel="noreferrer"'), "safe rel");
});

test("LinkField renders nothing for a non-string href", () => {
  const html = renderToStaticMarkup(createElement(LinkField, { href: undefined }));
  assert.equal(html, "");
});

// --- per-label dispatch -----------------------------------------------------

function makeNode(label: string, extra: Record<string, unknown>, id = "n1"): MemoryGraphNode {
  return { label, id, extra, createdAt: undefined as never };
}

function makeClient(): ApiClient {
  // CodeDetail recovers script/logs via two paths: the produced-artifact path
  // (listArtifacts / listArtifactVersions / getArtifactProvenance) and the
  // fallback run path (listExecutionRuns / readCas) when there is no produced
  // artifact. Stubs resolve to empty so the panel renders without a network
  // round-trip; SSR does not run the effect, so the note is not asserted here.
  const client = {
    listArtifacts: async () => [] as never[],
    listArtifactVersions: async () => [] as never[],
    getArtifactProvenance: async () => ({}) as never,
    listExecutionRuns: async () => [] as never[],
    readCas: async () => "" as never,
    listEnvironmentRevisions: async () => [] as never[],
  } as unknown as ApiClient;
  return client;
}

test("PaperDetail renders title, abstract section, clickable link, and retrieval fields", () => {
  const node = makeNode("Paper", {
    title: "A Study",
    year: "2024",
    abstract: "x".repeat(200),
    link: "https://doi.org/10.1/abc",
    identifier: "10.1/abc",
    identifier_type: "doi",
    authors: ["Alice", "Bob"],
    source: "pubmed",
    retrieval_count: 2,
    retrieved_at: "2025-01-15T10:30:00Z",
    created_at: "2025-01-14T00:00:00Z",
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s", subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(html.includes("A Study"), "title shown");
  assert.ok(html.includes("(2024)"), "year appended");
  assert.ok(html.includes("Alice, Bob"), "authors joined");
  assert.ok(html.includes('href="https://doi.org/10.1/abc"'), "link clickable");
  // identifier / identifier_type are no longer surfaced on the frontend even
  // when present in the node's extra.
  assert.ok(!html.includes("doi: 10.1/abc"), "identifier field removed");
  assert.ok(!html.includes("标识符"), "identifier label removed");
  // "被检索次数" shows the count without the old "第 N 次" ordinal phrasing;
  // retrieved_at is split into its own "最近一次被检索时间" Field rather than
  // trailing after the count with a " · " separator.
  assert.ok(html.includes("被检索次数"), "retrieval count field renamed");
  assert.ok(html.includes("2 次"), "retrieval count value, no 第");
  assert.ok(!html.includes("第 2 次"), "old 第 N 次 phrasing gone");
  assert.ok(html.includes("最近一次被检索时间"), "retrieved-at field renamed");
  assert.ok(!html.includes(" · "), "count and time no longer joined by ·");
  // source promoted to a top-level field instead of folded under raw attrs.
  assert.ok(html.includes("pubmed"), "source shown at top level");
  assert.ok(!html.includes("node-raw-attrs"), "no raw attributes block for Paper");
  // Paper header shows the label chip only — title is in the body, so the
  // header's <strong> short-name must not appear.
  assert.ok(!html.includes('memory-product-kind">Paper</span><strong'), "no short-name strong after Paper label");
});

test("LongText strips stray HTML tags from the value", () => {
  // Upstream records (e.g. MCP search abstract) sometimes carry stray HTML
  // fragments; LongText must surface the cleaned text, not literal "<h4>".
  const html = renderToStaticMarkup(createElement(LongText, { value: "see <h4>x</h4> and </i> tail", maxLines: 3 }));
  assert.ok(!html.includes("<h4"), "opening tag stripped");
  assert.ok(!html.includes("</i"), "closing tag stripped");
  assert.ok(html.includes("see"), "leading text kept");
  assert.ok(html.includes("tail"), "trailing text kept");
});

test("EvidenceDetail renders content/meta and drops raw attributes", () => {
  const node = makeNode("Evidence", {
    content: "the claim text",
    evidence_type: "experimental",
    confidence: "high",
    strength: "strong",
    locator: "p.4",
    source_paper_link: "https://doi.org/10.1/x",
    turn_id: "t1",
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s", subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(html.includes("the claim text"), "content prominent");
  // evidence_type and strength were dropped from the meta surface; only
  // confidence + locator (relabeled "引用出处") remain, with content section
  // labels translated ("正文" for content).
  assert.ok(!html.includes("Evidence Type"), "evidence_type not surfaced");
  assert.ok(!html.includes("Strength"), "strength not surfaced");
  assert.ok(html.includes("置信度"), "confidence meta shown in zh");
  assert.ok(html.includes("引用出处"), "locator relabeled to 引用出处");
  assert.ok(html.includes("正文"), "content section label in zh");
  assert.ok(html.includes('href="https://doi.org/10.1/x"'), "source paper link clickable");
  // Raw attributes block is no longer rendered on Evidence — internal routing
  // fields (turn_id/session_id) are not surfaced on the frontend.
  assert.ok(!html.includes("node-raw-attrs"), "no raw attributes bucket");
  assert.ok(!html.includes("t1"), "turn_id not surfaced");
  // Evidence header shows the label chip only — its short name falls back to
  // the node id (a UUID/hash), which adds noise, so no <strong> after the chip.
  assert.ok(html.includes('memory-product-kind">Evidence</span>'), "label chip shown");
  assert.ok(!html.includes('memory-product-kind">Evidence</span><strong'), "no id strong after Evidence label");
});

test("ClaimDetail renders content as long text and hides content_hash", () => {
  const node = makeNode("Claim", {
    content: "x".repeat(200),
    claim_type: "finding",
    confidence: "medium",
    locator: "fig1",
    content_hash: "abc123hash",
    created_at: "2025-01-15T10:30:00Z",
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s", subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(html.includes("声明正文"), "content section labeled in zh");
  // Long content renders under the clamped paragraph; the expand toggle is now
  // gated on a client-measured overflow flag (useLayoutEffect), so it does not
  // appear in the SSR snapshot. The content itself is present.
  assert.ok(html.includes("x".repeat(200)), "long content present in paragraph");
  assert.ok(!html.includes("node-longtext-toggle"), "toggle is client-gated, absent in SSR");
  // content_hash is intentionally not shown on the frontend.
  assert.ok(!html.includes("abc123hash"), "content_hash not shown");
  // claim_type and locator were removed from the Claim surface; neither the
  // type value ("finding") nor the locator ("fig1") should render.
  assert.ok(!html.includes("finding"), "claim_type not surfaced");
  assert.ok(!html.includes("fig1"), "locator not surfaced on Claim");
  assert.ok(html.includes("置信度"), "confidence field shown in zh");
  // The Claim header must not show the claim_id UUID (node.id) next to the
  // label chip — the content is already in the body's 声明正文 section.
  assert.ok(!html.includes('memory-product-kind">Claim</span><strong'), "no UUID strong after Claim label");
});

test("ClaimDetail header hides the claim_id UUID (label chip only)", () => {
  const node = makeNode("Claim", { content: "a claim", claim_type: "finding" }, "claim-uuid-123");
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s", subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(html.includes('memory-product-kind">Claim</span>'), "label chip shown");
  assert.ok(!html.includes("claim-uuid-123"), "claim_id UUID not shown in header");
});

test("ResearchGoalDetail hides core_objective/method, shows domain + topic_scope", () => {
  const node = makeNode("ResearchGoal", {
    core_objective: "find a cure",
    domain: "oncology",
    topic_scope: ["a", "b"],
    method: "auto_inferred;corrected_by_plan",
    created_at: "2025-01-15T10:30:00Z",
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s", subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(html.includes("核心目标"), "core_objective section shown in body");
  // Header must NOT duplicate the core_objective as a <strong> title — the
  // node's short name (core_objective) is shown once, in the body section.
  assert.ok(!html.includes('<strong title="find a cure">find a cure</strong>'), "header does not duplicate core_objective");
  assert.ok(!html.includes("auto_inferred"), "method not shown");
  assert.ok(html.includes("oncology"), "domain shown");
  assert.ok(html.includes("a, b"), "topic_scope joined");
});

test("ResearchGoalDetail hides topic_scope when empty", () => {
  const node = makeNode("ResearchGoal", {
    core_objective: "x",
    domain: "oncology",
    topic_scope: [],
    created_at: "2025-01-15T10:30:00Z",
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s", subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(!html.includes("主题范围"), "topic_scope label hidden when empty");
});

test("ResearchGoalDetail hides raw attributes (no inferred/method leakage)", () => {
  const node = makeNode("ResearchGoal", {
    core_objective: "x",
    domain: "oncology",
    topic_scope: ["a"],
    method: "auto_inferred",
    inferred: true,
    created_at: "2025-01-15T10:30:00Z",
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s", subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(!html.includes("node-raw-attrs"), "no raw attributes section");
  assert.ok(!html.includes("inferred"), "inferred field not shown");
});

test("TaskDetail (ToolCall) shows tool_name first, then tool_type/source at top level, no raw attributes", () => {
  // ToolCall's classification field is ``tool_type`` (renamed from
  // task_type) and the full tool identifier rides in ``tool_name``, ordered
  // FIRST on the card so the reader sees the actual tool before the class.
  // The fixture deliberately keeps a pre-collapse value: nodes born before the
  // vocabulary shrank still carry ``literature_search`` forever, and the card
  // has to fold it onto the current "检索" chip rather than render it raw.
  const node = makeNode("ToolCall", {
    tool_type: "literature_search",
    status: "completed",
    source: "pubmed",
    tool_name: "mcp__pubmed__search",
    result_count: 12,
    finished_at: "2025-01-15T10:30:00Z",
    created_at: "2025-01-15T10:29:00Z",
    method: "auto_inferred_from_mcp_search",
    inferred: true,
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s", subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(html.includes("node-status-completed"), "status badge with completed class");
  assert.ok(html.includes("检索"), "legacy tool_type folded onto the current label");
  assert.ok(!html.includes("文献检索"), "the retired vocabulary's wording is gone");
  assert.ok(html.includes("pubmed"), "source shown at top level");
  assert.ok(html.includes("mcp__pubmed__search"), "tool_name shown at top level");
  // tool_name must be the FIRST field (before the tool_type label row).
  const nameIdx = html.indexOf("mcp__pubmed__search");
  const typeLabelIdx = html.indexOf("工具类型");
  assert.ok(nameIdx > -1 && typeLabelIdx > -1, "both fields render");
  assert.ok(nameIdx < typeLabelIdx, "tool_name row precedes the tool_type row");
  assert.ok(html.includes("12"), "result count shown");
  assert.ok(!html.includes("node-raw-attrs"), "no raw attributes section");
  assert.ok(!html.includes("auto_inferred_from_mcp_search"), "method not shown");
  assert.ok(!html.includes("inferred"), "inferred field not shown");
});

// --- classification vocabulary ---------------------------------------------

test("every legacy classification folds onto a current chip label", () => {
  // The table is the whole read-side story for pre-collapse nodes: it has to
  // name every value the graph actually holds. These were read off the live
  // ToolCall population before the collapse (plus `search`, which is a current
  // value arriving on nodes written after it).
  const zh = (key: ClassificationLabelKey): string =>
    ({ "node.task_type.execution": "执行",
       "node.task_type.search": "检索",
       "node.task_type.subagent": "子代理作用域",
       "node.task_type.program_evolution": "程序演进" })[key];
  const folded: Record<string, string> = {
    // The pre-collapse execution bucket.
    code_execution: "执行",
    // Every pre-collapse search bucket — literature, web, database, and the
    // two one-off legacy markers.
    literature_search: "检索",
    web_search: "检索",
    db_search: "检索",
    search_preprints: "检索",
    lookup_doi: "检索",
    // Values written after the collapse.
    execution: "执行",
    search: "检索",
    // The two pseudo-types that survived unchanged.
    subagent: "子代理作用域",
    program_evolution: "程序演进",
  };
  for (const [value, label] of Object.entries(folded)) {
    assert.equal(taskTypeLabel(value, zh), label, value);
  }
});

test("an unknown classification renders as itself, never as an alias", () => {
  // The fallthrough returns the ORIGINAL string. If it returned the aliased
  // one, a value someone adds later without teaching the UI would silently
  // appear as "search" — a wrong label is worse than an ugly one.
  const passthrough = (key: string): string => key;
  assert.equal(taskTypeLabel("analysis_integration", passthrough), "analysis_integration");
  assert.equal(taskTypeLabel("auto_inferred_from_execution", passthrough), "auto_inferred_from_execution");
  assert.equal(taskTypeLabel("general-purpose", passthrough), "general-purpose");
  // And the alias table itself only ever lands on a known chip.
  for (const target of Object.values(LEGACY_CLASSIFICATION_ALIASES)) {
    assert.ok(["execution", "search"].includes(target), target);
  }
});

test("a pre-rename node (task_type only, no tool_type) still shows its classification", () => {
  // The rename moved task_type → tool_type on ToolCall, but no migration
  // rewrote existing nodes, so an old ToolCall carries only task_type. The
  // card reads `toolType ?? taskType`, which is the only reason those nodes
  // show a classification at all.
  const node = makeNode("ToolCall", {
    task_type: "code_execution",
    status: "completed",
    tool_name: "run_python",
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s", subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(html.includes("执行"), "legacy task_type key renders the folded label");
  assert.ok(!html.includes("代码执行"), "and not the retired wording");
});

test("an evolve ToolCall keeps the program_evolution chip and its run affordance", () => {
  // program_evolution is not a tool class — it marks the evolve search run,
  // and it is the one classification the frontend branches on. It has to
  // survive the collapse untouched, chip label included.
  const node = makeNode("ToolCall", {
    tool_type: "program_evolution",
    status: "completed",
    tool_name: "mcp__llm-wiki__search",
  }, "subtask:evolve:run-42");
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s", subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(html.includes("程序演进"), "program_evolution renders its own chip");
  assert.ok(html.includes("检索") === false, "and is not folded into the search bucket");
});

test("CodeDetail with no produced artifact renders the panel (path B fallback runs client-side)", () => {
  // A Code node with no produces edge now falls back to listExecutionRuns +
  // readCas (path B) instead of immediately showing "cannot be recovered".
  // The recovery happens in a client useEffect, which SSR does not run, so the
  // snapshot only asserts the structural fields render without a crash; the
  // fallback's actual content retrieval is verified manually in the browser.
  const node = makeNode("Code", {
    tool: "run_python",
    language: "python",
    status: "completed",
    exit_code: 0,
    started_at: "2025-01-15T10:30:00Z",
    finished_at: "2025-01-15T10:31:00Z",
    code_id: "run-1",
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s", subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(html.includes("run_python"), "tool value shown");
  assert.ok(html.includes("0"), "exit code");
  assert.ok(html.includes("node-status-completed"), "status badge");
});

test("CodeDetail never surfaces the four CAS hashes", () => {
  // The graph stores code_hash/stdout_hash/stderr_hash/env_hash as CAS
  // addresses only; their content is recovered via provenance (script /
  // execution output / environment). The raw hex must never reach the DOM,
  // even when the recovery note is shown (no produced artifact).
  const node = makeNode("Code", {
    tool: "run_python",
    language: "python",
    status: "completed",
    exit_code: 0,
    code_id: "run-1",
    code_hash: "deadbeef0011",
    stdout_hash: "cafe0011",
    stderr_hash: "faced0011",
    env_hash: "bead0011",
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s", subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(!html.includes("deadbeef0011"), "code_hash not shown");
  assert.ok(!html.includes("cafe0011"), "stdout_hash not shown");
  assert.ok(!html.includes("faced0011"), "stderr_hash not shown");
  assert.ok(!html.includes("bead0011"), "env_hash not shown");
});

test("MemoryGraphNodeDetail renders outgoing relations grouped by edge type", () => {
  const src = makeNode("ToolCall", { task_type: "t", status: "completed" }, "src");
  const code = makeNode("Code", { tool: "run_python" }, "code");
  const nextTask = makeNode("ToolCall", { task_type: "t2", status: "pending" }, "next-task");
  // edges[] deliberately lists `next` first; the display order must still put
  // `produces` above `next` (produces is the primary "made that" claim).
  const edges: MemoryGraphEdge[] = [
    { source: "src", target: "next-task", type: "next" },
    { source: "src", target: "code", type: "produces" },
  ];
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node: src, resolveState: "idle", sessionId: "s",
    subgraph: { nodes: [src, code, nextTask], edges } as MemorySubgraph,
  }));
  assert.ok(html.includes("produces"), "edge type label");
  assert.ok(html.includes("run_python"), "target name via graphNodeName");
  // produces renders above next in the DOM, regardless of edges[] order.
  const producesAt = html.indexOf("produces");
  const nextAt = html.indexOf("memory-product-links-label\">next");
  assert.ok(producesAt > -1 && nextAt > -1, "both produces and next labels render");
  assert.ok(producesAt < nextAt, "produces listed above next");
});

// --- WebPage / DbRecord detail cards ---------------------------------------

test("WebPageDetail renders title, identifier badge, url, snippet, source_refs and retrieval fields", () => {
  // llm-wiki shape: title, identifier (wiki path), identifier_type, source_refs
  // populated, and the retrieval/system timestamps. The card must surface
  // every documented surface without leaking `content` (which is always empty
  // until get_page / web_fetch land a full-text payload).
  const node = makeNode("WebPage", {
    title: "BRCA1",
    identifier: "wiki/BRCA1",
    identifier_type: "wiki-path",
    url: "http://wiki.local/BRCA1",
    snippet: "Tumor suppressor gene involved in DNA repair.",
    source_refs: ["Smith 2020", "Doe 2021"],
    retrieval_count: 3,
    retrieved_at: "2026-09-10T14:32:00Z",
    created_at: "2026-09-10T14:00:00Z",
    // Defensive: even if a future stub writes `content`, this iteration does
    // not render it. The `hidden` attribute keeps it out of sight but in the
    // DOM so a regression that re-surfaces it would land a visible string.
    content: "should-not-show",
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s",
    subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(html.includes("BRCA1"), "title shown");
  assert.ok(html.includes("wiki-path:wiki/BRCA1"), "identifier badge shown with type prefix");
  assert.ok(html.includes('href="http://wiki.local/BRCA1"'), "url rendered as link");
  assert.ok(html.includes("Tumor suppressor gene involved in DNA repair."), "snippet shown");
  assert.ok(html.includes("Smith 2020"), "source_refs first item shown");
  assert.ok(html.includes("Doe 2021"), "source_refs second item shown");
  assert.ok(html.includes("3"), "retrieval_count shown");
  assert.ok(html.includes("node-source-refs"), "source_refs renders as a list");
  // content must NOT reach the user even when present (hidden <p> only).
  assert.ok(!html.includes("should-not-show"), "content suppressed until the page body is fetched");
});

test("WebPageDetail hides source_refs section when the list is empty or absent", () => {
  // web_search hits have no source_refs — the section must collapse entirely
  // (no empty <ul>, no empty label). An empty array AND a missing key both
  // exercise the same fallback path; a populated array renders the list.
  const emptyArray = makeNode("WebPage", {
    title: "T", url: "http://x", snippet: "s", source_refs: [],
  });
  const emptyHtml = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node: emptyArray, resolveState: "idle", sessionId: "s",
    subgraph: { nodes: [emptyArray], edges: [] } as MemorySubgraph,
  }));
  assert.ok(!emptyHtml.includes("原始出处"), "empty source_refs list hides the section");
  assert.ok(!emptyHtml.includes("node-source-refs"), "no list element for empty source_refs");

  const missing = makeNode("WebPage", { title: "T", url: "http://x", snippet: "s" });
  const missingHtml = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node: missing, resolveState: "idle", sessionId: "s",
    subgraph: { nodes: [missing], edges: [] } as MemorySubgraph,
  }));
  assert.ok(!missingHtml.includes("原始出处"), "missing source_refs hides the section");
});

test("WebPageDetail hides identifier badge when identifier is absent", () => {
  // web_search hits carry no identifier — only a URL. The card must not show
  // a half-empty badge.
  const node = makeNode("WebPage", {
    title: "Some page", url: "http://x", snippet: "s",
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s",
    subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(!html.includes("node-identifier-badge"), "no badge without identifier");
});

test("WebPageDetail falls back to identifier then url when title is absent", () => {
  // Title is the preferred header but not always present (an llm-wiki path
  // might land without a curator's title); the header falls back to
  // identifier (wiki path) then url (last resort).
  const noTitle = makeNode("WebPage", {
    identifier: "wiki/BRCA1", url: "http://wiki.local/BRCA1",
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node: noTitle, resolveState: "idle", sessionId: "s",
    subgraph: { nodes: [noTitle], edges: [] } as MemorySubgraph,
  }));
  assert.ok(html.includes("wiki/BRCA1"), "header falls back to identifier");
});

test("DbRecordDetail renders title, copy-able identifier badge, snippet, record link, retrieval fields", () => {
  // The uniprot row shape: a curator title, a `source:identifier` badge,
  // snippet, the database's record URL, and retrieval stats. The badge IS the
  // copy button — the whole `复制标识符 uniprot:P38398` pill is one <button>,
  // with the affordance spelled out as a leading label instead of a separate
  // trailing icon (the icon-only variant read as an unexplained blank gap).
  const node = makeNode("DbRecord", {
    source: "uniprot",
    identifier: "P38398",
    identifier_type: "accession",
    url: "https://www.uniprot.org/uniprotkb/P38398",
    title: "BRCA1_HUMAN DNA repair-associated protein",
    snippet: "Tumor suppressor. The BRCA1-BARD1 heterodimer coordinates DNA damage repair.",
    retrieval_count: 3,
    retrieved_at: "2026-09-10T14:32:00Z",
    created_at: "2026-09-10T14:00:00Z",
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s",
    subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(html.includes("BRCA1_HUMAN DNA repair-associated protein"), "title shown");
  assert.ok(html.includes("uniprot:P38398"), "source:identifier badge shown");
  assert.ok(html.includes("node-identifier-badge-button"), "badge itself is the copy button");
  assert.ok(html.includes("复制标识符"), "copy affordance is spelled out on the badge");
  assert.ok(!html.includes("copy-button"), "no separate trailing copy button beside the text");
  assert.ok(html.includes("Tumor suppressor. The BRCA1-BARD1"), "snippet shown");
  assert.ok(html.includes('href="https://www.uniprot.org/uniprotkb/P38398"'), "record link shown");
  assert.ok(html.includes("记录链接"), "record_link field label translated");
  assert.ok(html.includes("3"), "retrieval_count shown");
});

test("DbRecordDetail hides the record link when url is absent", () => {
  // Some records may not have a public URL — the entire row collapses.
  const node = makeNode("DbRecord", {
    source: "uniprot", identifier: "P38398", title: "BRCA1",
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s",
    subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(!html.includes("记录链接"), "record_link label hidden when url is missing");
  // The identifier badge remains even without a record link — the copy
  // affordance is independent.
  assert.ok(html.includes("uniprot:P38398"), "identifier badge still shown");
});

test("DbRecordDetail falls back to created_at for retrieved_at when missing", () => {
  // ON CREATE does not write retrieved_at; only repeated hits MERGE in.
  // A brand-new record has no retrieved_at, so the field must fall back to
  // created_at rather than render an empty row.
  const node = makeNode("DbRecord", {
    source: "uniprot", identifier: "P38398", url: "https://x",
    title: "BRCA1", created_at: "2026-09-10T14:00:00Z",
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s",
    subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  // The created_at value appears at least twice (once as retrieved_at
  // fallback, once as created_at itself).
  const matches = html.match(/2026-09-10/g) ?? [];
  assert.ok(matches.length >= 2, "created_at fills in for missing retrieved_at");
});

test("DbRecordDetail hides identifier badge when identifier is absent", () => {
  // No identifier — no badge, even with a title and url.
  const node = makeNode("DbRecord", {
    source: "uniprot", url: "https://x", title: "BRCA1",
  });
  const html = renderZh(createElement(MemoryGraphNodeDetail, {
    client: makeClient(), node, resolveState: "idle", sessionId: "s",
    subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
  assert.ok(!html.includes("node-identifier-badge"), "no badge without identifier");
});
