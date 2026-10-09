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

// EvidenceModal's Provenance tab must render a WebPage-backed evidence's
// source. A WebPage reaches an Evidence over the same `extracts` edge a Paper
// and a SourceFile do, and the `viewSourcePaper` chain hop does NOT filter on
// the "Paper" label it carries (that field is documentation — see
// `_walk_hops`), so the chain really does hand the modal a WebPage node. The
// modal used to collect only Paper/SourceFile and print "no source recorded"
// for everything else, dropping every WebPage-backed evidence on the floor.
//
// These tests drive the real component with a TestRenderer (the repo
// convention for effect-driven components — SSR never runs useEffect) so the
// chain fetch, the label split, and the reused WebPageDetail card's CAS
// read-back are all exercised end to end rather than asserted in isolation.
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { MemoryGraphChainResult, MemoryGraphNode } from "@sciencediscovery/schema";

import type { ApiClient } from "../src/api.js";
import { EvidenceModal } from "../src/EvidenceModal.js";
import { LocaleProvider } from "../src/i18n/LocaleProvider.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const EVIDENCE_ID = "ce56d339-0b41-4e79-ab39-32fb141fab5e";
const SESSION_ID = "34d745f1-3a74-4e31-9347-6a3993746fe8";
const PAGE_URL = "https://rest.uniprot.org/uniprotkb/p38398.txt";
const PAGE_BODY = "ID   BRCA1_HUMAN\nCC   -!- FUNCTION: E3 ubiquitin-protein ligase.";
const CONTENT_HASH = "45d4c73d4429cce33aeb6542d9f451d064686ca26c0e51f848f80c0fc37c2665";

/** WebPage nodes are keyed on `identifier` when the source carries one
 *  (llm-wiki paths) and on `url:<url>` otherwise (web_search / web_fetch
 *  hits) — see `_node_identity`. The fetched-page case is the url form. */
function webPageNode(): MemoryGraphNode {
  return {
    label: "WebPage",
    id: `url:${PAGE_URL}`,
    extra: { content_hash: CONTENT_HASH, has_full_content: true, url: PAGE_URL },
  } as unknown as MemoryGraphNode;
}

function evidenceNode(): MemoryGraphNode {
  return {
    label: "Evidence",
    id: EVIDENCE_ID,
    extra: { content: "UniProtKB P38398 的 SUBCELLULAR LOCATION 注释" },
  } as unknown as MemoryGraphNode;
}

/** ApiClient stub covering exactly what this modal touches: health (gates the
 *  View chain button), the chain walk (the provenance source), and the WebPage
 *  body read the reused card performs. `pages` records every body fetch so a
 *  test can assert the card only pulls when it has a CAS address. */
function makeClient(nodes: MemoryGraphNode[]): { client: ApiClient; pages: string[] } {
  const pages: string[] = [];
  const client = {
    getMemoryHealth: async () => ({ memoryGraph: "healthy" }),
    getMemoryChain: async () => ({ nodes, edges: [], total: nodes.length, truncated: false }) as unknown as MemoryGraphChainResult,
    readWebPageContent: async (_sessionId: string, webPageId: string) => {
      pages.push(webPageId);
      return PAGE_BODY;
    },
  } as unknown as ApiClient;
  return { client, pages };
}

async function renderModal(client: ApiClient): Promise<ReactTestRenderer> {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(EvidenceModal, {
      client,
      evidenceId: EVIDENCE_ID,
      onClose: () => {},
      sessionId: SESSION_ID,
    })));
  });
  // Switch to the Provenance tab (zh "溯源"), where the source cards live.
  const tab = view.root.findAll((node) => node.type === "button" && node.children.join("") === "溯源")[0];
  assert.ok(tab, "provenance tab button should be present");
  await act(async () => { tab.props.onClick(); });
  return view;
}

test("a WebPage-backed evidence renders its source page instead of the empty state", async () => {
  const { client } = makeClient([evidenceNode(), webPageNode()]);
  const view = await renderModal(client);
  const html = JSON.stringify(view.toJSON());

  assert.ok(html.includes("来源网页"), `the Web page source card should render; got ${html}`);
  assert.ok(!html.includes("该证据未记录来源。"), "the no-source message must not appear when a WebPage backs the evidence");
});

test("the source card links to the page and reads its body back from CAS", async () => {
  const { client, pages } = makeClient([evidenceNode(), webPageNode()]);
  const view = await renderModal(client);
  const html = JSON.stringify(view.toJSON());

  assert.ok(html.includes(PAGE_URL), "the page url should be rendered (as the header link)");
  assert.deepEqual(pages, [`url:${PAGE_URL}`], "the card should fetch the body by the WebPage node id, session-scoped");
  assert.ok(html.includes("BRCA1_HUMAN"), "the fetched page body should be rendered in the Full Text section");
});

test("a Paper-backed evidence is unaffected — no WebPage card, no body fetch", async () => {
  const paper: MemoryGraphNode = {
    label: "Paper",
    id: "doi:10.1038/s41392-023-01347-1",
    extra: { title: "Targeting p53 pathways", link: "https://doi.org/10.1038/s41392-023-01347-1" },
  } as unknown as MemoryGraphNode;
  const { client, pages } = makeClient([evidenceNode(), paper]);
  const view = await renderModal(client);
  const html = JSON.stringify(view.toJSON());

  assert.ok(html.includes("Targeting p53 pathways"), "the Paper card should still render");
  assert.ok(!html.includes("来源网页"), "no WebPage card for a Paper-only source");
  assert.deepEqual(pages, [], "a Paper source must not trigger a WebPage body fetch");
});
