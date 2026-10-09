// WebPage chip rendering and chain-button wiring.
//
// Pins the frontend contracts that surface a WebPage node in the memory graph:
//   - NODE_LABELS includes WebPage so the legend / filter chip row lights it
//     up (an earlier change left WebPage/DbRecord as a gap; the DbRecord half
//     closed in its own file, this file closes WebPage).
//   - CHAIN_BUTTONS.WebPage carries the four ForWebPage kinds (the kind-suffix
//     split mirrors the Claim/Artifact and DbRecord collision fixes — each
//     kind string in _BUTTON_CHAIN_HOPS must be unique).
//   - The four WebPage chain buttons have unique i18n keys (frontend table
//     keys off `key`).
//
// This sits next to DbrecordChip.test.tsx — the two changes run in
// parallel and each closed its half of the legend gap.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import { CHAIN_BUTTONS, NODE_LABELS } from "../src/MemoryGraphExplorer.js";
import type { MemoryGraphNodeLabel } from "@sciencediscovery/schema";

test("NODE_LABELS includes WebPage for the legend / filter chip", () => {
  // The legend row walks NODE_LABELS. The DbRecord half closed in its own
  // file; this file closes WebPage.
  assert.ok(NODE_LABELS.includes("WebPage" as MemoryGraphNodeLabel));
  // Every existing label must still be present (regression guard).
  for (const expected of [
    "ResearchGoal", "Task", "ToolCall", "Paper", "Evidence", "Claim", "Code",
    "Artifact", "SourceFile", "DbRecord",
  ] as MemoryGraphNodeLabel[]) {
    assert.ok(NODE_LABELS.includes(expected), `${expected} missing from NODE_LABELS`);
  }
});

test("CHAIN_BUTTONS.WebPage has the four ForWebPage kinds", () => {
  // Each kind MUST be unique across the whole table (the sidecar's
  // _BUTTON_CHAIN_HOPS is keyed by kind alone, so a collision would silently
  // overwrite one button's hop list). The ForWebPage suffix dodges the same
  // kind-collision class that bit viewCitingEvidence (split as
  // viewCitingEvidenceForClaim / viewCitingEvidenceForArtifact) and the
  // ForDbRecord split. Four buttons mirror the Paper citation chain:
  // extracts → citing claim → citing artifact → searching task.
  const buttons = CHAIN_BUTTONS.WebPage ?? [];
  assert.equal(buttons.length, 4, "WebPage must have exactly four buttons");
  const kinds = buttons.map((b) => b.kind).sort();
  assert.deepEqual(kinds, [
    "viewCitingArtifactForWebPage",
    "viewCitingClaimForWebPage",
    "viewExtractedEvidenceForWebPage",
    "viewSearchingTaskForWebPage",
  ]);
  // Each button's i18n key is the chain.* convention; no two buttons share a
  // key (the table keys off `key` in the frontend's button render).
  const keys = new Set(buttons.map((b) => b.key));
  assert.equal(keys.size, buttons.length, "WebPage buttons have unique i18n keys");
});
