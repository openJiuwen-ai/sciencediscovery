// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import assert from "node:assert/strict";
import test from "node:test";

import type { SkillReviewDraft } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { buildSkillLineDiff, SkillLineDiff, SkillReviewDialog, skillDiffSplitFromClientX, skillFileDiffStatus } from "../src/SkillReviewDialog.js";

test("classifies added, modified, removed, and unchanged Skill files", () => {
  const base = { content: "before", path: "SKILL.md", size: 6 };
  assert.equal(skillFileDiffStatus(undefined, { content: "after", path: "SKILL.md" }), "added");
  assert.equal(skillFileDiffStatus(base, undefined), "removed");
  assert.equal(skillFileDiffStatus(base, { content: "after", path: "SKILL.md" }), "modified");
  assert.equal(skillFileDiffStatus(base, { content: "before", path: "SKILL.md" }), "unchanged");
});

test("aligns unchanged, modified, added, and removed lines like a pull-request diff", () => {
  assert.deepEqual(buildSkillLineDiff(
    "same\nold value\nremove me\ntail",
    "same\nnew value\ninsert me\ntail",
  ), [
    { kind: "unchanged", left: { lineNumber: 1, text: "same" }, right: { lineNumber: 1, text: "same" } },
    { kind: "modified", left: { lineNumber: 2, text: "old value" }, right: { lineNumber: 2, text: "new value" } },
    { kind: "modified", left: { lineNumber: 3, text: "remove me" }, right: { lineNumber: 3, text: "insert me" } },
    { kind: "unchanged", left: { lineNumber: 4, text: "tail" }, right: { lineNumber: 4, text: "tail" } },
  ]);
  assert.deepEqual(buildSkillLineDiff("keep\ndelete one\ndelete two", "keep\nadd one"), [
    { kind: "unchanged", left: { lineNumber: 1, text: "keep" }, right: { lineNumber: 1, text: "keep" } },
    { kind: "modified", left: { lineNumber: 2, text: "delete one" }, right: { lineNumber: 2, text: "add one" } },
    { kind: "removed", left: { lineNumber: 3, text: "delete two" } },
  ]);
});

test("clamps the draggable A and B split to a usable range", () => {
  assert.equal(skillDiffSplitFromClientX(0, 100, 1_000), 24);
  assert.equal(skillDiffSplitFromClientX(550, 100, 1_000), 45);
  assert.equal(skillDiffSplitFromClientX(2_000, 100, 1_000), 76);
  assert.equal(skillDiffSplitFromClientX(500, 100, 0), 50);
});

test("renders a resizable pull-request style diff with change statistics", () => {
  const html = renderToStaticMarkup(createElement(SkillLineDiff, {
    after: "same\nnew value\nadded",
    before: "same\nold value",
    leftLabel: "Revision A",
    rightLabel: "Revision B",
    status: "modified",
  }));

  assert.match(html, /Side-by-side diff/);
  assert.match(html, /2 changed lines/);
  assert.match(html, /aria-label="2 additions and 1 deletions"/);
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-valuenow="50"/);
  assert.match(html, /Reset the A and B columns to equal width/);
  assert.match(html, />A<\/span>/);
  assert.match(html, />B<\/span>/);
});

test("renders a multi-file review editor that requires explicit confirmation", () => {
  const draft = {
    baseFiles: [{ content: "old", path: "SKILL.md", size: 3 }],
    baseRevision: 2,
    createdAt: "2026-08-20T00:00:00.000Z",
    draftId: "11111111-1111-4111-8111-111111111111",
    fileCount: 2,
    files: [
      { content: "new", path: "SKILL.md", size: 3 },
      { content: "guide", path: "references/guide.md", size: 5 },
    ],
    name: "reviewed-skill",
    updatedAt: "2026-08-20T00:00:00.000Z",
  } satisfies SkillReviewDraft;
  const html = renderToStaticMarkup(createElement(SkillReviewDialog, {
    busy: false,
    draft,
    onClose: () => undefined,
    onConfirm: () => undefined,
    onDiscard: () => undefined,
  }));

  assert.match(html, /Pending Agent draft/);
  assert.match(html, /Update from r2/);
  assert.match(html, /Edit files/);
  assert.match(html, /Review changes/);
  assert.match(html, /references\/guide.md/);
  assert.match(html, /Confirm new revision/);
});

test("labels a revised pending Skill as a comparison with the previous Agent proposal", () => {
  const draft = {
    baseFiles: [{ content: "first", path: "SKILL.md", size: 5 }],
    comparisonSource: "previous-agent-draft",
    createdAt: "2026-08-20T00:00:00.000Z",
    draftId: "11111111-1111-4111-8111-111111111111",
    fileCount: 1,
    files: [{ content: "revised", path: "SKILL.md", size: 7 }],
    name: "reviewed-skill",
    updatedAt: "2026-08-20T00:01:00.000Z",
  } satisfies SkillReviewDraft;
  const html = renderToStaticMarkup(createElement(SkillReviewDialog, {
    busy: false,
    draft,
    onClose: () => undefined,
    onConfirm: () => undefined,
    onDiscard: () => undefined,
  }));

  assert.match(html, /Revised proposal/);
  assert.match(html, /Previous Agent proposal/);
  assert.match(html, /skill-pr-line-number/);
  assert.match(html, /skill-pr-cell removed/);
  assert.match(html, /skill-pr-cell added/);
  assert.match(html, /<mark>first<\/mark>/);
  assert.match(html, /<mark>revised<\/mark>/);
  assert.match(html, /first/);
  assert.match(html, /revised/);
  assert.match(html, /Confirm and create Skill/);
});
