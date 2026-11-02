// Escape inside the memory-graph explorer.
//
// The explorer binds a window-level Escape that closes the whole layer. Its
// embedded artifact panel can have a CSV workspace or a Mol* viewer open on
// top, and each of those binds its own Escape; the standalone artifact modal
// already refuses to close while either is open, but in embedded mode that
// guard returns early (`if (embedded) return;`) and the explorer's
// unconditional handler is the only one left — so one keypress tore down both
// the nested window and the exploration state behind it.
//
// The decision is a pure predicate so it can be tested without mounting the
// explorer: the canvas is a WebGL island the SSR harness cannot run, and
// `apps/web` has no jsdom. The wiring is pinned by reading the two sources,
// the same way SidebarDrawer.test.tsx pins its Escape handler.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { shouldCloseOnEscape } from "../src/MemoryGraphExplorer.js";

const sourceRoot = new URL("../src/", import.meta.url);

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, sourceRoot), "utf8");
}

test("Escape closes the explorer only when no nested window is open", () => {
  assert.equal(shouldCloseOnEscape(false, false), true);
});

test("a CSV workspace on top keeps the explorer mounted", () => {
  assert.equal(shouldCloseOnEscape(true, false), false);
});

test("a Mol* viewer on top keeps the explorer mounted", () => {
  assert.equal(shouldCloseOnEscape(false, true), false);
});

test("both nested windows open still keep the explorer mounted", () => {
  assert.equal(shouldCloseOnEscape(true, true), false);
});

test("the explorer's Escape handler asks the predicate about its nested windows", () => {
  const explorer = source("MemoryGraphExplorer.tsx");
  assert.match(explorer, /event\.key === "Escape" && shouldCloseOnEscape\(/);
  // A bare "Escape → onClose" would close the explorer under the window the
  // user is reading; the predicate has to sit between them.
  assert.doesNotMatch(explorer, /if \(event\.key === "Escape"\) onClose\(\);/);
});

test("the embedded artifact panel reports its nested windows upward", () => {
  // The explorer cannot see `csvWindowOpen`/`molstarOpen`: they are state of
  // the artifact modal it embeds. The modal has to hand them up, or the
  // explorer's predicate can never be true.
  assert.match(source("ScientificArtifacts.tsx"), /onNestedWindowChange\?\.\(\{ csvWindowOpen, molstarOpen \}\)/);
});
