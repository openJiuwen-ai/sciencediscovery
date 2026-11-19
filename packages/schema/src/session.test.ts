import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import {
  SESSION_TITLE_MAX_CHARACTERS,
  UNTITLED_SESSION_TITLE,
  createLocalSessionTitle,
  fallbackSessionTitle,
  isEvidenceSessionReadOnly,
} from "./session.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"],
});

test("session title normalization preserves Unicode boundaries and uses a neutral fallback", () => {
  assert.equal(createLocalSessionTitle("  a\n\t b  "), "a b");
  assert.equal(createLocalSessionTitle("😀".repeat(SESSION_TITLE_MAX_CHARACTERS)), "😀".repeat(SESSION_TITLE_MAX_CHARACTERS));
  assert.equal(createLocalSessionTitle("😀".repeat(SESSION_TITLE_MAX_CHARACTERS + 1), "2026-11-18T09:10:00.000Z"), "Session 11-18 09:10");
  assert.equal(createLocalSessionTitle("   ", "bad-date"), UNTITLED_SESSION_TITLE);
  assert.equal(fallbackSessionTitle("2026-01-02T03:04:05.000Z"), "Session 01-02 03:04");
});

test("evidence snapshots are read-only until a ready working copy exists", () => {
  assert.equal(isEvidenceSessionReadOnly(undefined), false);
  assert.equal(isEvidenceSessionReadOnly({ researchSnapshot: { role: "imported_snapshot", state: "ready" } as never }), true);
  assert.equal(isEvidenceSessionReadOnly({ researchSnapshot: { role: "research_copy", state: "importing" } as never }), true);
  assert.equal(isEvidenceSessionReadOnly({ researchSnapshot: { role: "research_copy", state: "ready" } as never }), false);
});
