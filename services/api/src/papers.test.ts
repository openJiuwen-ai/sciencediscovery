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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { TestContext } from "node:test";

import { promisify } from "node:util";

import type { ArtifactCandidate } from "@sciencediscovery/schema";
import { CasStore } from "@sciencediscovery/cas";

import { PaperService } from "./papers.js";
import { SessionStore } from "./store.js";

const execFileAsync = promisify(execFile);
const paperRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../paper");

async function fixture(context: TestContext) {
  const dataDir = resolve(process.cwd(), ".tmp", `paper-extraction-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const model = await store.createModel({
    apiToken: "test",
    baseUrl: "https://model.example/v1",
    model: "test",
    name: "Test",
    vision: false,
  });
  const project = await store.createProject("Extraction");
  const session = await store.createSession(project.id, "Extraction", model.id);
  return {
    candidate: {
      attribution: "NCBI",
      format: "pdf",
      id: "paper-candidate",
      kind: "paper",
      license: "open access",
      logicalName: "paper.pdf",
      mimeType: "application/pdf",
      sourceId: "pubmed",
      sourceRecordId: "123",
      sourceUrl: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/pdf/paper.pdf",
    } satisfies ArtifactCandidate,
    dataDir,
    model,
    service: new PaperService(
      store,
      resolve(paperRoot, ".venv/bin/python"),
      resolve(paperRoot, "paper_worker.py"),
    ),
    session,
    store,
  };
}

test("paper vision persists Chat usage and leaves incomplete usage unknown", async (context) => {
  const { dataDir, model, session, store } = await fixture(context);
  await store.updateModel(model.id, { baseUrl: model.baseUrl, model: model.model, name: model.name, vision: true });
  const ref = await new CasStore(dataDir).put(Buffer.from("paper"));
  await store.appendPaperAcquisition({
    id: "paper-usage", sessionId: session.id, connectorId: "upload", identifier: "paper", license: "test",
    createdAt: new Date().toISOString(), manifest: ref, manifestPath: "papers/paper-usage/manifest.json",
    pdf: ref, pdfPath: "papers/paper-usage/paper.pdf", status: "succeeded", title: "Paper",
    extraction: {
      generatedAt: new Date().toISOString(), images: [], inputSha256: ref.hash, limits: {}, pageCount: 1,
      pages: [{ needsVision: true, page: 1, previewPath: "page.png", textCharacters: 0 }],
      parser: "fixture", pdfBytes: 5, schemaVersion: 1, tables: [], textCharacters: 0, textPath: "text.txt", warnings: [],
    },
  });
  const root = resolve(store.workspacePath(session.id), "papers/paper-usage");
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, "page.png"), Buffer.from("image"));
  const samples = [
    { prompt_tokens: 30393, completion_tokens: 84, input_tokens: 0, output_tokens: 0, total_tokens: 30477 },
    { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    { prompt_tokens: 10 },
  ];
  const service = new PaperService(store, "unused", "unused", async (url) => {
    assert.match(String(url), /\/chat\/completions$/);
    return new Response(JSON.stringify({ choices: [{ message: { content: "A scientific figure." } }], usage: samples.shift() }));
  });
  for (let i = 0; i < 3; i++) await service.analyzeVision({ modelId: model.id, paperId: "paper-usage", sessionId: session.id });
  const runs = await store.listPaperVisionRuns(session.id);
  assert.deepEqual(runs.map((run) => run.modelUsage), [
    { inputTokens: 30393, outputTokens: 84, totalTokens: 30477 },
    { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
    undefined,
  ]);
});

test("explicit PDF extraction persists lifecycle and is idempotent after completion", async (context) => {
  const { candidate, service, session, store } = await fixture(context);
  const relativePath = "downloads/paper.pdf";
  const target = resolve(store.workspacePath(session.id), relativePath);
  await mkdir(resolve(target, ".."), { recursive: true });
  await execFileAsync(resolve(paperRoot, ".venv/bin/python"), ["-c", [
    "from reportlab.pdfgen import canvas",
    "import sys",
    "pdf=canvas.Canvas(sys.argv[1])",
    "pdf.drawString(72,720,'Governed explicit extraction')",
    "pdf.save()",
  ].join("\n"), target]);

  const first = await service.extractArtifact({
    artifactJobId: "download-job-1",
    candidate,
    path: relativePath,
    sessionId: session.id,
  });
  assert.equal(first.job.state, "completed");
  assert.equal(first.job.paperAcquisitionId, first.acquisition.id);
  assert.ok(first.job.manifestPath);
  assert.ok(first.job.textPath);

  const second = await service.extractArtifact({
    artifactJobId: "download-job-1",
    candidate,
    path: relativePath,
    sessionId: session.id,
  });
  assert.equal(second.job.id, first.job.id);
  assert.equal((await store.listArtifactExtractionJobs(session.id)).length, 1);

  const child = await store.createSubagent(session.id, "parent-request", { description: "Child extraction", prompt: "Read delivered paper" });
  const prefix = `subagents/${child.id}`;
  await store.updateSubagent({ ...child, handoff: { workspaceId: store.workspaceIdentity(session.id, `subagent:${child.id}`).id,
    inputPaths: [], privateWorkspacePath: prefix, manifestPath: `${prefix}/handoff.json` } });
  const childRoot = store.agentWorkspacePath(session.id, child.id);
  await mkdir(resolve(childRoot, "downloads"), { recursive: true });
  await writeFile(resolve(childRoot, relativePath), await readFile(target));
  const extracted = await service.extractArtifact({ artifactJobId: "child-download", candidate,
    path: `${prefix}/${relativePath}`, outputPathPrefix: prefix, sessionId: session.id });
  assert.equal(extracted.job.state, "completed");
  const location = store.workspaceLocation(session.id, extracted.acquisition.manifestPath);
  assert.equal(location.root, childRoot);
  assert.ok(await readFile(resolve(location.root, location.path), "utf8"));
  await assert.rejects(readFile(resolve(store.workspacePath(session.id), extracted.acquisition.manifestPath)), { code: "ENOENT" });
});

test("failed PDF extraction persists a terminal failed task", async (context) => {
  const { candidate, service, session, store } = await fixture(context);
  const relativePath = "downloads/not-a-pdf.pdf";
  const target = resolve(store.workspacePath(session.id), relativePath);
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, "not a pdf", "utf8");

  await assert.rejects(service.extractArtifact({
    artifactJobId: "download-job-invalid",
    candidate,
    path: relativePath,
    sessionId: session.id,
  }), /PDF signature/);
  const jobs = await store.listArtifactExtractionJobs(session.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.state, "failed");
  assert.equal(jobs[0]?.error?.code, "NORMALIZATION_FAILED");
});

test("a PDF the user uploaded to the workspace is extracted by its path, once", async (context) => {
  const { service, session, store } = await fixture(context);
  const target = resolve(store.workspacePath(session.id), "enzyme_paper.pdf");
  await execFileAsync(resolve(paperRoot, ".venv/bin/python"), ["-c", [
    "from reportlab.pdfgen import canvas",
    "import sys",
    "pdf=canvas.Canvas(sys.argv[1])",
    "pdf.drawString(72,720,'Uploaded enzyme half-life at 70 C')",
    "pdf.save()",
  ].join("\n"), target]);

  const first = await service.extractWorkspacePdf({ path: "enzyme_paper.pdf", sessionId: session.id });
  assert.equal(first.connectorId, "upload");
  assert.equal(first.title, "enzyme_paper");
  const textPath = `${first.manifestPath.replace(/manifest\.json$/, "")}${first.extraction.textPath}`;
  assert.match(await readFile(resolve(store.workspacePath(session.id), textPath), "utf8"), /enzyme half-life/);

  const again = await service.extractWorkspacePdf({ path: "enzyme_paper.pdf", sessionId: session.id });
  assert.equal(again.id, first.id);
  assert.equal((await store.listPaperAcquisitions(session.id)).length, 1);

  await writeFile(resolve(store.workspacePath(session.id), "notes.pdf"), "not a pdf", "utf8");
  await assert.rejects(service.extractWorkspacePdf({ path: "notes.pdf", sessionId: session.id }), /PDF signature/);
});
