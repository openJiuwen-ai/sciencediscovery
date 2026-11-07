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

import type { WorkspaceFileProvenance } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { formatBytes as formatCsvBytes } from "../src/csv-artifact/csv/inferCsv.js";
import { WorkspaceFileProvenanceModal } from "../src/WorkspaceFileProvenanceModal.js";

const timestamp = "2026-08-01T10:00:00.000Z";

function provenanceHtml(size: number): string {
  const revision = {
    artifactVersionIds: [],
    contentHash: "a".repeat(64),
    createdAt: timestamp,
    fileId: "file-1",
    id: "revision-1",
    modifiedAt: timestamp,
    origin: "tool" as const,
    path: "results/report.md",
    projectId: "project-1",
    runId: "run-1",
    sessionId: "session-1",
    size,
    toolName: "run_python" as const,
  };
  const provenance = {
    artifacts: [],
    currentRevision: revision,
    lineage: [],
    revisions: [revision],
    file: {
      createdAt: timestamp,
      currentRevisionId: revision.id,
      id: revision.fileId,
      path: revision.path,
      projectId: revision.projectId,
      sessionId: revision.sessionId,
      sessionTitle: "Session",
      updatedAt: timestamp,
    },
    sourceSession: { deleted: false, id: "session-1", title: "Session" },
  } as unknown as WorkspaceFileProvenance;
  return renderToStaticMarkup(createElement(WorkspaceFileProvenanceModal, {
    file: { modifiedAt: timestamp, path: revision.path, size },
    onClose: () => {},
    provenance,
  }));
}

test("a provenance size one byte under 1 MiB never prints 1024.0 KiB", () => {
  // The printed size is the rounded one, so the unit has to be picked from that
  // same rounded value: 1_048_575 bytes is 1023.999 KiB unrounded, and reading
  // "1024.0 KiB" names a number no KiB value can hold.
  const html = provenanceHtml(1_048_575);
  assert.ok(!html.includes("1024.0 KiB"), `1024.0 KiB must not be printed: ${html}`);
  assert.match(html, /1\.0(?:0)? MiB/);
});

test("a provenance size one byte under 1 GiB never prints 1024.0 MiB", () => {
  const html = provenanceHtml(1_073_741_823);
  assert.ok(!html.includes("1024.0 MiB"), `1024.0 MiB must not be printed: ${html}`);
  assert.match(html, /1\.0(?:0)? GiB/);
});

test("a provenance size keeps the readings it already had", () => {
  // Neighbours of the boundary and the existing decimal policy: bytes stay
  // bytes, an exact MiB stays 1.00 MiB, and a fractional KiB keeps two decimals.
  assert.match(provenanceHtml(1_023), /1023 B/);
  assert.match(provenanceHtml(1_048_576), /1\.00 MiB/);
  assert.match(provenanceHtml(1_536), /1\.50 KiB/);
  assert.match(provenanceHtml(5_767_168), /5\.50 MiB/);
});

test("the CSV inspector size crosses the unit boundary it prints", () => {
  assert.equal(formatCsvBytes(1_048_575), "1.0 MiB");
  assert.equal(formatCsvBytes(1_073_741_823), "1.0 GiB");
  assert.equal(formatCsvBytes(3 * 1024 ** 3), "3.0 GiB");
  assert.equal(formatCsvBytes(1_099_511_627_775), "1.0 TiB");
});

test("the CSV inspector keeps the readings it already had", () => {
  assert.equal(formatCsvBytes(1_023), "1023 B");
  assert.equal(formatCsvBytes(1_048_576), "1.0 MiB");
  assert.equal(formatCsvBytes(1_536), "1.5 KiB");
  assert.equal(formatCsvBytes(5_767_168), "5.5 MiB");
});
