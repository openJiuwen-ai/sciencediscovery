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

import type { ChatMessage, WorkspaceFile } from "../src/api/types.js";
import { placeUploads, splitFileName, uploadKindOf } from "../src/views/uploads.js";

/** A workspace file, uploaded at `at` unless a test says the agent wrote it. */
function file(name: string, at: string, origin: "agent" | "upload" = "upload"): WorkspaceFile {
  return {
    modifiedAt: at,
    path: name,
    provenance: { fileId: name, origin, recordedAt: at, revisionId: `${name}@${at}` },
    size: 8,
  };
}

function said(id: string, role: ChatMessage["role"], at: string): ChatMessage {
  return { content: id, createdAt: at, id, role };
}

test("a file is sorted into the family its extension names", () => {
  assert.equal(uploadKindOf("report.pdf"), "pdf");
  assert.equal(uploadKindOf("table.XLSX"), "sheet");
  assert.equal(uploadKindOf("rows.csv"), "sheet");
  assert.equal(uploadKindOf("paper.docx"), "document");
  assert.equal(uploadKindOf("slides.pptx"), "slides");
  assert.equal(uploadKindOf("bundle.tar.gz"), "archive");
  assert.equal(uploadKindOf("figure.png"), "image");
  assert.equal(uploadKindOf("clip.mp4"), "video");
  assert.equal(uploadKindOf("voice.m4a"), "audio");
  assert.equal(uploadKindOf("result.json"), "data");
  assert.equal(uploadKindOf("analysis.py"), "code");
  assert.equal(uploadKindOf("notes.md"), "text");
  // A name with no extension has no family, and neither does a dotfile: the
  // dot is part of the name, not a separator.
  assert.equal(uploadKindOf("README"), "unknown");
  assert.equal(uploadKindOf(".gitignore"), "unknown");
});

test("the card's two lines are the stem and the extension, not the whole name", () => {
  assert.deepEqual(splitFileName("行业分析报告.pdf"), { extension: "pdf", stem: "行业分析报告" });
  assert.deepEqual(splitFileName("archive.tar.GZ"), { extension: "gz", stem: "archive.tar" });
  // Nothing to put on the second line, so the whole name stays on the first.
  assert.deepEqual(splitFileName(".gitignore"), { extension: "", stem: ".gitignore" });
});

test("an upload belongs to the first question asked after it", () => {
  const messages = [
    said("q1", "user", "2026-01-01T00:10:00.000Z"),
    said("a1", "assistant", "2026-01-01T00:11:00.000Z"),
    said("q2", "user", "2026-01-01T00:20:00.000Z"),
  ];
  const { byMessage, trailing } = placeUploads([
    file("first.pdf", "2026-01-01T00:01:00.000Z"),
    file("second.xlsx", "2026-01-01T00:15:00.000Z"),
  ], messages);
  // A file dropped before the first question belongs to that question, not to
  // the session: it was uploaded to ask with.
  assert.deepEqual(byMessage.get("q1")?.map((entry) => entry.name), ["first.pdf"]);
  // The assistant's turn is not a turn to attach to; the next reader's turn is.
  assert.deepEqual(byMessage.get("q2")?.map((entry) => entry.name), ["second.xlsx"]);
  assert.deepEqual(trailing, []);
});

test("an upload after the last question has no bubble yet, so it trails", () => {
  const { byMessage, trailing } = placeUploads(
    [file("waiting.pdf", "2026-01-01T00:30:00.000Z")],
    [said("q1", "user", "2026-01-01T00:10:00.000Z")],
  );
  assert.equal(byMessage.size, 0);
  assert.deepEqual(trailing.map((entry) => entry.name), ["waiting.pdf"]);
});

test("the workspace lists agent output too, and only uploads are drawn", () => {
  const { byMessage, trailing } = placeUploads([
    file("report.md", "2026-01-01T00:01:00.000Z", "agent"),
    // The same name after the agent rewrote it: it no longer says upload, so
    // the card for what the reader sent is gone with it.
    file("edited.csv", "2026-01-01T00:02:00.000Z", "agent"),
  ], [said("q1", "user", "2026-01-01T00:10:00.000Z")]);
  assert.equal(byMessage.size, 0);
  assert.deepEqual(trailing, []);
});
