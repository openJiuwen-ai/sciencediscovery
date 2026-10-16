// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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

import { createTest } from "../../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { normalizeArxivId, parseArxivEntries } from "./arxiv.js";
import { epmcToRef, createEuropePmcConnector } from "./europepmc.js";
import { deinvertAbstract, openAlexToRef, createOpenAlexConnector } from "./openalex.js";
import { parsePubmedArticles } from "./pubmed.js";
import { RateLimiter } from "./rate-limiter.js";
import { s2ToRef, createSemanticScholarConnector } from "./semantic-scholar.js";
import { assertSafeUrl, downloadPaperPdf, searchAcrossChain } from "./source-chain.js";
import { FixtureScholarlyTransport, fixtureFileName, type ScholarlyResponse, type ScholarlyTransport } from "./transport.js";
import { NotFoundError, RateLimitError, paperDedupKey, type PaperConnector, type PaperRef } from "./types.js";

// ---------------------------------------------------------------- parsers

test("normalizeArxivId handles urls, versions and legacy ids", () => {
  assert.equal(normalizeArxivId("https://arxiv.org/abs/2301.12345v2"), "2301.12345");
  assert.equal(normalizeArxivId("2301.12345"), "2301.12345");
  assert.equal(normalizeArxivId("hep-th/9901001"), "hep-th/9901001");
  assert.equal(normalizeArxivId("not-an-id"), null);
});

test("parseArxivEntries parses a minimal feed", () => {
  const xml = `<?xml version="1.0"?><feed>
    <entry>
      <id>http://arxiv.org/abs/2301.00001v1</id>
      <title> Ebola   glycoprotein\n antibodies </title>
      <summary>We study GP.</summary>
      <published>2023-01-02T00:00:00Z</published>
      <author><name>Alice Smith</name></author>
      <author><name>Bob Jones</name></author>
      <arxiv:doi>10.1000/test</arxiv:doi>
    </entry>
    <entry><id>not-an-arxiv-id</id><title>skip me</title></entry>
  </feed>`;
  const entries = parseArxivEntries(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.arxivId, "2301.00001");
  assert.equal(entries[0]?.title, "Ebola glycoprotein antibodies");
  assert.deepEqual(entries[0]?.authors, ["Alice Smith", "Bob Jones"]);
  assert.equal(entries[0]?.year, 2023);
  assert.equal(entries[0]?.doi, "10.1000/test");
});

test("s2ToRef maps external ids and OA pdf", () => {
  const ref = s2ToRef({
    paperId: "abc",
    title: "T",
    authors: [{ name: "A" }],
    year: 2024,
    externalIds: { DOI: "10.1/x", ArXiv: "2301.1", PubMedCentral: "PMC123" },
    openAccessPdf: { url: "http://pdf" },
    citationCount: 42,
    venue: "Nature",
  });
  assert.equal(ref?.doi, "10.1/x");
  assert.equal(ref?.arxivId, "2301.1");
  assert.equal(ref?.pmcId, "PMC123");
  assert.equal(ref?.pdfUrl, "http://pdf");
  assert.equal(ref?.citationCount, 42);
  assert.equal(s2ToRef({ paperId: "x" }), null);
});

test("deinvertAbstract reconstructs word order", () => {
  assert.equal(deinvertAbstract({ hello: [0], world: [1] }), "hello world");
  assert.equal(deinvertAbstract(null), null);
  assert.equal(deinvertAbstract({}), null);
});

test("openAlexToRef strips doi url prefix and maps venue", () => {
  const ref = openAlexToRef({
    id: "https://openalex.org/W1",
    doi: "https://doi.org/10.1/x",
    title: "T",
    publication_year: 2022,
    authorships: [{ author: { display_name: "A" } }],
    primary_location: { pdf_url: "http://p", source: { display_name: "Cell" } },
    open_access: { is_oa: true, oa_url: "http://oa" },
    cited_by_count: 7,
  });
  assert.equal(ref?.doi, "10.1/x");
  assert.equal(ref?.sourceId, "W1");
  assert.equal(ref?.pdfUrl, "http://oa");
  assert.equal(ref?.venue, "Cell");
});

test("epmcToRef picks http pdf urls only", () => {
  const ref = epmcToRef({
    title: "T",
    authorString: "A B, C D",
    pubYear: "2021",
    doi: "10.1/x",
    pmcid: "PMC999",
    abstractText: "<b>abstract</b>",
    fullTextUrlList: {
      fullTextUrl: [
        { url: "ftp://nope", documentStyle: "pdf" },
        { url: "https://ok", documentStyle: "pdf" },
      ],
    },
  });
  assert.equal(ref?.pdfUrl, "https://ok");
  assert.equal(ref?.abstract, "abstract");
  assert.deepEqual(ref?.authors, ["A B", "C D"]);
  assert.equal(ref?.pmcId, "PMC999");
});

test("parsePubmedArticles parses efetch xml", () => {
  const xml = `<PubmedArticleSet><PubmedArticle>
    <MedlineCitation>
      <PMID Version="1">12345</PMID>
      <Article>
        <ArticleTitle>Ebola <i>virus</i> entry</ArticleTitle>
        <AuthorList><Author><LastName>Smith</LastName><ForeName>Alice</ForeName></Author></AuthorList>
        <Abstract><AbstractText>GP mediated.</AbstractText></Abstract>
        <Journal><JournalIssue><PubDate><Year>2020</Year></PubDate></JournalIssue></Journal>
      </Article>
    </MedlineCitation>
    <PubmedData><ArticleIdList>
      <ArticleId IdType="doi">10.1/ebola</ArticleId>
      <ArticleId IdType="pmc">PMC777</ArticleId>
    </ArticleIdList></PubmedData>
  </PubmedArticle></PubmedArticleSet>`;
  const refs = parsePubmedArticles(xml);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.title, "Ebola virus entry");
  assert.equal(refs[0]?.sourceId, "12345");
  assert.equal(refs[0]?.doi, "10.1/ebola");
  assert.equal(refs[0]?.pmcId, "PMC777");
  assert.deepEqual(refs[0]?.authors, ["Alice Smith"]);
});

test("paperDedupKey prefers doi over arxiv over title", () => {
  assert.equal(paperDedupKey({ doi: "10.1/X ", arxivId: "1", title: "T" }), "doi:10.1/x");
  assert.equal(paperDedupKey({ doi: null, arxivId: "2301.1", title: "T" }), "arxiv:2301.1");
  assert.equal(paperDedupKey({ doi: null, arxivId: null, title: " A  B-C " }), "title:a b c");
});

// ------------------------------------------------------------- transport

test("fixture transport replays recorded responses and is loud on holes", async (context) => {
  const dir = await mkdtemp(resolve(tmpdir(), "ke-fixture-"));
  context.after(() => rm(dir, { force: true, recursive: true }));
  const url = "https://api.example.com/search?q=ebola&limit=10";
  await writeFile(
    resolve(dir, `${fixtureFileName(url)}.json`),
    JSON.stringify({ status: 200, headers: { "content-type": "application/json" }, body: '{"hits": 1}' }),
  );
  const transport = new FixtureScholarlyTransport(dir);
  const response = await transport.get(url);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { hits: 1 });
  assert.equal(response.header("CONTENT-TYPE"), "application/json");
  await assert.rejects(() => transport.get("https://api.example.com/unrecorded"), /no scholarly fixture/);
});

test("fixture filename is deterministic and query-sensitive", () => {
  const a = fixtureFileName("https://x.com/p?q=1");
  assert.equal(a, fixtureFileName("https://x.com/p?q=1"));
  assert.notEqual(a, fixtureFileName("https://x.com/p?q=2"));
});

// ------------------------------------------------------------ rate limit

test("rate limiter blocks after a 429 until Retry-After elapses", async () => {
  const limiter = new RateLimiter(10, 10);
  const wait = limiter.respectRetryAfter("h", "1");
  assert.equal(wait, 1000);
  const start = Date.now();
  await limiter.throttle("h");
  assert.ok(Date.now() - start >= 900, `expected to wait ~1s, waited ${Date.now() - start}ms`);
});

test("HttpScholarlyTransport races a stalled body read instead of hanging forever", async (context) => {
  // Live-observed on a bandwidth-throttled arxiv.org: headers arrive, the
  // body stalls, the socket dies quietly and arrayBuffer() never settles —
  // an invisible hang with zero handles. The transport must bound it.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({ start() {/* never enqueues */} }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const { HttpScholarlyTransport } = await import("./transport.js");
  const transport = new HttpScholarlyTransport(new RateLimiter(100, 1));
  await assert.rejects(
    () => transport.get("https://stalled.test/body", { timeoutMs: 30 }),
    /body read timed out/,
  );
});

// ----------------------------------------------------------- source chain

/** A scriptable transport for source-chain tests. */
function fakeTransport(
  routes: Record<string, { status: number; body?: string | Uint8Array }>,
): ScholarlyTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(url: string): Promise<ScholarlyResponse> {
      calls.push(url);
      const route = routes[url];
      if (!route) {
        throw new Error(`unexpected url ${url}`);
      }
      const bytes = typeof route.body === "string" ? new TextEncoder().encode(route.body) : (route.body ?? new Uint8Array());
      return {
        status: route.status,
        url,
        header: () => null,
        text: async () => new TextDecoder().decode(bytes),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
        bytes: async () => bytes,
      };
    },
  };
}

function ref(overrides: Partial<PaperRef> = {}): PaperRef {
  return {
    title: "T",
    authors: [],
    year: null,
    doi: null,
    arxivId: null,
    abstract: null,
    pdfUrl: null,
    source: "test",
    sourceId: "x",
    ...overrides,
  };
}

test("searchAcrossChain merges and dedups across sources, skipping failures", async () => {
  const good: PaperConnector = {
    name: "good",
    search: async () => [ref({ doi: "10.1/a" }), ref({ doi: "10.1/a" }), ref({ doi: "10.1/b" })],
    fetchMetadata: async () => null,
    resolvePdf: async () => null,
  };
  const bad: PaperConnector = {
    name: "bad",
    search: async () => {
      throw new Error("down");
    },
    fetchMetadata: async () => null,
    resolvePdf: async () => null,
  };
  const warnings: string[] = [];
  const results = await searchAcrossChain([bad, good], "q", 10, (message: string) => warnings.push(message));
  assert.equal(results.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /bad/);
});

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 fake pdf body");

test("downloadPaperPdf returns the first working pdf in chain order", async () => {
  const first: PaperConnector = {
    name: "first",
    search: async () => [],
    fetchMetadata: async () => null,
    resolvePdf: async () => "https://a.test/paper.pdf",
  };
  const second: PaperConnector = {
    name: "second",
    search: async () => [],
    fetchMetadata: async () => null,
    resolvePdf: async () => "https://b.test/paper.pdf",
  };
  const transport = fakeTransport({
    "https://a.test/paper.pdf": { status: 404 },
    "https://b.test/paper.pdf": { status: 200, body: PDF_BYTES },
  });
  const outcome = await downloadPaperPdf([first, second], ref(), {
    transport,
    assertUrl: async () => {},
  });
  assert.equal(outcome.source, "second");
  assert.equal(outcome.url, "https://b.test/paper.pdf");
  assert.deepEqual([...outcome.bytes], [...PDF_BYTES]);
});

test("downloadPaperPdf never re-fetches a URL a previous connector already killed", async () => {
  // CORE/EuropePMC/OpenAlex routinely resolve the SAME pdf URL; when the host
  // stalls, per-connector refetching multiplied one 120s timeout by seven
  // (observed live with a throttled arxiv.org).
  const shared = "https://dead.test/paper.pdf";
  const mk = (name: string): PaperConnector => ({
    name,
    search: async () => [],
    fetchMetadata: async () => null,
    resolvePdf: async () => shared,
  });
  const transport = fakeTransport({ [shared]: { status: 404 } });
  await assert.rejects(
    () => downloadPaperPdf([mk("a"), mk("b"), mk("c")], ref(), { transport, assertUrl: async () => {} }),
    /No downloadable PDF/,
  );
  assert.deepEqual(transport.calls, [shared]);
});

test("downloadPaperPdf mirror-expands arXiv pdf URLs from any connector", async () => {
  // A non-arXiv connector resolving an arxiv.org/pdf/<id> URL must get the
  // same mirror fallback as the arXiv connector itself.
  const coreLike: PaperConnector = {
    name: "core",
    search: async () => [],
    fetchMetadata: async () => null,
    resolvePdf: async () => "https://arxiv.org/pdf/0706.1062",
  };
  const transport = fakeTransport({
    "https://arxiv.org/pdf/0706.1062": { status: 404 },
    "https://cn.arxiv.org/pdf/0706.1062": { status: 200, body: PDF_BYTES },
  });
  const outcome = await downloadPaperPdf([coreLike], ref(), { transport, assertUrl: async () => {} });
  assert.equal(outcome.url, "https://cn.arxiv.org/pdf/0706.1062");
  assert.equal(outcome.source, "core");
});

test("downloadPaperPdf: transient failure outranks definitive misses", async () => {
  const flaky: PaperConnector = {
    name: "flaky",
    search: async () => [],
    fetchMetadata: async () => null,
    resolvePdf: async () => "https://a.test/p.pdf",
  };
  const transport = fakeTransport({
    "https://a.test/p.pdf": { status: 503 },
  });
  await assert.rejects(
    () => downloadPaperPdf([flaky], ref(), { transport, assertUrl: async () => {} }),
    /HTTP 503/,
  );
});

test("downloadPaperPdf: all definitive misses produce NotFoundError", async () => {
  const empty: PaperConnector = {
    name: "empty",
    search: async () => [],
    fetchMetadata: async () => null,
    resolvePdf: async () => null,
  };
  await assert.rejects(
    () => downloadPaperPdf([empty], ref({ title: "X" }), { transport: fakeTransport({}), assertUrl: async () => {} }),
    (error: unknown) => error instanceof NotFoundError,
  );
});

test("downloadPaperPdf rejects non-pdf content as a definitive miss", async () => {
  const connector: PaperConnector = {
    name: "html",
    search: async () => [],
    fetchMetadata: async () => null,
    resolvePdf: async () => "https://a.test/p.pdf",
  };
  const transport = fakeTransport({ "https://a.test/p.pdf": { status: 200, body: "<html>paywall</html>" } });
  await assert.rejects(
    () => downloadPaperPdf([connector], ref(), { transport, assertUrl: async () => {} }),
    NotFoundError,
  );
});

test("europepmc resolveFullTextXml returns jats for OA and null for 404", async () => {
  const jats = '<?xml version="1.0"?><article><body><sec><p>text</p></sec></body></article>';
  const transport = fakeTransport({
    "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC123/fullTextXML": { status: 200, body: jats },
    "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC404/fullTextXML": { status: 404 },
  });
  const connector = createEuropePmcConnector(transport);
  assert.equal(await connector.resolveFullTextXml(ref({ pmcId: "PMC123" })), jats);
  assert.equal(await connector.resolveFullTextXml(ref({ pmcId: "PMC404" })), null);
  assert.equal(await connector.resolveFullTextXml(ref({ doi: null })), null);
});

test("RateLimitError carries the retry delay", () => {
  const error = new RateLimitError("slow down", 5000);
  assert.equal(error.retryAfterMs, 5000);
});

test("assertSafeUrl rejects IPv4-mapped IPv6 and bracketed IPv6 literals (SSRF guard)", async () => {
  // WHATWG URL normalizes dotted mapped addresses to the compressed hex
  // form and keeps the brackets — both shapes must still hit the guard.
  const rejected = [
    "http://[::ffff:127.0.0.1]/p.pdf", // dotted mapped, loopback
    "http://[::ffff:7f00:1]/p.pdf", // hex mapped, loopback
    "http://[::ffff:a9fe:a9fe]/p.pdf", // hex mapped, link-local / cloud metadata
    "http://[::ffff:169.254.169.254]/p.pdf", // dotted mapped, cloud metadata
    "http://[::ffff:10.0.0.1]/p.pdf", // dotted mapped, RFC1918
    "http://[::ffff:c0a8:101]/p.pdf", // hex mapped, 192.168.1.1
    "http://[::1]/p.pdf", // IPv6 loopback literal
    "http://[::]/p.pdf", // IPv6 unspecified
    "http://[fe80::1]/p.pdf", // link-local literal
    "http://[fd00::1]/p.pdf", // ULA literal
    "http://127.0.0.1/p.pdf", // plain IPv4 loopback still rejected
  ];
  for (const url of rejected) {
    await assert.rejects(assertSafeUrl(url), /Refusing download from private address/, url);
  }
});

test("assertSafeUrl allows public IPv4 and IPv6 literals", async () => {
  await assertSafeUrl("http://8.8.8.8/p.pdf");
  await assertSafeUrl("http://[2606:4700:4700::1111]/p.pdf");
});

test("fetchPdf follows redirects manually and re-validates every hop", async () => {
  const connector: PaperConnector = {
    name: "redirector",
    search: async () => [],
    fetchMetadata: async () => null,
    resolvePdf: async () => "https://a.test/p.pdf",
  };
  const transport = fakeTransport({
    "https://a.test/p.pdf": { status: 302, body: "" },
    "https://evil.test/p.pdf": { status: 200, body: PDF_BYTES },
  });
  // Patch the 302 to carry a Location header via a wrapper transport.
  const wrapping: ScholarlyTransport = {
    get: async (url, options) => {
      const response = await transport.get(url, options);
      if (response.status === 302) {
        return { ...response, header: (name: string) => (name.toLowerCase() === "location" ? "https://evil.test/p.pdf" : null) };
      }
      return response;
    },
  };
  const asserted: string[] = [];
  const outcome = await downloadPaperPdf([connector], ref(), {
    transport: wrapping,
    assertUrl: async (url: string) => {
      asserted.push(url);
    },
  });
  // Both the initial URL AND the redirect target passed the SSRF guard.
  assert.deepEqual(asserted, ["https://a.test/p.pdf", "https://evil.test/p.pdf"]);
  assert.equal(outcome.source, "redirector");
});

test("semantic scholar sends the API key header only when configured", async () => {
  const seen: Array<Record<string, string> | undefined> = [];
  const transport: ScholarlyTransport = {
    async get(url, options) {
      seen.push(options?.headers);
      return {
        status: 200,
        url,
        header: () => null,
        text: async () => "",
        json: async () => ({ data: [] }),
        bytes: async () => new Uint8Array(),
      };
    },
  };
  await createSemanticScholarConnector(transport, "secret-key").search("ebola", 1);
  assert.equal(seen[0]?.["x-api-key"], "secret-key");
  await createSemanticScholarConnector(transport).search("ebola", 1);
  assert.equal(seen[1], undefined);
});

test("openalex citation fallback resolves arXiv-only refs by guarded title search", async () => {
  const calls: string[] = [];
  const work = {
    id: "https://openalex.org/W3196281824",
    title: "Mapping of Ebola virus spillover",
    referenced_works: ["https://openalex.org/W1"],
  };
  const transport: ScholarlyTransport = {
    async get(url) {
      calls.push(url);
      const body = url.includes("/works?search=")
        ? { results: [work, { id: "https://openalex.org/W9", title: "Unrelated title" }] }
        : url.includes("filter=openalex_id")
          ? { results: [{ id: "https://openalex.org/W1", title: "Cited work" }] }
          : work;
      return {
        status: 200,
        url,
        header: () => null,
        text: async () => "",
        json: async () => body,
        bytes: async () => new Uint8Array(),
      };
    },
  };
  const connector = createOpenAlexConnector(transport, {});
  const refs = await connector.resolveCitations!(ref({ arxivId: "1605.02833", doi: null, title: "Mapping of Ebola virus spillover" }));
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.title, "Cited work");
  // No DOI key lookup happened — the title search guarded the resolution.
  assert.ok(calls[0]?.includes("/works?search="));
  // A title that matches nothing yields no resolution (never the wrong paper).
  calls.length = 0;
  const empty = await connector.resolveCitations!(ref({ doi: null, title: "No such paper exists anywhere" }));
  assert.deepEqual(empty, []);
});
