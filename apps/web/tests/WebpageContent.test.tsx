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

// WebPage full-text read-back. The card drops the earlier "never render the
// body" defense — when extra.content_hash is a 64-hex CAS address the card
// lazily fetches the body through the session-scoped proxy endpoint and
// renders it as Markdown; without a hash (a snippet-only search hit) it
// shows the not-retrieved hint plus the source link. These tests use the
// TestRenderer (the repo's convention for effect-driven components — SSR
// never runs useEffect) so the fetch, its loading state, its error mapping,
// and the unmount cleanup are all exercised for real.
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { MemoryGraphNode, MemorySubgraph } from "@sciencediscovery/schema";

import type { ApiClient } from "../src/api.js";
import { LocaleProvider } from "../src/i18n/LocaleProvider.js";
import { MemoryGraphNodeDetail } from "../src/MemoryGraphProduct.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CONTENT_HASH = "ab4f2c9d8e71a3b6c0d5e9f2a8b7c4d1e6f3a0b9c8d7e4f1a2b3c4d5e6f7a8b9";

function makeNode(label: string, extra: Record<string, unknown>, id = "n1"): MemoryGraphNode {
  return { label, id, extra, createdAt: undefined as never };
}

/** A deferred the test controls, so the loading state can be observed before
 *  the body "arrives" and rejections can be raised after unmount. */
function defer<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** ApiClient stub whose readWebPageContent records every (sessionId,
 *  webPageId) pair — the "did the card even ask" assertions below depend on
 *  the recording, and the hash-missing case depends on it staying empty. */
function makeClient(read: (sessionId: string, webPageId: string) => Promise<string>): { client: ApiClient; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const client = {
    readWebPageContent: async (sessionId: string, webPageId: string): Promise<string> => {
      calls.push([sessionId, webPageId]);
      return read(sessionId, webPageId);
    },
  } as unknown as ApiClient;
  return { client, calls };
}

function zhCard(client: ApiClient, node: MemoryGraphNode) {
  return createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(MemoryGraphNodeDetail, {
    client,
    node,
    resolveState: "idle",
    sessionId: "session-1",
    subgraph: { nodes: [node], edges: [] } as MemorySubgraph,
  }));
}

test("WebPage without a valid content_hash shows the not-retrieved hint and never calls the client", async () => {
  const { client, calls } = makeClient(async () => "should-not-fetch");
  let view: ReactTestRenderer;
  // No content_hash key at all (snippet-only hit), plus a malformed
  // hash (defensive: only 64-hex counts) — both must fall back to the source
  // link rather than fire a doomed fetch.
  const noHash = makeNode("WebPage", {
    title: "Snippet-only hit", url: "https://example.test/old-page", snippet: "leftover snippet",
  });
  const badHash = makeNode("WebPage", {
    title: "Corrupt hash", url: "https://example.test/corrupt", content_hash: "zz-not-a-hash",
  }, "n2");
  await act(async () => { view = create(zhCard(client, noHash)); });
  try {
    const html = JSON.stringify(view!.toJSON());
    assert.match(html, /全文未抓取/);
    assert.match(html, /查看原文网页/);
    assert.match(html, /"href":"https:\/\/example\.test\/old-page"/);
    assert.doesNotMatch(html, /全文加载中/);
  } finally { await act(async () => view!.unmount()); }
  await act(async () => { view = create(zhCard(client, badHash)); });
  try {
    assert.match(JSON.stringify(view!.toJSON()), /全文未抓取/, "malformed hash falls back too");
  } finally { await act(async () => view!.unmount()); }
  assert.deepEqual(calls, [], "no fetch without a 64-hex content_hash");
});

test("WebPage with a content_hash loads, then renders the scrubbed body as Markdown", async () => {
  const pending = defer<string>();
  const { client, calls } = makeClient(() => pending.promise);
  const node = makeNode("WebPage", {
    title: "BRCA1 page", url: "https://example.test/brca1", content_hash: CONTENT_HASH,
  }, "wp/BRCA1");
  let view: ReactTestRenderer;
  await act(async () => { view = create(zhCard(client, node)); });
  try {
    // Loading state first — the body is one CAS round-trip away.
    assert.match(JSON.stringify(view!.toJSON()), /全文加载中/);
    // The fetch is scoped to the session and addresses the node by its id
    // (which may contain "/" — the client percent-encodes it).
    assert.deepEqual(calls, [["session-1", "wp/BRCA1"]]);
    // A raw HTML body: script/style blocks must vanish wholesale, tags must
    // not leak as literal "<p>" text, and the common entities must decode.
    const raw = "<p>First para.</p>\n<style>body{color:red}</style>\n<script>alert('x')</script>"
      + "\n<p>Second &amp; final&nbsp;para.</p>\n\n\n\n";
    await act(async () => { pending.resolve(raw); });
    const html = JSON.stringify(view!.toJSON());
    assert.match(html, /正文/, "content section header shows");
    assert.match(html, /First para\./);
    assert.match(html, /Second & final para\./);
    assert.doesNotMatch(html, /alert/, "script body scrubbed");
    assert.doesNotMatch(html, /color:red/, "style body scrubbed");
    assert.doesNotMatch(html, /&amp;|&nbsp;/, "entities decoded before render");
    // The scrubbed text is what reaches the Markdown renderer — assert the
    // exact cleaned string (tags gone, entities decoded, the blank lines the
    // removed script/style blocks leave behind collapsed to one paragraph
    // gap, ends trimmed) rather than just its absence-of-noise.
    assert.ok(view!.root.findByProps({ content: "First para.\n\nSecond & final para." }));
  } finally { await act(async () => view!.unmount()); }
});

test("a 404 from the proxy renders the soft not-retrieved message, a network failure the error state", async () => {
  // 404 → the body is genuinely absent (CAS blob gone or node pre-dates
  // pool); the card must read as "not retrieved", not as a broken card.
  {
    const { client } = makeClient(async () => { throw new Error("WebPage content not available"); });
    let view: ReactTestRenderer;
    await act(async () => { view = create(zhCard(client, makeNode("WebPage", { title: "t", url: "https://x.test/", content_hash: CONTENT_HASH }))); });
    try {
      const html = JSON.stringify(view!.toJSON());
      assert.match(html, /全文未抓取/);
      assert.match(html, /全文加载失败/, "still framed as the content error field");
    } finally { await act(async () => view!.unmount()); }
  }
  // Any other failure (offline, 500, garbage) surfaces the error state with
  // the underlying message so the reader can tell which kind of wrong it is.
  {
    const { client } = makeClient(async () => { throw new Error("Could not load WebPage content"); });
    let view: ReactTestRenderer;
    await act(async () => { view = create(zhCard(client, makeNode("WebPage", { title: "t", url: "https://x.test/", content_hash: CONTENT_HASH }))); });
    try {
      const html = JSON.stringify(view!.toJSON());
      assert.match(html, /全文加载失败/);
      assert.match(html, /Could not load WebPage content/);
    } finally { await act(async () => view!.unmount()); }
  }
});

test("unmounting the card mid-fetch resolves quietly — cleanup swallows the late response", async () => {
  const pending = defer<string>();
  const { client } = makeClient(() => pending.promise);
  let view: ReactTestRenderer;
  await act(async () => { view = create(zhCard(client, makeNode("WebPage", { title: "t", url: "https://x.test/", content_hash: CONTENT_HASH }))); });
  // Close the card while the CAS read is still in flight…
  await act(async () => { view!.unmount(); });
  assert.equal(view!.toJSON(), null, "card is gone");
  // …then let the response land. The effect's cancelled flag makes the late
  // setText a no-op; nothing may throw (or warn) after unmount.
  await act(async () => { pending.resolve("<p>late body</p>"); });
  assert.equal(view!.toJSON(), null, "late response does not resurrect the card");
});

test("the WebPage header is the link to the page — no separate URL row repeats it", async () => {
  // The card used to print the title as plain text and then follow it with a
  // standalone URL row pointing at the same target; for a page with no title
  // the two rendered the identical string one under the other. The header now
  // carries the anchor itself, and that row is gone.
  const { client } = makeClient(async () => "<p>body</p>");
  const titled = makeNode("WebPage", {
    title: "BRCA1 page", url: "https://example.test/brca1", content_hash: CONTENT_HASH,
  });
  let view: ReactTestRenderer;
  await act(async () => { view = create(zhCard(client, titled)); });
  try {
    const title = view!.root.findByProps({ className: "node-detail-title" });
    const link = title.findAllByType("a");
    assert.equal(link.length, 1, "the header carries exactly one link");
    assert.equal(link[0].props.href, "https://example.test/brca1");
    assert.equal(link[0].props.target, "_blank", "and opens the page in a new tab");
    assert.deepEqual(link[0].children, ["BRCA1 page"], "the title text stays the anchor text");
    assert.deepEqual(view!.root.findAllByProps({ className: "node-detail-row" }), [],
      "the standalone URL row is gone");
  } finally { await act(async () => view!.unmount()); }
  // Title-less page: the header falls back to the URL, and that fallback is
  // itself the link — the URL appears once, not once as text plus once as a
  // link to the same place.
  const untitled = makeNode("WebPage", { url: "https://example.test/bare", content_hash: CONTENT_HASH }, "n-bare");
  await act(async () => { view = create(zhCard(client, untitled)); });
  try {
    const title = view!.root.findByProps({ className: "node-detail-title" });
    assert.equal(title.findAllByType("a")[0].props.href, "https://example.test/bare");
    assert.equal(view!.root.findAllByType("a").length, 1, "the URL is rendered once, as the header link");
  } finally { await act(async () => view!.unmount()); }
});

test("the page reader's Title/URL Source/Markdown Content wrapper never reaches the card", async () => {
  // The web-fetch tool wraps every body it returns, and the wrapper is
  // persisted verbatim, so it is the first thing in the CAS blob — it used to
  // render as the opening lines of "Full Text".
  const wrapped = "Title: \n\nURL Source: https://rest.uniprot.org/uniprotkb/P38398.txt\n\n"
    + "Markdown Content:\nID   BRCA1_HUMAN   Reviewed;\nAC   P38398;\n";
  const { client } = makeClient(async () => wrapped);
  const node = makeNode("WebPage", {
    url: "https://rest.uniprot.org/uniprotkb/P38398.txt", content_hash: CONTENT_HASH,
  }, "wp/P38398");
  let view: ReactTestRenderer;
  await act(async () => { view = create(zhCard(client, node)); });
  try {
    // The whole wrapper goes — labels, their blank-line gaps, and the trailing
    // one — leaving the page's own first line where the body now starts.
    // (The prop match also lands on MarkdownRenderer, hence the `some`.)
    const body = "ID   BRCA1_HUMAN   Reviewed;\nAC   P38398;";
    assert.ok(view!.root.findAllByProps({ content: body }).length,
      "the body starts at the page's own first line");
    const html = JSON.stringify(view!.toJSON());
    assert.doesNotMatch(html, /URL Source/);
    assert.doesNotMatch(html, /Markdown Content/);
    assert.doesNotMatch(html, /Title: /);
    assert.match(html, /BRCA1_HUMAN/, "the page text itself is untouched");
  } finally { await act(async () => view!.unmount()); }
  // The scrubber only eats a run of those labels at the very top: a page that
  // quotes the same wording further down keeps every line of it.
  const { client: client2 } = makeClient(async () => "Intro line.\n\nURL Source: quoted from the spec\n\nMore text.");
  await act(async () => { view = create(zhCard(client2, node)); });
  try {
    const html = JSON.stringify(view!.toJSON());
    assert.match(html, /URL Source: quoted from the spec/, "an in-body 'URL Source:' line survives");
    assert.match(html, /Intro line\./);
    assert.match(html, /More text\./);
  } finally { await act(async () => view!.unmount()); }
});
