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
// Classic JSX runtime under tsx, so React has to be in scope here.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MAX_ATTACHMENTS,
  attachmentKind,
  attachmentType,
  failUpload,
  formatFileSize,
  mergeUpload,
  takeWithinLimit,
  type Attachment,
} from "../src/app/attachments.js";
import { AttachmentTray } from "../src/views/AttachmentTray.js";

function card(overrides: Partial<Attachment> & { id: string; name: string }): Attachment {
  return {
    file: new File(["x"], overrides.name),
    size: 5632,
    status: "uploading",
    ...overrides,
  };
}

function tray(attachments: Attachment[]): string {
  return renderToStaticMarkup(
    <AttachmentTray
      attachments={attachments}
      onClear={() => {}}
      onRemove={() => {}}
      onRetry={() => {}}
    />,
  );
}

test("a file is drawn by its extension, and by its MIME family only when it has none", () => {
  assert.equal(attachmentKind("report.pdf"), "pdf");
  assert.equal(attachmentKind("DATA.XLSX"), "excel");
  assert.equal(attachmentKind("archive.tar"), "archive");
  assert.equal(attachmentKind("diagram.png"), "image");
  // No extension: the browser's guess is the only thing left to go on.
  assert.equal(attachmentKind("screenshot", "image/png"), "image");
  assert.equal(attachmentKind("voice", "audio/wav"), "audio");
  assert.equal(attachmentKind("clip", "video/mp4"), "video");
  // An extension this app has no badge for is still a file, not an image just
  // because the route called it one.
  assert.equal(attachmentKind("model.bin"), "file");
  assert.equal(attachmentKind("model.bin", "application/octet-stream"), "file");
});

test("the type a card prints is the extension in capitals, and nothing without one", () => {
  assert.equal(attachmentType("report.PDF"), "PDF");
  assert.equal(attachmentType("archive.tar.gz"), "GZ");
  assert.equal(attachmentType("Makefile"), "");
  // A leading dot is a hidden file's name, not an extension.
  assert.equal(attachmentType(".bashrc"), "");
  assert.equal(attachmentType("trailing."), "");
});

test("a size reads the way the card prints it", () => {
  assert.equal(formatFileSize(0), "0KB");
  assert.equal(formatFileSize(-1), "0KB");
  assert.equal(formatFileSize(512), "512B");
  // One decimal below a hundred units, whole numbers above it.
  assert.equal(formatFileSize(5632), "5.5KB");
  assert.equal(formatFileSize(16896), "16.5KB");
  assert.equal(formatFileSize(262144), "256KB");
  assert.equal(formatFileSize(1024), "1KB");
  assert.equal(formatFileSize(5 * 1024 * 1024), "5MB");
});

test("a selection keeps its order and reports what did not fit", () => {
  assert.deepEqual(takeWithinLimit(["a", "b"], 3), { accepted: ["a", "b"], overflow: 0 });
  assert.deepEqual(takeWithinLimit(["a", "b", "c"], 2), { accepted: ["a", "b"], overflow: 1 });
  // A full tray takes nothing rather than throwing.
  assert.deepEqual(takeWithinLimit(["a"], 0), { accepted: [], overflow: 1 });
  assert.equal(MAX_ATTACHMENTS, 20);
});

test("the server's answer lands on the card of the file it names", () => {
  const before = [card({ id: "a", name: "one.pdf" }), card({ id: "b", name: "two.png" })];
  const after = mergeUpload(before, ["a", "b"], {
    errors: [],
    uploaded: [
      { originalName: "one.pdf", path: "uploads/one.pdf", status: "created" },
      { originalName: "two.png", path: "uploads/two.png", status: "renamed" },
    ],
  });
  assert.deepEqual(
    after.map((item) => [item.status, item.path]),
    [["uploaded", "uploads/one.pdf"], ["uploaded", "uploads/two.png"]],
  );
});

test("a name with path segments is matched by the name the request sent", () => {
  // The wire carries the last segment only, and the answer can only name it
  // that way. Compared against the file's own name, this card would read as a
  // failure while its bytes were safely in the workspace.
  const after = mergeUpload([card({ id: "a", name: "../outside.csv" })], ["a"], {
    errors: [],
    uploaded: [{ originalName: "outside.csv", path: "outside.csv", status: "created" }],
  });
  assert.deepEqual(
    after.map((item) => [item.status, item.path, item.file.name]),
    [["uploaded", "outside.csv", "../outside.csv"]],
  );
});

test("a file the answer refuses is a failed card, with the reason the route gave", () => {
  const after = mergeUpload([card({ id: "a", name: "big.mov" })], ["a"], {
    errors: [],
    uploaded: [{ error: "too large", originalName: "big.mov", status: "failed" }],
  });
  assert.equal(after[0].status, "failed");
  assert.equal(after[0].error, "too large");
  // The failure is the route's account of one file, not a reason to empty the
  // rest of the tray.
  assert.equal(after[0].file.name, "big.mov");
});

test("the same name chosen twice takes one answer each, in order", () => {
  const before = [card({ id: "a", name: "same.txt" }), card({ id: "b", name: "same.txt" })];
  const after = mergeUpload(before, ["a", "b"], {
    errors: [],
    uploaded: [
      { originalName: "same.txt", path: "uploads/same.txt", status: "created" },
      { error: "disk full", originalName: "same.txt", status: "failed" },
    ],
  });
  assert.deepEqual(
    after.map((item) => item.status),
    ["uploaded", "failed"],
  );
});

test("a card the answer never mentions fails rather than waiting forever", () => {
  const after = mergeUpload([card({ id: "a", name: "lost.pdf" })], ["a"], { errors: [], uploaded: [] });
  assert.equal(after[0].status, "failed");
});

test("a batch the route never answered fails whole, and only that batch", () => {
  const before = [card({ id: "a", name: "a.pdf" }), card({ id: "b", name: "b.pdf" })];
  const after = failUpload(before, ["a"], "offline");
  assert.deepEqual(
    after.map((item) => [item.id, item.status, item.error]),
    [["a", "failed", "offline"], ["b", "uploading", undefined]],
  );
});

test("a card is the file's name, type, size and status", () => {
  const markup = tray([
    card({ id: "a", name: "报告.pdf", status: "uploaded" }),
    card({ id: "b", name: "大文件.mov", status: "uploading" }),
    card({ error: "too large", id: "c", name: "截图.png", status: "failed" }),
  ]);
  assert.equal([...markup.matchAll(/class="attach-card /gu)].length, 3);
  assert.match(markup, /class="attach-name">报告\.pdf</u);
  assert.match(markup, /class="attach-meta">PDF 5\.5KB</u);
  // In flight, the card says so in place of a size it does not have yet.
  assert.match(markup, /class="attach-meta">上传中…</u);
  assert.match(markup, /class="attach-spin"/u);
  // Failed keeps the name, drops the file's mark for the warning, and offers
  // the retry that needs no menu.
  assert.match(markup, /class="attach-card is-failed"/u);
  assert.match(markup, /class="attach-mark is-failed"/u);
  assert.match(markup, /上传失败/u);
  assert.match(markup, /class="attach-retry"[^>]*>重试</u);
  assert.equal([...markup.matchAll(/class="file-badge"/gu)].length, 2);
});
