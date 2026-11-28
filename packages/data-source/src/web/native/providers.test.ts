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

/**
 * Provider tests run against a real local HTTP server rather than a stubbed
 * transport: the parts most likely to break are request shape, status handling,
 * and payload normalization, and a hand-rolled fetch double would assert only
 * what the test itself invented.
 */

import { createTest } from "../../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";


import {
  NativeWebProviderClient,
  WebProviderError,
  errorDocumentCode,
  isErrorDocument,
} from "./index.js";
import { decodeBingRedirect, parseBingHtml, parseBraveHtml, parseDuckDuckGoHtml } from "./free-engines.js";
import { assertPublicUrl, isBlockedAddress, PublicUrlError } from "./url-guard.js";

interface Captured {
  body: string;
  headers: IncomingMessage["headers"];
  method: string;
  url: string;
}

/** Start a throwaway HTTP server and return its origin plus captured requests. */
async function localServer(
  handler: (request: IncomingMessage, response: ServerResponse, captured: Captured) => void,
): Promise<{ close: () => Promise<void>; origin: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const captured: Captured = {
        body: Buffer.concat(chunks).toString("utf8"),
        headers: request.headers,
        method: request.method ?? "",
        url: request.url ?? "",
      };
      requests.push(captured);
      handler(request, response, captured);
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;
  return {
    close: () => new Promise<void>((resolveClose) => { server.close(() => resolveClose()); }),
    origin: `http://127.0.0.1:${port}`,
    requests,
  };
}

test("DuckDuckGo HTML parsing unwraps redirects and pairs snippets", () => {
  const html = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fp53&amp;rut=x">TP53 <b>gene</b></a>
      <a class="result__snippet">Tumor <b>suppressor</b> protein.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://direct.test/article">Direct result</a>
      <a class="result__snippet">Second snippet</a>
    </div>`;
  const results = parseDuckDuckGoHtml(html, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.url, "https://example.test/p53");
  assert.equal(results[0]?.title, "TP53 gene");
  assert.equal(results[0]?.content, "Tumor suppressor protein.");
  assert.equal(results[1]?.url, "https://direct.test/article");
});

test("DuckDuckGo parsing honours the result cap and skips malformed rows", () => {
  const row = (index: number) =>
    `<a class="result__a" href="https://example.test/${index}">Title ${index}</a><a class="result__snippet">S${index}</a>`;
  const html = `<a class="result__a" href="">   </a>${[1, 2, 3, 4, 5, 6, 7].map(row).join("")}`;
  assert.equal(parseDuckDuckGoHtml(html, 5).length, 5);
});

test("Bing parsing decodes the /ck/a redirect instead of returning a tracker URL", () => {
  // `a1` + base64url of https://example.test/p53 — the shape Bing wraps organic
  // hits in. Without decoding, every result URL would point back at bing.com.
  const wrapped = "https://www.bing.com/ck/a?!&&p=1&u=a1aHR0cHM6Ly9leGFtcGxlLnRlc3QvcDUz&ntb=1";
  assert.equal(decodeBingRedirect(wrapped), "https://example.test/p53");
  // Unrecognised shapes keep the original rather than guessing at a decode.
  assert.equal(decodeBingRedirect("https://www.bing.com/ck/a?u=zz%%%"), "https://www.bing.com/ck/a?u=zz%%%");
  assert.equal(decodeBingRedirect("https://plain.test/a"), "https://plain.test/a");

  const html = `<main aria-label="Search Results">
    <li class="b_algo"><h2><a href="${wrapped}">TP53 <strong>gene</strong></a></h2>
      <div class="b_caption"><p>Tumor suppressor &amp; guardian.</p></div></li>
    <li class="b_algo"><h2><a href="https://direct.test/x">Direct</a></h2><p>Second</p></li>
    <li class="b_ad"><h2><a href="https://ad.test/x">Ad</a></h2></li>
  </main>`;
  const rows = parseBingHtml(html, 5);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    content: "Tumor suppressor & guardian.",
    title: "TP53 gene",
    url: "https://example.test/p53",
  });
  assert.equal(rows[1]?.url, "https://direct.test/x");
});

test("Brave free-page parsing extracts each web result and honours the cap", () => {
  const block = (index: number) => `<div data-type="web">
    <a href="https://example.test/${index}"><div class="title">Result ${index}</div></a>
    <div class="snippet-description">Snippet ${index}</div>
  </div>`;
  const html = `<div data-type="news"><a href="https://news.test/x">News</a></div>${[1, 2, 3].map(block).join("")}`;
  const rows = parseBraveHtml(html, 2);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { content: "Snippet 1", title: "Result 1", url: "https://example.test/1" });
});

test("a page that no longer matches yields no rows instead of throwing", () => {
  // A layout change must degrade to "no results" so the aggregation moves to
  // the next engine; a parser exception would fail the whole search.
  for (const parse of [parseBingHtml, parseBraveHtml, parseDuckDuckGoHtml]) {
    assert.deepEqual(parse("<html><body><p>redesigned</p></body></html>", 5), []);
  }
});

test("a keyed provider without a credential fails before any request", async () => {
  const client = new NativeWebProviderClient();
  await assert.rejects(
    client.invoke({ operation: "search", provider: "tavily", request: "TP53" }),
    (error: unknown) => error instanceof WebProviderError
      && error.code === "unauthorized"
      && error.retryable === false,
  );
});

test("an empty query is rejected as invalid input, not attempted", async () => {
  const client = new NativeWebProviderClient();
  await assert.rejects(
    client.invoke({ operation: "search", provider: "duckduckgo", request: "   " }),
    (error: unknown) => error instanceof WebProviderError && error.code === "invalid-input",
  );
});

test("provider error documents are reported as failures, not cached content", () => {
  assert.equal(isErrorDocument("Error: No results found"), true);
  assert.equal(isErrorDocument('{"error": "No results found", "query": "x"}'), true);
  assert.equal(isErrorDocument('{"results": []}'), false);
  assert.equal(isErrorDocument('[{"title": "ok"}]'), false);
  assert.equal(errorDocumentCode("Error: HTTP 429 too many requests"), "rate-limited");
  assert.equal(errorDocumentCode("Error: unauthorized"), "unauthorized");
  assert.equal(errorDocumentCode("Error: request timed out"), "timeout");
  assert.equal(errorDocumentCode("Error: nothing matched"), "semantic-error");
});

test("web_fetch refuses private and loopback targets", async () => {
  for (const address of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "::1", "fd00::1"]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "93.184.216.34", "2606:2800::1"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
  await assert.rejects(assertPublicUrl("http://localhost/x"), PublicUrlError);
  await assert.rejects(assertPublicUrl("https://user:pw@example.test/x"), PublicUrlError);
  await assert.rejects(assertPublicUrl("file:///etc/passwd"), PublicUrlError);
  // A public name that resolves into private space must still be refused.
  await assert.rejects(
    assertPublicUrl("https://internal.example.test/x", async () => ["10.1.2.3"]),
    PublicUrlError,
  );
  await assert.rejects(
    assertPublicUrl("https://unresolved.example.test/x", async () => []),
    { name: "PublicUrlError", message: "host could not be resolved" },
  );
  await assert.rejects(
    assertPublicUrl("https://mixed.example.test/x", async () => ["93.184.216.34", "fd00::1"]),
    { name: "PublicUrlError", message: "local and private network URLs are not allowed" },
  );
  assert.equal(
    await assertPublicUrl("https://example.test/x", async () => ["93.184.216.34"]),
    "https://example.test/x",
  );
});

test("web_fetch judges IPv4-mapped and IPv4-compatible IPv6 literals by their embedded IPv4", async () => {
  // Hex forms carry no dotted quad, so they exercise the IPv4 extraction, not the existing regex.
  for (const address of ["::ffff:7f00:1", "0:0:0:0:0:ffff:a9fe:a9fe", "::7f00:1", "::a9fe:a9fe"]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  // The dotted-quad path keeps its behaviour.
  assert.equal(isBlockedAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedAddress("::ffff:93.184.216.34"), false);
  // The gate rejects the hex forms too.
  await assert.rejects(assertPublicUrl("http://[::ffff:7f00:1]/"), PublicUrlError);
  await assert.rejects(assertPublicUrl("http://[0:0:0:0:0:ffff:a9fe:a9fe]/latest/meta-data/"), PublicUrlError);
  await assert.rejects(assertPublicUrl("http://[::7f00:1]/"), PublicUrlError);
  // And public IPv6 is still accepted, so the guard cannot become "reject everything".
  for (const address of ["2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
  // Reverse direction for the mapped/compatible forms: a public embedded IPv4 must stay public.
  assert.equal(isBlockedAddress("::ffff:808:808"), false);
  assert.equal(isBlockedAddress("::808:808"), false);
  assert.equal(
    await assertPublicUrl("http://[::ffff:8.8.8.8]/"),
    "http://[::ffff:8.8.8.8]/",
  );
  // The embedded IPv4 is judged by ipv4Blocked itself, so its whole range table applies.
  assert.equal(isBlockedAddress("::ffff:6440:1"), true, "CGNAT 100.64.0.1");
  assert.equal(isBlockedAddress("::ffff:c612:1"), true, "benchmark 198.18.0.1");
  assert.equal(
    await assertPublicUrl("https://[2606:4700:4700::1111]/x"),
    "https://[2606:4700:4700::1111]/x",
  );
});

test("web_fetch judges NAT64, 6to4, IPv4-translated, Teredo and site-local literals by their embedded IPv4", async () => {
  // Each family decodes its embedded IPv4 and hands it to the same ipv4Blocked table, so the
  // loopback, RFC1918, link-local metadata and CGNAT rows all reject through one rule.
  const blocked = [
    // NAT64 well-known prefix 64:ff9b::/96
    "64:ff9b::7f00:1",        // 127.0.0.1
    "64:ff9b::a00:1",         // 10.0.0.1
    "64:ff9b::a9fe:a9fe",     // 169.254.169.254
    "64:ff9b::6440:1",        // 100.64.0.1
    // NAT64 local-use prefix 64:ff9b:1::/96
    "64:ff9b:1::7f00:1",
    "64:ff9b:1::a00:1",
    "64:ff9b:1::a9fe:a9fe",
    "64:ff9b:1::6440:1",
    // 6to4 2002::/16
    "2002:7f00:1::",
    "2002:a00:1::",
    "2002:a9fe:a9fe::",
    "2002:6440:1::",
    // IPv4-translated ::ffff:0:0:0/96
    "::ffff:0:7f00:1",
    "::ffff:0:a00:1",
    "::ffff:0:a9fe:a9fe",
    "::ffff:0:6440:1",
    // Teredo 2001:0::/32, whose client IPv4 is stored bitwise-inverted
    "2001:0:4136:e378:8000:63bf:80ff:fffe", // 127.0.0.1
    "2001:0:4136:e378:8000:63bf:f5ff:fffe", // 10.0.0.1
    "2001:0:4136:e378:8000:63bf:5601:5601", // 169.254.169.254
    "2001:0:4136:e378:8000:63bf:9bbf:fffe", // 100.64.0.1
    // Deprecated site-local fec0::/10 carries no IPv4 at all
    "fec0::1",
    "fec0:ffff::abcd",
  ];
  for (const address of blocked) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  // Public embedded IPv4 values stay public: rejecting a whole prefix would break NAT64/6to4 egress.
  const allowed = [
    "64:ff9b::808:808",                     // NAT64 to 8.8.8.8
    "64:ff9b:1::808:808",                   // local-use NAT64 to 8.8.8.8
    "2002:808:808::",                       // 6to4 to 8.8.8.8
    "::ffff:0:808:808",                     // IPv4-translated 8.8.8.8
    "2001:0:4136:e378:8000:63bf:f7f7:f7f7", // Teredo client 8.8.8.8
    "2606:4700:4700::1111",                 // native public IPv6, none of these classes
  ];
  for (const address of allowed) {
    assert.equal(isBlockedAddress(address), false, address);
  }
  // The literal gate rejects a private embedded address in every family ...
  for (const address of [
    "64:ff9b::7f00:1", "64:ff9b:1::a00:1", "2002:7f00:1::", "::ffff:0:7f00:1",
    "2001:0:4136:e378:8000:63bf:3f57:fefe", "fec0::1",
  ]) {
    await assert.rejects(assertPublicUrl(`http://[${address}]/`), PublicUrlError, address);
  }
  // ... and accepts the public embedded values, so an IPv6-only/NAT64 network keeps web_fetch.
  for (const address of [
    "64:ff9b::808:808", "2002:808:808::", "::ffff:0:808:808",
    "2001:0:4136:e378:8000:63bf:f7f7:f7f7",
  ]) {
    assert.equal(await assertPublicUrl(`http://[${address}]/`), `http://[${address}]/`, address);
  }
});

test("web_fetch judges dotted and hex spellings of an embedded IPv4 alike", async () => {
  // A trailing dotted quad is the same 32 bits as two hextets. Each family keeps its address in a
  // different position, so the dotted spelling must be placed there too rather than judged at the
  // tail: 6to4 carries it in hextets 1-2 and Teredo inverts hextets 6-7.
  const spellings = [
    ["2002:a9fe:a9fe::1.1.1.1", "2002:a9fe:a9fe::101:101"],                                 // 6to4 -> 169.254.169.254
    ["2001:0:4136:e378:8000:63bf:128.255.255.254", "2001:0:4136:e378:8000:63bf:80ff:fffe"], // Teredo -> 127.0.0.1
    ["2002:808:808::8.8.8.8", "2002:808:808::808:808"],                                     // 6to4 -> 8.8.8.8
    ["2001:0:4136:e378:8000:63bf:247.247.247.247", "2001:0:4136:e378:8000:63bf:f7f7:f7f7"], // Teredo -> 8.8.8.8
    ["64:ff9b::169.254.169.254", "64:ff9b::a9fe:a9fe"],                                     // NAT64 -> 169.254.169.254
    ["::ffff:0:127.0.0.1", "::ffff:0:7f00:1"],                                              // IPv4-translated -> 127.0.0.1
  ] as const;
  for (const [dotted, hex] of spellings) {
    assert.equal(isBlockedAddress(dotted), isBlockedAddress(hex), `${dotted} vs ${hex}`);
  }
  // Dotted spellings of private embedded values are blocked, at their own family's position ...
  for (const address of [
    "2002:a9fe:a9fe::1.1.1.1",                    // 6to4 to 169.254.169.254
    "2001:0:4136:e378:8000:63bf:128.255.255.254", // Teredo deobfuscates to 127.0.0.1
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
    await assert.rejects(assertPublicUrl(`http://[${address}]/`), PublicUrlError, address);
  }
  // ... and dotted spellings of public embedded values stay allowed. URL parsing canonicalises an
  // IPv6 host to hex, so the gate confirms the same verdict for the equivalent canonical form.
  for (const address of [
    "2002:808:808::8.8.8.8",                     // 6to4 to 8.8.8.8
    "2001:0:4136:e378:8000:63bf:247.247.247.247", // Teredo deobfuscates to 8.8.8.8
  ]) {
    assert.equal(isBlockedAddress(address), false, address);
    assert.equal(await assertPublicUrl(`http://[${address}]/`), `http://[${address}]/`, address);
  }
  // The mapped forms keep their previous verdicts under both spellings.
  assert.equal(isBlockedAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedAddress("::ffff:93.184.216.34"), false);
  assert.equal(await assertPublicUrl("http://[::ffff:8.8.8.8]/"), "http://[::ffff:8.8.8.8]/");
});

test("web_fetch applies the same judgement to resolved addresses, not only literals", async () => {
  // The DNS path runs the same predicate, so a mapped literal returned by a resolver must reject.
  await assert.rejects(
    assertPublicUrl("http://example.com/", async () => ["::ffff:7f00:1"]),
    PublicUrlError,
  );
  // Every family added for #665 must reject on the resolver path too.
  for (const address of [
    "64:ff9b::7f00:1", "64:ff9b:1::a00:1", "2002:7f00:1::", "::ffff:0:7f00:1",
    "2001:0:4136:e378:8000:63bf:80ff:fffe", "fec0::1",
  ]) {
    await assert.rejects(
      assertPublicUrl("http://example.com/", async () => [address]),
      PublicUrlError,
      address,
    );
  }
  // A resolver answer that embeds a public IPv4 stays acceptable.
  assert.equal(
    await assertPublicUrl("http://example.com/", async () => ["2002:808:808::"]),
    "http://example.com/",
  );
});

test("normalizers reduce each vendor payload to its documented shape", async () => {
  const { normalizeBraveResults, normalizeExaResults, normalizeTavilyResults } = await import("./search.js");
  const { renderExaContents, renderTavilyExtract } = await import("./fetch.js");

  assert.deepEqual(
    normalizeBraveResults(JSON.stringify({
      web: { results: [{ description: "<b>Tumor</b> suppressor", title: "TP53", url: "https://example.test/p53" }] },
    }), 5),
    [{ content: "Tumor suppressor", title: "TP53", url: "https://example.test/p53" }],
  );
  // A payload without the expected container must degrade to empty, not throw:
  // the caller turns "no results" into a fallback-eligible attempt.
  assert.deepEqual(normalizeBraveResults(JSON.stringify({}), 5), []);

  assert.deepEqual(
    normalizeTavilyResults(JSON.stringify({ results: [{ content: "snippet", title: "T", url: "https://a.test" }] }), 5),
    [{ content: "snippet", title: "T", url: "https://a.test" }],
  );

  assert.deepEqual(
    normalizeExaResults(JSON.stringify({ results: [{ highlights: ["one", "two"], title: "E", url: "https://b.test" }] }), 5),
    [{ content: "one\ntwo", title: "E", url: "https://b.test" }],
  );

  assert.equal(renderTavilyExtract({ failed_results: [{ error: "paywalled" }] }), "Error: paywalled");
  assert.equal(renderTavilyExtract({ results: [] }), "Error: No results found");
  assert.equal(renderTavilyExtract({ results: [{ raw_content: "body", title: "Doc" }] }), "# Doc\n\nbody");
  assert.equal(renderExaContents({ results: [{ text: "body", title: "" }] }), "# Untitled\n\nbody");
  assert.equal(
    renderTavilyExtract({ results: [{ raw_content: "x".repeat(5_000), title: "Long" }] }).length,
    "# Long\n\n".length + 4_096,
  );
});

test("keyed providers authenticate the way their vendor SDK did", async () => {
  // Tavily moved from `api_key` in the body to a bearer header in the SDK this
  // path replaced; Exa and Brave use their own header names. Getting this wrong
  // fails only against the live vendor, so pin the header shape here.
  const { buildTavilyAuthHeaders } = await import("./search.js");
  assert.deepEqual(buildTavilyAuthHeaders("k"), {
    authorization: "Bearer k",
    "content-type": "application/json",
  });
  assert.deepEqual(buildTavilyAuthHeaders(undefined), { "content-type": "application/json" });
});

test("the shared transport classifies status codes and bounds the body", async (context) => {
  const { MAX_PROVIDER_RESPONSE_BYTES, providerRequest, statusErrorCode, thrownErrorCode } = await import("./http.js");
  assert.equal(statusErrorCode(401), "unauthorized");
  assert.equal(statusErrorCode(403), "unauthorized");
  assert.equal(statusErrorCode(429), "rate-limited");
  assert.equal(statusErrorCode(503), "server-error");
  assert.equal(statusErrorCode(404), "semantic-error");
  assert.equal(thrownErrorCode(Object.assign(new Error("x"), { name: "AbortError" })), "timeout");
  assert.equal(thrownErrorCode(new Error("connect ECONNREFUSED")), "transport-error");

  const server = await localServer((request, response) => {
    if (request.url === "/big") {
      response.writeHead(200).end("x".repeat(MAX_PROVIDER_RESPONSE_BYTES + 1_024));
      return;
    }
    response.writeHead(429, { "content-type": "text/plain" }).end("slow down");
  });
  context.after(() => server.close());

  const limited = await providerRequest({ timeoutMs: 5_000, url: `${server.origin}/limited` });
  assert.equal(limited.statusCode, 429);
  assert.equal(statusErrorCode(limited.statusCode), "rate-limited");

  await assert.rejects(
    providerRequest({ timeoutMs: 5_000, url: `${server.origin}/big` }),
    /exceeded the 1 MB limit/,
  );
});

test("a hung endpoint is cut off by the operation budget", async (context) => {
  const { providerRequest, thrownErrorCode } = await import("./http.js");
  const server = await localServer((_request, response) => {
    // Headers only, body never completes: the wall-clock budget must win.
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("partial");
  });
  context.after(() => server.close());

  await assert.rejects(
    providerRequest({ timeoutMs: 150, url: `${server.origin}/hang` }),
    (error: unknown) => thrownErrorCode(error) === "timeout",
  );
});
