// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";


import { CasStore } from "@sciencediscovery/cas";
import type { PaperAcquisition } from "@sciencediscovery/schema";

import { ReviewerPaperEvidenceGateway } from "./paper-evidence-gateway.js";

test("Reviewer Paper evidence gateway reads only matching Session CAS-pinned full text and tables", async () => {
  const root = await mkdtemp(join(tmpdir(), "reviewer-paper-evidence-"));
  try {
    const cas = new CasStore(root, "data");
    const fulltext = await cas.put("Methods: patients were enrolled prospectively.");
    const table = await cas.put("group,n,response\nA,10,42%\n");
    const acquisition: PaperAcquisition = {
      connectorId: "pubmed",
      createdAt: "2026-09-09T00:00:00.000Z",
      extraction: {
        generatedAt: "2026-09-09T00:00:00.000Z", images: [], inputSha256: "a".repeat(64), limits: {}, pageCount: 1,
        pages: [], parser: "test", pdfBytes: 1, schemaVersion: 1,
        tables: [{ bbox: [], columns: 3, csvPath: "table-1.csv", page: 4, rows: 2 }],
        textCharacters: 48, textPath: "fulltext.md", warnings: [],
      },
      id: "paper-1", identifier: "pmid:12345678", license: "test", manifest: { hash: "b".repeat(64), size: 1 },
      manifestPath: "papers/paper-1/analysis/manifest.json", pdf: { hash: "c".repeat(64), size: 1 }, pdfPath: "papers/paper-1/source.pdf",
      sessionId: "session-1", sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/12345678/", status: "succeeded", title: "Example",
    };
    const revisions = new Map([
      ["papers/paper-1/analysis/fulltext.md", { contentHash: fulltext.hash, originMeta: { paperId: "paper-1" } }],
      ["papers/paper-1/analysis/table-1.csv", { contentHash: table.hash, originMeta: { paperId: "paper-1" } }],
    ]);
    const gateway = new ReviewerPaperEvidenceGateway({
      dataDir: root,
      getWorkspaceFileProvenance: (_sessionId: string, path: string) => {
        const currentRevision = revisions.get(path);
        return currentRevision ? { currentRevision } : undefined;
      },
      listPaperAcquisitions: async (sessionId: string) => sessionId === "session-1" ? [acquisition] : [],
    } as never);

    const materials = await gateway.resolveCitation("session-1", {
      key: "pmid:12345678", label: "PMID: 12345678", reference: "PMID: 12345678",
    });
    assert.deepEqual(materials.map((item) => item.evidenceLevel), ["E2", "E3", "E3", "E3"]);
    assert.equal(materials[0]?.content, "Methods: patients were enrolled prospectively.");
    assert.deepEqual(materials[3]?.locator, { column: "response", page: 4, row: "2", table: "table-1" });
    assert.deepEqual(await gateway.resolveCitation("other-session", { key: "pmid:12345678", label: "PMID", reference: "PMID" }), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Reviewer Paper evidence gateway rejects a replaced mutable workspace revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "reviewer-paper-evidence-"));
  try {
    const acquisition = {
      id: "paper-1", identifier: "pmid:12345678", manifestPath: "papers/paper-1/analysis/manifest.json",
      extraction: { textPath: "fulltext.md", tables: [] }, sessionId: "session-1",
    } as unknown as PaperAcquisition;
    const gateway = new ReviewerPaperEvidenceGateway({
      dataDir: root,
      getWorkspaceFileProvenance: () => ({ currentRevision: { contentHash: "a".repeat(64), originMeta: { paperId: "different-paper" } } }),
      listPaperAcquisitions: async () => [acquisition],
    } as never);
    assert.deepEqual(await gateway.resolveCitation("session-1", { key: "pmid:12345678", label: "PMID", reference: "PMID" }), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
