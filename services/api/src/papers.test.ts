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

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import type { ArtifactCandidate } from "@sciencediscovery/schema";

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
    service: new PaperService(
      store,
      resolve(paperRoot, ".venv/bin/python"),
      resolve(paperRoot, "paper_worker.py"),
    ),
    session,
    store,
  };
}

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
