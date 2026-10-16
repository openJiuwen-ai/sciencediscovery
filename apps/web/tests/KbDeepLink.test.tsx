// kb:// deep links on mirrored knowledge-base records (DbRecord nodes).
//
// KE retrieval tools (kb_search / kb_expand / doc_grep) mirror their hit
// documents into the memory graph as DbRecord products whose url is a
// kb://<kbId>/<docId> pseudo-link. The detail card must treat it as an in-app
// jump (never an external LinkField), so the parse is pinned here.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { parseKbDeepLink } from "../src/MemoryGraphProduct.js";

test("kb:// urls parse into kbId + docId", () => {
  assert.deepEqual(parseKbDeepLink("kb://kb1/doc-9"), { kbId: "kb1", docId: "doc-9" });
  assert.deepEqual(parseKbDeepLink("kb://d80eab69-1234/uuid-with-dashes-42"), {
    kbId: "d80eab69-1234",
    docId: "uuid-with-dashes-42",
  });
});

test("ordinary urls and missing values are not kb links", () => {
  assert.equal(parseKbDeepLink(undefined), null);
  assert.equal(parseKbDeepLink(""), null);
  assert.equal(parseKbDeepLink("https://doi.org/10.1/x"), null);
  assert.equal(parseKbDeepLink("kb://kb1"), null);
  assert.equal(parseKbDeepLink("kb://kb1/"), null);
  assert.equal(parseKbDeepLink("kb://kb1/doc/extra"), null);
  assert.equal(parseKbDeepLink("kbx://kb1/doc"), null);
});
