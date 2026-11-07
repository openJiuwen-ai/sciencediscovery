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

import { redactLogText } from "./redaction.js";

// ---------------------------------------------------------------------------
// Constants shared by the client (apps/web, apps/desktop) and the Worker. The
// endpoint is fixed for now (see the scheme: <worker>.<workers.dev subdomain>)
// but is kept as a single constant so a future domain/ICP move touches one place.
// ---------------------------------------------------------------------------

/** Feedback types accepted by the pipeline. */
export type FeedbackKind = "bug" | "idea" | "other";
export type ContactType = "email" | "github";

export const FEEDBACK_KINDS: readonly FeedbackKind[] = ["bug", "idea", "other"];

export const FEEDBACK_MIN_BODY = 10;
export const FEEDBACK_MAX_BODY = 2000;
export const FEEDBACK_MAX_TITLE = 120;
export const FEEDBACK_MAX_DIAGNOSTICS = 4000;

/**
 * Screenshots are compressed in the client before they reach the wire (max edge
 * 1600px, WebP), so these caps describe already-compressed payloads rather than
 * what a user may pick from disk. The request budget leaves room for the Base64
 * expansion of eight 2 MiB images plus the text fields.
 */
export const FEEDBACK_MAX_IMAGES = 8;
export const FEEDBACK_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const FEEDBACK_MAX_IMAGE_NAME = 120;
export const FEEDBACK_MAX_BYTES = 24 * 1024 * 1024;
export const FEEDBACK_DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const FEEDBACK_ENDPOINT = "https://sciencediscovery-feedback.sciencediscovery.workers.dev";
export const FEEDBACK_API_PATH = "/api/feedback";

// ---------------------------------------------------------------------------
// Receipt codes: `FB-XXXX-XXXX`, two 4-character groups drawn from a 32-symbol
// alphabet (no I/O/0/1), i.e. 40 bits. Untestable by enumeration alone.
// ---------------------------------------------------------------------------

export const RECEIPT_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const RECEIPT_CODE_LENGTH = 8;
export const RECEIPT_PATTERN = /^FB-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

export type RandomBytes = (length: number) => Uint8Array;

function cryptoRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }
  // Non-secure fallback for exotic embedding contexts. The format still holds;
  // 5 bytes / 40 bits are only meaningful when backed by a CSPRNG.
  for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

export function generateReceipt(randomBytes: RandomBytes = cryptoRandomBytes): string {
  // 5 bytes = 40 bits = exactly 8 five-bit symbols.
  const bytes = randomBytes(5);
  let accumulator = 0;
  let bits = 0;
  let code = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      code += RECEIPT_ALPHABET[(accumulator >>> bits) & 0x1f]!;
    }
  }
  code = code.slice(0, RECEIPT_CODE_LENGTH);
  return `${"FB"}-${code.slice(0, 4)}-${code.slice(4, 8)}`;
}

export function isValidReceipt(value: string): boolean {
  return RECEIPT_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Feedback-specific redaction. Goes beyond `redactLogText`: API keys are forced
// to a distinct marker and the Windows profile path is normalized to a token.
// ---------------------------------------------------------------------------

const HARD_KEY_PATTERNS = [
  /\b(?:sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g,
];
const WINDOWS_PROFILE = /\b[A-Za-z]:[\\/]Users[\\/][^\\/\r\n]+/g;

export function redactFeedbackText(text: string): string {
  let redacted = text.toWellFormed().replace(WINDOWS_PROFILE, "%USERPROFILE%");
  for (const pattern of HARD_KEY_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED:key]");
  // Delegate the remaining suite (bearer, URL credentials, generic assignments,
  // unix home dirs) to the shared logging redactor.
  return redactLogText(redacted);
}

// ---------------------------------------------------------------------------
// PII detection is advisory only: it never mutates the text, the client shows a
// confirmation instead (scheme §6.1).
// ---------------------------------------------------------------------------

export type PiiKind = "phone" | "id-card" | "email";
export interface PiiHint { kind: PiiKind; value: string }

const PII_PHONE = /1[3-9]\d{9}/g;
const PII_ID_CARD = /\d{17}[\dXx]/g;
const PII_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function detectFeedbackPii(text: string): PiiHint[] {
  const hints: PiiHint[] = [];
  for (const match of text.matchAll(PII_PHONE)) hints.push({ kind: "phone", value: match[0] });
  for (const match of text.matchAll(PII_ID_CARD)) hints.push({ kind: "id-card", value: match[0] });
  for (const match of text.matchAll(PII_EMAIL)) hints.push({ kind: "email", value: match[0] });
  return hints;
}

// ---------------------------------------------------------------------------
// Contact classification: a single free-text field auto-detects email vs GitHub
// username (scheme FR-05). Invalid input yields `undefined`.
// ---------------------------------------------------------------------------

export const GITHUB_USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function classifyContact(value: string): ContactType | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (EMAIL_PATTERN.test(trimmed) && trimmed.length <= 254) return "email";
  if (GITHUB_USERNAME_PATTERN.test(trimmed)) return "github";
  return undefined;
}

// ---------------------------------------------------------------------------
// Payload building and validation (shared by client and Worker so the two never
// drift on the wire contract).
// ---------------------------------------------------------------------------

export interface FeedbackContact { type: ContactType; value: string }

/** MIME types a screenshot may use. Anything else is rejected before upload. */
export const FEEDBACK_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type FeedbackImageMime = (typeof FEEDBACK_IMAGE_MIME_TYPES)[number];

/**
 * One attached screenshot. `data` is raw Base64 (no `data:` prefix): the Worker
 * forwards it to the GitHub Contents API and the client must not spend budget
 * on a wrapper the relay would only strip again.
 */
export interface FeedbackImage {
  name: string;
  mime: FeedbackImageMime;
  data: string;
}

/** Decoded byte length of a Base64 string, or `undefined` when it is malformed. */
export function base64DecodedBytes(data: string): number | undefined {
  if (data.length === 0 || data.length % 4 !== 0) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/** Filenames are display-only. Strip controls and Markdown syntax so a name
 *  cannot break out of the `![alt](url)` construct the Worker renders. */
export function sanitizeFeedbackImageName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[[\]()<>|!]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FEEDBACK_MAX_IMAGE_NAME);
  return cleaned || "image";
}

export interface FeedbackMeta {
  version?: string;
  os?: string;
  locale?: string;
  installId?: string;
  sessionId?: string;
  runId?: string;
  requestId?: string;
}

export interface FeedbackSubmission {
  v: 1;
  kind: FeedbackKind;
  title: string;
  body: string;
  contact?: FeedbackContact;
  meta?: FeedbackMeta;
  diagnostics?: string;
  images?: FeedbackImage[];
  clientTs: string;
}

export function deriveFeedbackTitle(body: string): string {
  const firstLine = body.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  return redactFeedbackText(firstLine).replace(/\s+/g, " ").trim().slice(0, FEEDBACK_MAX_TITLE);
}

export interface BuildFeedbackOptions {
  kind: FeedbackKind;
  title: string;
  body: string;
  contact?: FeedbackContact;
  meta?: FeedbackMeta;
  diagnostics?: string;
  images?: FeedbackImage[];
  clientTs?: string;
}

export function buildFeedbackPayload(options: BuildFeedbackOptions): FeedbackSubmission {
  const title = redactFeedbackText(options.title).replace(/\s+/g, " ").trim().slice(0, FEEDBACK_MAX_TITLE);
  const body = redactFeedbackText(options.body.trim()).slice(0, FEEDBACK_MAX_BODY);
  const payload: FeedbackSubmission = {
    v: 1,
    kind: options.kind,
    title: title || deriveFeedbackTitle(body) || "Untitled",
    body,
    clientTs: options.clientTs ?? new Date().toISOString(),
  };
  if (options.contact) payload.contact = options.contact;
  if (options.meta && Object.keys(options.meta).length > 0) payload.meta = options.meta;
  if (options.diagnostics !== undefined) payload.diagnostics = options.diagnostics.slice(0, FEEDBACK_MAX_DIAGNOSTICS);
  if (options.images && options.images.length > 0) {
    payload.images = options.images.slice(0, FEEDBACK_MAX_IMAGES).map((image) => ({
      name: sanitizeFeedbackImageName(image.name),
      mime: image.mime,
      data: image.data,
    }));
  }
  return payload;
}

export interface FeedbackFieldError { field: string; reason: string }

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function validateFeedbackSubmission(input: FeedbackSubmission): FeedbackFieldError[] {
  const errors: FeedbackFieldError[] = [];
  // The body arrives as JSON, so its declared type is a promise nobody verified
  // yet. Check the shapes before calling string methods: a numeric body should
  // be a 400 naming the field, not a TypeError turning into a 500.
  const raw = asRecord(input) ?? {};
  if (!FEEDBACK_KINDS.includes(raw.kind as FeedbackKind)) errors.push({ field: "kind", reason: "invalid kind" });

  if (!isString(raw.body)) {
    errors.push({ field: "body", reason: "expected string" });
  } else if (raw.body.trim().length < FEEDBACK_MIN_BODY) {
    errors.push({ field: "body", reason: `min ${FEEDBACK_MIN_BODY}` });
  } else if (raw.body.length > FEEDBACK_MAX_BODY) {
    errors.push({ field: "body", reason: `max ${FEEDBACK_MAX_BODY}` });
  }

  if (!isString(raw.title) || raw.title.length === 0 || raw.title.length > FEEDBACK_MAX_TITLE) {
    errors.push({ field: "title", reason: `1..${FEEDBACK_MAX_TITLE}` });
  }

  if (raw.diagnostics !== undefined) {
    if (!isString(raw.diagnostics)) {
      errors.push({ field: "diagnostics", reason: "expected string" });
    } else if (raw.diagnostics.length > FEEDBACK_MAX_DIAGNOSTICS) {
      errors.push({ field: "diagnostics", reason: `max ${FEEDBACK_MAX_DIAGNOSTICS}` });
    }
  }

  // Screenshots are validated like every other JSON field: shape first, then
  // type, then size. Decoding to check the real byte count (rather than the
  // Base64 length) keeps the limit identical to what the client compressed to.
  if (raw.images !== undefined) {
    const images = raw.images;
    if (!Array.isArray(images)) {
      errors.push({ field: "images", reason: "expected array" });
    } else if (images.length > FEEDBACK_MAX_IMAGES) {
      errors.push({ field: "images", reason: `max ${FEEDBACK_MAX_IMAGES}` });
    } else {
      for (let index = 0; index < images.length; index += 1) {
        const field = `images[${index}]`;
        const image = asRecord(images[index]);
        if (!image) {
          errors.push({ field, reason: "expected object" });
          continue;
        }
        if (!isString(image.name) || image.name.length === 0 || image.name.length > FEEDBACK_MAX_IMAGE_NAME) {
          errors.push({ field: `${field}.name`, reason: `1..${FEEDBACK_MAX_IMAGE_NAME}` });
        }
        if (!isString(image.mime) || !FEEDBACK_IMAGE_MIME_TYPES.includes(image.mime as FeedbackImageMime)) {
          errors.push({ field: `${field}.mime`, reason: FEEDBACK_IMAGE_MIME_TYPES.join("|") });
        }
        if (!isString(image.data)) {
          errors.push({ field: `${field}.data`, reason: "expected base64 string" });
          continue;
        }
        const bytes = base64DecodedBytes(image.data);
        if (bytes === undefined) {
          errors.push({ field: `${field}.data`, reason: "invalid base64" });
        } else if (bytes > FEEDBACK_MAX_IMAGE_BYTES) {
          errors.push({ field: `${field}.data`, reason: `max ${FEEDBACK_MAX_IMAGE_BYTES} bytes` });
        }
      }
    }
  }

  if (raw.meta !== undefined) {
    const meta = asRecord(raw.meta);
    if (!meta) {
      errors.push({ field: "meta", reason: "expected object" });
    } else {
      for (const field of ["installId", "version", "os", "locale"] as const) {
        if (meta[field] !== undefined && !isString(meta[field])) {
          errors.push({ field: `meta.${field}`, reason: "expected string" });
        }
      }
    }
  }

  if (raw.contact !== undefined && raw.contact !== null) {
    const contact = asRecord(raw.contact);
    if (!contact || !isString(contact.type) || !isString(contact.value)) {
      errors.push({ field: "contact", reason: "expected {type,value}" });
    } else if (contact.type !== "email" && contact.type !== "github") {
      errors.push({ field: "contact.type", reason: "email|github" });
    } else if (contact.type === "email" && (contact.value.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.value))) {
      errors.push({ field: "contact.value", reason: "invalid email" });
    } else if (contact.type === "github" && !GITHUB_USERNAME_PATTERN.test(contact.value)) {
      errors.push({ field: "contact.value", reason: "invalid github username" });
    }
  }
  return errors;
}