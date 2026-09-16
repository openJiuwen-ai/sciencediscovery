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
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { ApiStatusError } from "../runs/index.js";

import { Readable } from "node:stream";

import type { KeOrchestrator } from "./orchestrator.js";
import {
  handleKeGetDocument,
  handleKeGetDocumentAnchor,
  handleKeGetEntity,
  handleKeListKbs,
  handleKeSearchPreview,
  handleKeSeed,
  handleKeUploadPdf,
  KeApiError,
  parseKeDocumentLevel,
} from "./routes.js";
import { KnowledgeEngineStore } from "./store.js";

function tempRoot(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

/** Minimal ServerResponse stand-in capturing status+body. */
function fakeResponse(): { status: number; body: string; response: import("node:http").ServerResponse } {
  const captured = { status: 0, body: "" };
  const response = {
    writeHead(status: number) {
      captured.status = status;
      return response;
    },
    end(body?: string) {
      captured.body = body ?? "";
    },
  } as unknown as import("node:http").ServerResponse;
  return { ...captured, response };
}

test("KeApiError is an ApiStatusError (top-level classifier maps it, never a bare 500)", () => {
  const error = new KeApiError("entity x not found", 404, "KE_ENTITY_NOT_FOUND");
  assert.ok(error instanceof ApiStatusError);
  assert.equal(error.statusCode, 404);
  assert.equal(error.code, "KE_ENTITY_NOT_FOUND");
});

test("handleKeGetEntity throws a classifiable 404 for a missing entity", async (context) => {
  const root = tempRoot("ke-routes-404");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());

  const { response } = fakeResponse();
  assert.throws(
    () => handleKeGetEntity(response, store, "nonexistent"),
    (error: unknown) => error instanceof ApiStatusError && error.statusCode === 404 && error.code === "KE_ENTITY_NOT_FOUND",
  );
});

test("handleKeListKbs returns kbs with SQL-computed stats", async (context) => {
  const root = tempRoot("ke-routes-list");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  store.upsertDocument({ kbId: kb.id, dedupKey: "doi:1", title: "A", status: "ready" });
  store.upsertEntity({ kbId: kb.id, name: "GP", type: "protein" });

  const captured = { status: 0, body: "" };
  const response = {
    writeHead(status: number) {
      captured.status = status;
      return response;
    },
    end(body?: string) {
      captured.body = body ?? "";
    },
  } as unknown as import("node:http").ServerResponse;

  handleKeListKbs(response, store);
  const payload = JSON.parse(captured.body) as { kbs: Array<{ stats: { documents: number; entities: number } }> };
  assert.equal(payload.kbs.length, 1);
  assert.equal(payload.kbs[0]?.stats.documents, 1);
  assert.equal(payload.kbs[0]?.stats.entities, 1);
});

const LEVELS_FULLTEXT = [
  "# Ebola GP neutralization",
  "",
  "## Abstract",
  "",
  "Antibodies neutralize Ebola virus.",
  "",
  "## Introduction",
  "",
  "Ebola glycoprotein mediates entry into host cells and is the sole target of neutralizing antibodies.",
  "",
  "$$",
  "K_d = 4.2\\,\\mathrm{nM}",
  "$$",
  "",
].join("\n");

function seededDocumentStore(context: import("node:test").TestContext): { store: KnowledgeEngineStore; kbId: string; otherKbId: string; docId: string } {
  const root = tempRoot("ke-routes-docs");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  const otherKb = store.createKnowledgeBase({ name: "Protein" });
  const doc = store.upsertDocument({
    kbId: kb.id,
    dedupKey: "arxiv:2010.09898",
    title: "Ebola GP neutralization",
    abstract: "Antibodies neutralize Ebola virus.",
    fulltext: LEVELS_FULLTEXT,
    status: "ready",
  });
  return { store, kbId: kb.id, otherKbId: otherKb.id, docId: doc.id };
}

test("handleKeGetDocument serves L0 (deterministic abstract + heading tags)", async (context) => {
  const { store, kbId, docId } = seededDocumentStore(context);
  const captured = { status: 0, body: "" };
  const response = {
    writeHead(code: number) {
      captured.status = code;
      return response;
    },
    end(payload?: string) {
      captured.body = payload ?? "";
    },
  } as unknown as import("node:http").ServerResponse;

  handleKeGetDocument(response, store, kbId, docId, "L0");
  const payload = JSON.parse(captured.body) as {
    level: string;
    l0: { summary: string; tags: string[]; source: string };
  };
  assert.equal(captured.status, 200);
  assert.equal(payload.level, "L0");
  assert.equal(payload.l0.source, "abstract");
  assert.equal(payload.l0.summary, "Antibodies neutralize Ebola virus.");
  assert.deepEqual(payload.l0.tags, ["Ebola GP neutralization", "Introduction"]);
});

test("handleKeGetDocument serves L1 anchored blocks and L2 fulltext", async (context) => {
  const { store, kbId, docId } = seededDocumentStore(context);
  const captured = { status: 0, body: "" };
  const response = {
    writeHead(code: number) {
      captured.status = code;
      return response;
    },
    end(payload?: string) {
      captured.body = payload ?? "";
    },
  } as unknown as import("node:http").ServerResponse;

  handleKeGetDocument(response, store, kbId, docId, "L1");
  const l1 = JSON.parse(captured.body) as { level: string; blockCount: number; blocks: Array<{ anchorId: string; type: string; text: string; section: string | null; lineStart: number }> };
  assert.equal(l1.level, "L1");
  const paragraph = l1.blocks.find((block) => block.type === "paragraph" && block.section === "Introduction");
  assert.ok(paragraph, "L1 has a paragraph block");
  assert.equal(paragraph!.anchorId, `${docId}:paragraph:1`);
  assert.ok(paragraph!.text.includes("glycoprotein"));
  const formula = l1.blocks.find((block) => block.type === "formula");
  assert.ok(formula, "L1 keeps display formulas as blocks");
  assert.ok(l1.blocks.some((block) => block.type === "heading"));

  handleKeGetDocument(response, store, kbId, docId, "L2");
  const l2 = JSON.parse(captured.body) as { level: string; fulltext: string };
  assert.equal(l2.level, "L2");
  assert.equal(l2.fulltext, LEVELS_FULLTEXT);
});

test("handleKeGetDocument 404s cross-KB document ids and unknown docs", async (context) => {
  const { store, kbId, otherKbId, docId } = seededDocumentStore(context);
  const { response } = fakeResponse();
  assert.throws(
    () => handleKeGetDocument(response, store, otherKbId, docId, "L0"),
    (error: unknown) => error instanceof KeApiError && error.statusCode === 404 && error.code === "KE_DOCUMENT_NOT_FOUND",
  );
  assert.throws(
    () => handleKeGetDocument(response, store, kbId, "nonexistent", "L0"),
    (error: unknown) => error instanceof KeApiError && error.statusCode === 404,
  );
});

test("handleKeGetDocumentAnchor resolves anchors with context and 404s unknown ones", async (context) => {
  const { store, kbId, docId } = seededDocumentStore(context);
  const captured = { status: 0, body: "" };
  const response = {
    writeHead(code: number) {
      captured.status = code;
      return response;
    },
    end(payload?: string) {
      captured.body = payload ?? "";
    },
  } as unknown as import("node:http").ServerResponse;

  handleKeGetDocumentAnchor(response, store, kbId, docId, `${docId}:paragraph:1`);
  const payload = JSON.parse(captured.body) as {
    anchor: { anchorId: string; text: string };
    context: { before: { type: string } | null; after: { type: string } | null };
  };
  assert.equal(captured.status, 200);
  assert.ok(payload.anchor.text.includes("glycoprotein"));
  assert.equal(payload.context.before?.type, "heading");

  const { response: throwing } = fakeResponse();
  assert.throws(
    () => handleKeGetDocumentAnchor(throwing, store, kbId, docId, `${docId}:paragraph:999`),
    (error: unknown) => error instanceof KeApiError && error.statusCode === 404 && error.code === "KE_ANCHOR_NOT_FOUND",
  );
});

test("handleKeGetDocumentAnchor 409s when the document has no parsed fulltext", async (context) => {
  const root = tempRoot("ke-routes-anchor-409");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "Empty" });
  const doc = store.upsertDocument({ kbId: kb.id, dedupKey: "doi:pending", title: "P", status: "pending" });

  const { response } = fakeResponse();
  assert.throws(
    () => handleKeGetDocumentAnchor(response, store, kb.id, doc.id, `${doc.id}:paragraph:0`),
    (error: unknown) => error instanceof KeApiError && error.statusCode === 409 && error.code === "KE_DOCUMENT_NOT_PARSED",
  );
});

test("parseKeDocumentLevel defaults to L0 and rejects anything else", () => {
  assert.equal(parseKeDocumentLevel(null), "L0");
  assert.equal(parseKeDocumentLevel(""), "L0");
  assert.equal(parseKeDocumentLevel("L1"), "L1");
  assert.equal(parseKeDocumentLevel("L2"), "L2");
  assert.throws(
    () => parseKeDocumentLevel("l1"),
    (error: unknown) => error instanceof KeApiError && error.statusCode === 400 && error.code === "KE_INVALID_INPUT",
  );
  assert.throws(() => parseKeDocumentLevel("raw"), /KeApiError/);
});

// ------------------------------------------------- seed refs / preview / upload

function fakeJsonRequest(body: unknown): import("node:http").IncomingMessage {
  return Readable.from([JSON.stringify(body)]) as unknown as import("node:http").IncomingMessage;
}

function fakePdfRequest(bytes: Uint8Array, contentType = "application/pdf"): import("node:http").IncomingMessage {
  const request = Readable.from([Buffer.from(bytes)]) as unknown as import("node:http").IncomingMessage;
  request.headers = { "content-type": contentType };
  return request;
}

function capturingResponse(): { captured: { status: number; body: string }; response: import("node:http").ServerResponse } {
  const captured = { status: 0, body: "" };
  const response = {
    writeHead(status: number) {
      captured.status = status;
      return response;
    },
    end(body?: string) {
      captured.body = body ?? "";
    },
  } as unknown as import("node:http").ServerResponse;
  return { captured, response };
}

test("handleKeSeed paperRefs mode validates and forwards the picked list", async (context) => {
  const root = tempRoot("ke-routes-seedrefs");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "Ebola" });

  const forwarded: unknown[] = [];
  const orchestrator = {
    seedPaperRefs: async (_kbId: string, refs: unknown[]) => {
      forwarded.push(refs);
      return { enqueued: refs.length };
    },
  } as unknown as KeOrchestrator;

  // 400s: empty array, missing title, over the cap.
  await assert.rejects(
    () => handleKeSeed(fakeJsonRequest({ paperRefs: [] }), capturingResponse().response, orchestrator, store, kb.id),
    (error: unknown) => error instanceof KeApiError && error.statusCode === 400,
  );
  await assert.rejects(
    () => handleKeSeed(fakeJsonRequest({ paperRefs: [{ doi: "10.1/x" }] }), capturingResponse().response, orchestrator, store, kb.id),
    (error: unknown) => error instanceof KeApiError && error.statusCode === 400,
  );
  await assert.rejects(
    () => handleKeSeed(
      fakeJsonRequest({ paperRefs: Array.from({ length: 51 }, (_v, i) => ({ title: `T${i}` })) }),
      capturingResponse().response,
      orchestrator,
      store,
      kb.id,
    ),
    (error: unknown) => error instanceof KeApiError && error.statusCode === 400,
  );

  // Happy path: sanitized refs forwarded, 202 with the enqueued count.
  const ok = capturingResponse();
  await handleKeSeed(
    fakeJsonRequest({ paperRefs: [{ title: "  Ebola GP  ", doi: "10.1/mab114", year: 2024.9, extra: "dropped" }] }),
    ok.response,
    orchestrator,
    store,
    kb.id,
  );
  assert.equal(ok.captured.status, 202);
  const refs = forwarded[0] as Array<Record<string, unknown>>;
  assert.equal(refs[0]?.["title"], "Ebola GP");
  assert.equal(refs[0]?.["year"], 2024);
  assert.equal(refs[0]?.["extra"], undefined);
  assert.deepEqual(JSON.parse(ok.captured.body), { enqueued: 1 });
});

test("handleKeSearchPreview validates the query and returns papers", async (context) => {
  const root = tempRoot("ke-routes-preview");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  const orchestrator = {
    searchPapersPreview: async (query: string, _limit: number) => [{ title: `Hit for ${query}` }],
  } as unknown as KeOrchestrator;

  await assert.rejects(
    () => handleKeSearchPreview(fakeJsonRequest({ query: "  " }), capturingResponse().response, orchestrator, store, kb.id),
    (error: unknown) => error instanceof KeApiError && error.statusCode === 400,
  );
  const ok = capturingResponse();
  await handleKeSearchPreview(fakeJsonRequest({ query: "ebola" }), ok.response, orchestrator, store, kb.id);
  assert.equal(ok.captured.status, 200);
  assert.deepEqual(JSON.parse(ok.captured.body), { papers: [{ title: "Hit for ebola" }] });
});

test("handleKeUploadPdf enforces application/pdf and forwards bytes", async (context) => {
  const root = tempRoot("ke-routes-upload");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  const received: number[] = [];
  const orchestrator = {
    ingestUploadedPdf: async (_kbId: string, bytes: Uint8Array, _title?: string) => {
      received.push(bytes.length);
      return { alreadyComplete: false, dedupKey: "upload:abc", documentId: "doc1" };
    },
  } as unknown as KeOrchestrator;

  // 415 on the wrong content type.
  await assert.rejects(
    () => handleKeUploadPdf(fakePdfRequest(new Uint8Array([1, 2, 3]), "text/plain"), capturingResponse().response, orchestrator, store, kb.id),
    (error: unknown) => error instanceof KeApiError && error.statusCode === 415,
  );
  const ok = capturingResponse();
  await handleKeUploadPdf(fakePdfRequest(new Uint8Array(100)), ok.response, orchestrator, store, kb.id);
  assert.equal(ok.captured.status, 201);
  assert.deepEqual(received, [100]);
  assert.deepEqual(JSON.parse(ok.captured.body), { alreadyComplete: false, dedupKey: "upload:abc", documentId: "doc1" });
});
