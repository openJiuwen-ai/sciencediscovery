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

// The Claim node's chain buttons.
//
// A Claim is cited over ONE edge type (`supports`) in ONE direction (in) by
// FOUR labels — Evidence, Artifact, SourceFile and DbRecord (see the writers in
// the sidecar's persistence.py). That is why the Claim's three citing buttons
// are separate kinds, each strictly label-filtered in `_BUTTON_CHAIN_HOPS`: a
// single unfiltered "查看引用的证据" button reached all four and kept whichever
// node the walk collected first, so a Claim backed by both a DbRecord and an
// Evidence offered no route to the record at all.
//
// Two invariants below are asserted across the WHOLE table rather than per
// label, because that is how the failure surfaces: `chain_exists` is a batch
// call, one unknown kind 400s the batch, and the BFF's catch turns every kind
// in it false — hiding all of that node's buttons. A kind reused across labels
// (`_BUTTON_CHAIN_HOPS` is keyed by kind alone) or one i18n key standing for two
// different traversals are both silent-until-visible versions of that.
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import type { MemoryGraphNodeLabel } from "@sciencediscovery/schema";

import { CHAIN_BUTTONS, NODE_LABELS } from "../src/MemoryGraphExplorer.js";
import { en, zhCN } from "../src/i18n/messages.js";

test("CHAIN_BUTTONS.Claim separates the citing labels and keeps the report hop", () => {
  const buttons = CHAIN_BUTTONS.Claim ?? [];
  assert.deepEqual(buttons.map((button) => button.kind), [
    "viewCitingEvidenceForClaim",
    "viewCitingDbRecordForClaim",
    "viewCitingSourceFileForClaim",
    "viewContainingArtifact",
  ]);
  // Each button carries its OWN i18n key. Sharing one key across the two
  // citing buttons is what the old `chain.viewCitingEvidence` did (it was
  // shared with the Artifact section's button) — the label then has to lie
  // about one of the two traversals.
  const keys = new Set(buttons.map((button) => button.key));
  assert.equal(keys.size, buttons.length, "Claim buttons have unique i18n keys");
});

test("the new Claim button labels exist in both locales", () => {
  // `zhCN` is Partial<Record<MessageKey, string>>, so a missing key is not a
  // type error — it silently falls back to English at runtime.
  assert.equal(en["chain.viewCitingEvidenceForClaim"], "Citing evidence");
  assert.equal(en["chain.viewCitingDbRecordForClaim"], "Citing database records");
  assert.equal(en["chain.viewCitingSourceFileForClaim"], "Citing source files");
  assert.equal(zhCN["chain.viewCitingEvidenceForClaim"], "查看引用的证据");
  assert.equal(zhCN["chain.viewCitingDbRecordForClaim"], "查看引用的数据库记录");
  assert.equal(zhCN["chain.viewCitingSourceFileForClaim"], "查看引用的源文件");
  // The Artifact section keeps the old shared key — it still has its own
  // button and must not be renamed into the Claim's.
  assert.equal(en["chain.viewCitingEvidence"], "Citing evidence");
  assert.equal(zhCN["chain.viewCitingEvidence"], "查看引用的证据");
});

test("no chain kind is reused across two node labels", () => {
  // The sidecar's _BUTTON_CHAIN_HOPS is keyed by kind alone, so a kind reused
  // under a second label silently overwrites the first label's hop list — the
  // collision that split viewCitingEvidence into
  // viewCitingEvidenceForClaim / viewCitingEvidenceForArtifact.
  const labelsByKind = new Map<string, string[]>();
  for (const [label, buttons] of Object.entries(CHAIN_BUTTONS)) {
    for (const button of buttons ?? []) {
      const labels = labelsByKind.get(button.kind) ?? [];
      labels.push(label);
      labelsByKind.set(button.kind, labels);
    }
  }
  const reused = [...labelsByKind].filter(([, labels]) => labels.length > 1);
  assert.deepEqual(reused, [], `chain kinds reused across labels: ${JSON.stringify(reused)}`);
});

test("no i18n key stands for two different chain kinds", () => {
  // A shared key means one visible label fronts two different traversals, so
  // the text is wrong for at least one of them, and the button that actually
  // appears depends on which label the user selected.
  const kindsByKey = new Map<string, Set<string>>();
  for (const buttons of Object.values(CHAIN_BUTTONS)) {
    for (const button of buttons ?? []) {
      const kinds = kindsByKey.get(button.key) ?? new Set<string>();
      kinds.add(button.kind);
      kindsByKey.set(button.key, kinds);
    }
  }
  const ambiguous = [...kindsByKey]
    .filter(([, kinds]) => kinds.size > 1)
    .map(([key, kinds]) => [key, [...kinds]]);
  assert.deepEqual(ambiguous, [], `i18n keys fronting >1 kind: ${JSON.stringify(ambiguous)}`);
});

test("every button label resolves in both locales", () => {
  for (const [label, buttons] of Object.entries(CHAIN_BUTTONS)) {
    for (const button of buttons ?? []) {
      assert.ok(en[button.key], `${label} button ${button.kind} has no English label`);
      assert.ok(zhCN[button.key], `${label} button ${button.kind} has no Chinese label`);
    }
  }
});

test("every CHAIN_BUTTONS key is a real node label", () => {
  // Typo guard: a misspelled key would make the whole section dead code (the
  // lookup at the render site is `CHAIN_BUTTONS[selected.label] ?? []`), with
  // no error anywhere. The map is Partial, so absence is legitimate —
  // SourceFile has no buttons *as a source label*; a SourceFile that backs a
  // Claim is reached from the Claim's own "viewCitingSourceFileForClaim".
  for (const label of Object.keys(CHAIN_BUTTONS)) {
    assert.ok(NODE_LABELS.includes(label as MemoryGraphNodeLabel),
      `${label} is not a NODE_LABELS member`);
  }
});
