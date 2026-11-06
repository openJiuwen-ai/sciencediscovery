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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import {
  RECEIPT_ALPHABET,
  RECEIPT_PATTERN,
  FEEDBACK_MAX_BODY,
  FEEDBACK_MAX_IMAGE_BYTES,
  FEEDBACK_MAX_IMAGES,
  FEEDBACK_MAX_TITLE,
  base64DecodedBytes,
  generateReceipt,
  isValidReceipt,
  redactFeedbackText,
  detectFeedbackPii,
  classifyContact,
  deriveFeedbackTitle,
  buildFeedbackPayload,
  validateFeedbackSubmission,
  type FeedbackImage,
  type FeedbackSubmission,
} from "./feedback.js";

/** Deterministic 40-bit counter as a RandomBytes source: unique per call, no entropy flakiness. */
function counterBytes() {
  let counter = 0;
  return (length: number): Uint8Array => {
    const bytes = new Uint8Array(length);
    let value = counter;
    for (let i = length - 1; i >= 0; i -= 1) {
      bytes[i] = value & 0xff;
      value = (value >>> 8) & 0xffffffff;
    }
    counter += 1;
    return bytes;
  };
}

test("receipt codes match FB-XXXX-XXXX using only the 32-symbol alphabet", () => {
  for (let i = 0; i < 1000; i += 1) {
    const code = generateReceipt();
    assert.match(code, RECEIPT_PATTERN);
    assert.ok(isValidReceipt(code));
    for (const ch of code.replace(/FB|-/g, "")) assert.ok(RECEIPT_ALPHABET.includes(ch));
  }
  assert.ok(!isValidReceipt("FB-0000-ABCD"));
  assert.ok(!isValidReceipt("XX-ABCD-EFGH"));
});

test("one hundred thousand deterministic receipts are unique and well-formed (AC-13)", () => {
  const seen = new Set<string>();
  const randomBytes = counterBytes();
  for (let i = 0; i < 100_000; i += 1) {
    const code = generateReceipt(randomBytes);
    assert.match(code, RECEIPT_PATTERN);
    seen.add(code);
  }
  assert.equal(seen.size, 100_000);
});

test("feedback redaction forces keys to [REDACTED:key] and normalizes the Windows profile path", () => {
  const body = [
    "sk-abcdefghijklmnopqrstuvwxyz0123",
    "ghp_abcdefghijklmnop",
    "AKIAIOSFODNN7EXAMPLE",
    String.raw`C:\Users\alice\logs\api.log`,
  ].join("\n");
  const redacted = redactFeedbackText(body);
  for (const token of ["sk-abcdefghijklmnopqrstuvwxyz0123", "ghp_abcdefghijklmnop", "AKIAIOSFODNN7EXAMPLE", "alice"]) {
    assert.ok(!redacted.includes(token), `should redact ${token}`);
  }
  assert.match(redacted, /\[REDACTED:key\]/);
  assert.match(redacted, /%USERPROFILE%/);
});

test("PII detection is advisory and does not mutate the text", () => {
  const text = "call 13800138000 or id 11010519491231002X, mail me at user@example.com";
  const hints = detectFeedbackPii(text).map((hint) => hint.kind);
  assert.ok(hints.includes("phone"));
  assert.ok(hints.includes("id-card"));
  assert.ok(hints.includes("email"));
  assert.ok(redactFeedbackText(text).includes("13800138000"), "PII is prompt-only, never auto-removed");
});

test("contact classification splits email from github and rejects junk", () => {
  assert.equal(classifyContact("user@example.com"), "email");
  assert.equal(classifyContact("octocat"), "github");
  assert.equal(classifyContact("octo-cat"), "github");
  assert.equal(classifyContact("-leading"), undefined);
  assert.equal(classifyContact("trailing-"), undefined);
  assert.equal(classifyContact(""), undefined);
});

test("derived title uses the first non-empty line, redacted and capped at 120", () => {
  const title = deriveFeedbackTitle("sk-abcdefghijklmnopqrstuvwxyz0123\nsecond line ignored");
  assert.ok(!title.includes("sk-abcdefghijklmnopqrstuvwxyz0123"));
  assert.ok(title.length <= FEEDBACK_MAX_TITLE);
});

test("payload builder redacts, trims, caps and drops omitted diagnostics", () => {
  const payload = buildFeedbackPayload({
    kind: "bug",
    title: "AKIAIOSFODNN7EXAMPLE broke",
    body: "   too short is fine here but keys go: ghp_abcdefghijklmnop  ",
    contact: { type: "github", value: "octocat" },
    meta: { locale: "zh-CN" },
    clientTs: "2026-11-03T10:00:00Z",
  });
  assert.equal(payload.v, 1);
  assert.equal(payload.kind, "bug");
  assert.ok(!payload.body.includes("ghp_abcdefghijklmnop"));
  assert.ok(!payload.title.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.equal(payload.contact?.type, "github");
  assert.equal(payload.clientTs, "2026-11-03T10:00:00Z");
  assert.equal(payload.diagnostics, undefined);

  const withDiagnostics = buildFeedbackPayload({
    kind: "idea",
    title: "title",
    body: "a long enough body",
    diagnostics: "x".repeat(FEEDBACK_MAX_BODY + 10),
    clientTs: "2026-11-03T10:00:00Z",
  });
  assert.ok(withDiagnostics.diagnostics!.length <= 4000);
});

test("validation enforces kind, body range, title range and contact shapes", () => {
  const base: FeedbackSubmission = {
    v: 1,
    kind: "bug",
    title: "a title",
    body: "a body long enough",
    clientTs: "2026-11-03T10:00:00Z",
  };
  assert.deepEqual(validateFeedbackSubmission(base), []);
  assert.ok(validateFeedbackSubmission({ ...base, kind: "nope" as never }).some((e) => e.field === "kind"));
  assert.ok(validateFeedbackSubmission({ ...base, body: "short" }).some((e) => e.field === "body"));
  assert.ok(validateFeedbackSubmission({ ...base, body: "x".repeat(FEEDBACK_MAX_BODY + 1) }).some((e) => e.field === "body"));
  assert.ok(validateFeedbackSubmission({ ...base, title: "" }).some((e) => e.field === "title"));
  assert.ok(validateFeedbackSubmission({ ...base, contact: { type: "email", value: "not-an-email" } }).some((e) => e.field === "contact.value"));
  assert.ok(validateFeedbackSubmission({ ...base, contact: { type: "github", value: "-bad" } }).some((e) => e.field === "contact.value"));
});

test("redaction is idempotent so clients can pre-redact before the payload runs it again", () => {
  const input = "路径 C:\\Users\\alice\\proj，token=abc123，home /home/bob/x";
  const once = redactFeedbackText(input);
  assert.equal(redactFeedbackText(once), once);
});

test("validation rejects wrongly typed JSON fields instead of throwing", () => {
  const base = {
    v: 1,
    kind: "bug",
    title: "a title",
    body: "a body long enough",
    clientTs: "2026-11-03T10:00:00Z",
  } as unknown as FeedbackSubmission;
  const fields = (patch: Record<string, unknown>): string[] =>
    validateFeedbackSubmission({ ...base, ...patch } as unknown as FeedbackSubmission).map((e) => e.field);

  assert.ok(fields({ body: 42 }).includes("body"));
  assert.ok(fields({ title: 42 }).includes("title"));
  assert.ok(fields({ diagnostics: 42 }).includes("diagnostics"));
  assert.ok(fields({ meta: { installId: 42 } }).includes("meta.installId"));
  assert.ok(fields({ contact: { type: "email" } }).includes("contact"));
});

test("base64 size checks reject malformed input and count decoded, not encoded, bytes", () => {
  assert.equal(base64DecodedBytes("AAAA"), 3);
  assert.equal(base64DecodedBytes("AAA="), 2);
  assert.equal(base64DecodedBytes("AA=="), 1);
  assert.equal(base64DecodedBytes(""), undefined);
  assert.equal(base64DecodedBytes("AAA"), undefined);
  assert.equal(base64DecodedBytes("AA=A"), undefined);
  assert.equal(base64DecodedBytes("data:text/plain;base64,AAAA"), undefined);
});

test("image validation enforces count, MIME, Base64 shape and the decoded size caps", () => {
  const base: FeedbackSubmission = {
    v: 1,
    kind: "bug",
    title: "a title",
    body: "a body long enough",
    clientTs: "2026-11-03T10:00:00Z",
  };
  const image = (patch: Partial<FeedbackImage> = {}): FeedbackImage => ({
    name: "shot.png",
    mime: "image/png",
    data: "A".repeat(4 * 1000),
    ...patch,
  });
  const fields = (images: unknown): string[] =>
    validateFeedbackSubmission({ ...base, images } as unknown as FeedbackSubmission).map((e) => e.field);

  assert.deepEqual(validateFeedbackSubmission({ ...base, images: [image()] }), []);
  assert.deepEqual(
    validateFeedbackSubmission({ ...base, images: Array.from({ length: FEEDBACK_MAX_IMAGES }, () => image()) }),
    [],
  );
  assert.ok(fields({}).includes("images"));
  assert.ok(fields(Array.from({ length: FEEDBACK_MAX_IMAGES + 1 }, () => image())).includes("images"));
  assert.ok(fields([image({ mime: "image/gif" as never })]).includes("images[0].mime"));
  assert.ok(fields([image({ data: "data:image/png;base64,AAAA" })]).includes("images[0].data"));
  assert.ok(fields([{ data: image().data }]).includes("images[0].name"));

  // 4 chars per 3 decoded bytes: just over the per-image cap must be rejected.
  const oversized = "A".repeat(Math.ceil((FEEDBACK_MAX_IMAGE_BYTES + 1) / 3) * 4);
  assert.ok(base64DecodedBytes(oversized)! > FEEDBACK_MAX_IMAGE_BYTES);
  assert.ok(fields([image({ data: oversized })]).includes("images[0].data"));
});

test("the payload builder sanitizes image names and keeps the Base64 data verbatim", () => {
  const payload = buildFeedbackPayload({
    kind: "bug",
    title: "title",
    body: "a long enough body",
    images: [{ name: "a](b)!<script>.png", mime: "image/webp", data: "AAAA" }],
    clientTs: "2026-11-03T10:00:00Z",
  });
  assert.equal(payload.images?.length, 1);
  assert.equal(payload.images?.[0]?.data, "AAAA");
  assert.equal(payload.images?.[0]?.mime, "image/webp");
  assert.ok(!/[\[\]()<>!]/.test(payload.images![0]!.name));
});
