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

/** extractRawTexts regression tests.
 *
 *  The web-page mirror needs each MCP record to carry its own body text so
 *  get_pages's per-page bodies land in CAS individually (one contentHash per
 *  page, not a single hash smeared across every record). Before this fix
 *  every record shared the same rawText, so multi-page tool calls either
 *  collided on contentHash or dropped the body entirely. The unit cases pin
 *  the three payload shapes the MCP wiki tools can emit plus the failure
 *  modes that must NOT crash the mirror.
 */

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import type { CasStore } from "@sciencediscovery/cas";
import type { McpRecord } from "@sciencediscovery/schema";

import { extractRawTexts, mcpRecordToProduct } from "./broker.js";

test("get_page single-page payload exposes one body to every record", () => {
  // get_page returns { content: "..." } — one text shared across all records.
  const raw = { structuredContent: { content: "page one body" } };
  const out = extractRawTexts(raw, "get_page");
  assert.deepEqual(out, ["page one body"]);
});

test("get_pages multi-page payload exposes one body per page in order", () => {
  // get_pages returns { pages: [{content: "..."}, ...] } — one slot per page.
  const raw = {
    structuredContent: {
      pages: [
        { content: "page one" },
        { content: "page two" },
        { content: "page three" },
      ],
    },
  };
  const out = extractRawTexts(raw, "get_pages");
  assert.deepEqual(out, ["page one", "page two", "page three"]);
});

test("get_pages pages without content land as empty slots to keep record indices aligned", () => {
  // A page with a missing/non-string content degrades to "" (snippet-only),
  // not a skipped entry — the mirror's per-record text MUST stay aligned with
  // the records array, otherwise page N's body could land on record N-1.
  const raw = {
    structuredContent: {
      pages: [
        { content: "first" },
        { content: 42 },          // non-string
        {},                        // missing
        { content: "fourth" },
      ],
    },
  };
  const out = extractRawTexts(raw, "get_pages");
  assert.deepEqual(out, ["first", "", "", "fourth"]);
});

test("get_pages falls through to text-block JSON when structuredContent is absent", () => {
  // Some MCP transports only set the text-block form. The parser accepts that
  // shape and produces the same per-page array.
  const raw = {
    content: [{
      type: "text",
      text: JSON.stringify({
        pages: [{ content: "via text block one" }, { content: "via text block two" }],
      }),
    }],
  };
  const out = extractRawTexts(raw, "get_pages");
  assert.deepEqual(out, ["via text block one", "via text block two"]);
});

test("malformed JSON text-block degrades to undefined (no crash)", () => {
  // A non-JSON text body must NOT throw — the mirror degrades to
  // snippet-only and the call still succeeds. The wiki docs allow this path
  // for server-side error pages that aren't valid JSON.
  const raw = { content: [{ type: "text", text: "not json at all" }] };
  const out = extractRawTexts(raw, "get_pages");
  assert.equal(out, undefined);
});

test("non-search tools always return undefined regardless of payload", () => {
  // Search tools (web_search / db_search) carry no body — extractRawTexts
  // must short-circuit before touching the payload, so a stray content field
  // never accidentally becomes a WebPage body.
  const raw = { structuredContent: { content: "leak" } };
  assert.equal(extractRawTexts(raw, "web_search"), undefined);
  assert.equal(extractRawTexts(raw, "db_search"), undefined);
  assert.equal(extractRawTexts(raw, "image_search"), undefined);
});

test("non-object payload returns undefined", () => {
  // A string/null payload (corrupted cache read, etc.) must NOT crash.
  assert.equal(extractRawTexts({ structuredContent: "raw string" }, "get_page"), undefined);
  assert.equal(extractRawTexts({ structuredContent: null }, "get_page"), undefined);
});

test("get_pages pads to recordsCount when records outnumber pages (no smear)", () => {
  // The upstream wiki sometimes drops empty pages between extract and
  // normalize, so records[] can outnumber pages[]. The contract: the
  // returned array is index-aligned with records[] — pads with "" past
  // its end, never carries an earlier slot's body onto a tail record.
  // Without this, the tail records would either fail the per-record index
  // access or, worse, smear page-0 onto page-2.
  const raw = {
    structuredContent: { pages: [{ content: "page one body" }] },
  };
  const out = extractRawTexts(raw, "get_pages", 3);
  assert.deepEqual(out, ["page one body", "", ""]);
});

test("get_pages pages-outnumber-records is left untrimmed (caller drops the tail)", () => {
  // pages[] outnumbering records[] is left untrimmed here — the caller
  // (buildMirrorProducts) iterates records.map and indexes rawTexts by
  // record position, so surplus page texts are simply never accessed.
  // Trimming would be redundant work; leaving them preserves the source
  // of truth (every page that did arrive got its body).
  const raw = {
    structuredContent: {
      pages: [
        { content: "p1" },
        { content: "p2" },
        { content: "p3" },
      ],
    },
  };
  const out = extractRawTexts(raw, "get_pages", 2);
  assert.deepEqual(out, ["p1", "p2", "p3"]);
});

test("get_page single text is not padded (1-record contract holds regardless of recordsCount)", () => {
  // get_page's "shared single text" contract is independent of record count:
  // the caller always sees a 1-slot array. Padding only applies to the
  // get_pages branch where index-alignment actually matters.
  const raw = { structuredContent: { content: "shared body" } };
  assert.deepEqual(extractRawTexts(raw, "get_page", 5), ["shared body"]);
  assert.deepEqual(extractRawTexts(raw, "get_page", 1), ["shared body"]);
});

/** Product dispatch — mcpRecordToProduct.
 *
 *  The dispatch key used to be the tool's coarse graph *type*, whose final
 *  branch was a bare `return db_record`. Any tool registered with a type that
 *  was not spelled out above silently landed as a DbRecord: a wrong node that
 *  surfaces much later as a 422 from declare_evidence. These cases pin the
 *  four shapes and the loud failure that replaced the fallthrough.
 */

const RECORD: McpRecord = {
  abstract: "abstract text",
  authors: ["A. Author"],
  crossReferences: [{ identifier: "ref-1" }],
  identifier: "P38398",
  identifierType: "UniProt",
  source: "uniprot",
  title: "BRCA1",
  url: "https://example.test/p38398",
  year: "1994",
} as McpRecord;

/** Only the ``put`` reachable from the web_page branch matters here; the other
 *  branches never touch CAS, so a stub is enough and keeps the test off the
 *  filesystem. */
function stubCas(): CasStore {
  return { put: async () => ({ hash: "deadbeef" }) } as unknown as CasStore;
}

test("mcpRecordToProduct dispatches on the product, not the tool type", async () => {
  assert.equal((await mcpRecordToProduct(RECORD, "paper", undefined, stubCas())).productType, "paper");
  assert.equal((await mcpRecordToProduct(RECORD, "db_record", undefined, stubCas())).productType, "db_record");
  assert.equal((await mcpRecordToProduct(RECORD, "web_page", undefined, stubCas())).productType, "web_page");
});

test("a fetch tool's products keep their web_page shape and contentHash", async () => {
  // web_fetch used to be typed "web_search"; the collapse moved both the
  // search and the fetch tool onto "search", which is exactly the case that
  // would have gone wrong if the emitter had kept dispatching on the type:
  // "search" names no product, and the old fallthrough would have emitted a
  // DbRecord for every fetched page.
  const product = await mcpRecordToProduct(RECORD, "web_page", "page body", stubCas());
  assert.equal(product.productType, "web_page");
  assert.equal(product.contentHash, "deadbeef", "the body still lands in CAS");
  assert.deepEqual(product.sourceRefs, ["ref-1"]);
});

test("a code product on the MCP mirror path throws instead of becoming a DbRecord", async () => {
  // The old silent fallthrough. Execution products reach the graph through
  // the provenance recorder, so a "code" product arriving here means a
  // registration mistake — and losing the mirror (the caller's catch logs it)
  // beats writing a node nobody can find.
  await assert.rejects(
    () => mcpRecordToProduct(RECORD, "code", undefined, stubCas()),
    /code-producing tool is registered on the MCP mirror path/,
  );
});
