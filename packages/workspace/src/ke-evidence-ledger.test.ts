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

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEvidenceLedgerPort, ledgerPath } from "./ke-evidence-ledger.js";

test("evidence ledger: add, query, verify, and conflict detection round-trip", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ke-ledger-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  let tick = 0;
  const port = createEvidenceLedgerPort(() => new Date(2026, 0, 1 + tick++));

  const first = await port.add({ workspaceRoot: root, claim: "SP-D localizes on the viral glycoprotein", anchorId: "doc1:paragraph:0", docId: "doc1", quote: "localizes on the virus spike glycoprotein", kbId: "kb1" });
  assert.equal(first.entry.id, "e1");
  const second = await port.add({ workspaceRoot: root, claim: "SP-D does not localize on the viral glycoprotein", anchorId: "doc2:paragraph:0", docId: "doc2", quote: "no detectable localization", kbId: "kb1" });
  assert.equal(second.entry.id, "e2");
  assert.equal(second.total, 2);

  // The file is plain JSON a human can audit.
  const raw = JSON.parse(await readFile(ledgerPath(root), "utf8")) as { entries: unknown[] };
  assert.equal(raw.entries.length, 2);

  const queried = await port.query({ workspaceRoot: root, claim: "localiz" });
  assert.equal(queried.entries.length, 2);
  const none = await port.query({ workspaceRoot: root, claim: "zebra" });
  assert.equal(none.entries.length, 0);

  // verify: quote checked through the port, verdict persisted as not-found mapping.
  const verified = await port.verify({
    workspaceRoot: root,
    kbId: "kb1",
    verifyCitation: async (_kbId, quote) => ({ state: quote.startsWith("localizes") ? "verbatim" : "none" }),
  });
  assert.equal(verified.checked, 2);
  assert.deepEqual(verified.results, [
    { id: "e1", state: "verbatim" },
    { id: "e2", state: "not-found" },
  ]);
  const afterVerify = await port.query({ workspaceRoot: root });
  assert.equal(afterVerify.entries[0]!.verdict?.state, "verbatim");
  assert.equal(afterVerify.entries[1]!.verdict?.state, "not-found");

  // Conflicts: same claim from different docs AND a negation flip.
  const { conflicts } = await port.conflicts({ workspaceRoot: root });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.reason, "same-claim-different-source");
});

test("evidence ledger: negation flips and corrupt files never crash the turn", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ke-ledger-2-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const port = createEvidenceLedgerPort();

  // Corrupt file → empty ledger, not an exception.
  await import("node:fs/promises").then((fs) => fs.mkdir(join(root, ".ke"), { recursive: true }));
  await writeFile(ledgerPath(root), "{not json", "utf8");
  const empty = await port.query({ workspaceRoot: root });
  assert.deepEqual(empty.entries, []);

  // Same single source, negation flip → conflict with reason negation-flip.
  await port.add({ workspaceRoot: root, claim: "the vaccine protects mice", anchorId: "doc1:paragraph:0", docId: "doc1", kbId: "kb1" });
  await port.add({ workspaceRoot: root, claim: "the vaccine does not protect mice", anchorId: "doc1:paragraph:1", docId: "doc1", kbId: "kb1" });
  const { conflicts } = await port.conflicts({ workspaceRoot: root });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.reason, "negation-flip");

  // verify skips entries without quotes or from other KBs.
  const verified = await port.verify({ workspaceRoot: root, kbId: "kb1", verifyCitation: async () => ({ state: "verbatim" }) });
  assert.equal(verified.checked, 0);
  assert.equal(verified.skipped, 2);
});
