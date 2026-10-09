// DbRecord chip rendering and chain-button wiring.
//
// Pins three frontend contracts the agent relies on to render a cited
// database record this session retrieved via db_search:
//   - Markdown chip's graph://dbrecord/<id> URL (handler matches the bare
//     identifier — _ID_FIELDS["DbRecord"] in the sidecar — like evidence /
//     sourcefile).
//   - KIND_TO_LABEL.dbrecord = "DbRecord" so App.tsx's handleChipClick
//     fallthrough opens the graph explorer on a real DbRecord node.
//   - CHAIN_BUTTONS.DbRecord carries the two "ForDbRecord" kinds (the
//     kind-suffix split mirrors the Claim/Artifact collision fix — each
//     kind string in _BUTTON_CHAIN_HOPS must be unique). No cited-paper
//     button: a database record has no papers of its own.
//   - NODE_LABELS includes DbRecord so the legend/filter chip row lights
//     it up (an earlier change left WebPage/DbRecord as a gap; this file
//     closes the DbRecord half — WebPage closes in its own file).

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import { CHAIN_BUTTONS, NODE_LABELS } from "../src/MemoryGraphExplorer.js";
import { KIND_TO_LABEL } from "../src/Markdown.js";
import type { MemoryGraphNodeLabel } from "@sciencediscovery/schema";

test("KIND_TO_LABEL maps dbrecord to the DbRecord graph label", () => {
  // The fallthrough in App.tsx's handleChipClick relies on this map to pick
  // the graph label for any chip kind without a dedicated modal. dbrecord
  // has no dedicated modal — it MUST resolve so the explorer opens on a
  // real DbRecord node, not silently drop the click.
  assert.equal(KIND_TO_LABEL.dbrecord, "DbRecord");
  assert.equal(KIND_TO_LABEL.evidence, "Evidence");
  assert.equal(KIND_TO_LABEL.artifact, "Artifact");
  assert.equal(KIND_TO_LABEL.sourcefile, "SourceFile");
  // session/skill remain undefined (they are composer-context references,
  // not graph chips — they never reach the chip handler).
  assert.equal(KIND_TO_LABEL.session, undefined);
  assert.equal(KIND_TO_LABEL.skill, undefined);
});

test("NODE_LABELS includes DbRecord for the legend / filter chip", () => {
  // The legend row walks NODE_LABELS; DbRecord was a leftover gap that this
  // file closes (WebPage closes in its own file — the two have parallel
  // paths).
  assert.ok(NODE_LABELS.includes("DbRecord" as MemoryGraphNodeLabel));
  // Every existing label must still be present (regression guard).
  for (const expected of [
    "ResearchGoal", "Task", "ToolCall", "Paper", "Evidence", "Claim", "Code",
    "Artifact", "SourceFile",
  ] as MemoryGraphNodeLabel[]) {
    assert.ok(NODE_LABELS.includes(expected), `${expected} missing from NODE_LABELS`);
  }
});

test("CHAIN_BUTTONS.DbRecord has the two ForDbRecord kinds", () => {
  // Each kind MUST be unique across the whole table (the sidecar's
  // _BUTTON_CHAIN_HOPS is keyed by kind alone, so a collision would silently
  // overwrite one button's hop list). The ForDbRecord suffix dodges the same
  // kind collision that already bit viewCitingEvidence (split as
  // viewCitingEvidenceForClaim / viewCitingEvidenceForArtifact).
  //
  // There is no "cited paper" button: a database record has no papers of its
  // own. The traversal that used to sit behind it (supports→Claim, then
  // supports-in→Evidence, then extracts-in→"Paper") left the record's own
  // neighbourhood on its second hop — the Evidence that backs the same Claim —
  // and its terminal hop is not label-filtered, so a db-backed session opened
  // the source WebPage under a "cited paper" label.
  const buttons = CHAIN_BUTTONS.DbRecord ?? [];
  assert.equal(buttons.length, 2, "DbRecord must have exactly two buttons");
  const kinds = buttons.map((b) => b.kind).sort();
  assert.deepEqual(kinds, [
    "viewCitingClaimForDbRecord",
    "viewSearchingTaskForDbRecord",
  ]);
  assert.equal(kinds.includes("viewCitedPaperForDbRecord" as never), false,
    "no cited-paper button on a database record");
  // Each button's i18n key is the chain.* convention; no two buttons share a
  // key (the table keys off `key` in the frontend's button render).
  const keys = new Set(buttons.map((b) => b.key));
  assert.equal(keys.size, buttons.length, "DbRecord buttons have unique i18n keys");
});
