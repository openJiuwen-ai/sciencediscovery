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

import assert from "node:assert/strict";
import test from "node:test";

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
import { MemoryGraphNodeDetail } from "../src/MemoryGraphProduct.js";

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

test("SubTaskDetail shows source/tool_type at top level, no raw attributes", () => {
  const node = makeNode("SubTask", {
    task_type: "literature_search",
    status: "completed",
    source: "pubmed",
    tool_type: "search",
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
  assert.ok(html.includes("文献检索"), "task_type shown as friendly label");
  assert.ok(html.includes("pubmed"), "source shown at top level");
  assert.ok(html.includes("search"), "tool_type shown at top level");
  assert.ok(html.includes("12"), "result count shown");
  assert.ok(!html.includes("node-raw-attrs"), "no raw attributes section");
  assert.ok(!html.includes("auto_inferred_from_mcp_search"), "method not shown");
  assert.ok(!html.includes("inferred"), "inferred field not shown");
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
  const src = makeNode("SubTask", { task_type: "t", status: "completed" }, "src");
  const code = makeNode("Code", { tool: "run_python" }, "code");
  const nextTask = makeNode("SubTask", { task_type: "t2", status: "pending" }, "next-task");
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
