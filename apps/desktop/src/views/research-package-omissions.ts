// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0

/**
 * What the import card shows for `inspection.manifest.omissions`.
 *
 * Owner decision (2026-11-21): text that came *in the package* is shown as the
 * package wrote it — never translated — and only text this dialog generates is
 * rendered in the interface language. The array is package text, so a sentence
 * the exporter wrote stays in that sentence's language either way; what the
 * dialog adds is the count line, the family name of a reference row, the hover
 * explanation, the "not readable text" marker, and the placeholder used when an
 * entry cannot be described at all (`describeEntry`).
 *
 * The array holds two shapes:
 *
 *  - whole sentences the export and branch writers compose
 *    (`services/api/src/research-snapshots.ts`, `conversation-branches.ts`),
 *    some in Chinese and some in English, shown verbatim;
 *  - object references shaped `<token>:<id>:<reason>`, naming a specific
 *    missing object, run or file. The family is the dialog's word, the id/path
 *    and the reason are the package's.
 *
 * One shape stays ambiguous: the upload sanitizer allows a colon inside a
 * workspace path, so `workspace:<session>:<path>:<reason>` cannot be split with
 * certainty when the path itself contains one. The reader takes the second field
 * as the path and the rest as the reason, which is right for every path the
 * export writers produce today; escaping the path in the writer is what would
 * make it exact, and that is a server-side change this dialog cannot make.
 *
 * Every entry is shown and the count is `items.length`: a package whose entries
 * are all reference-shaped must not read as complete. Entries are untrusted
 * package content, so nothing here may throw on one.
 */

export interface OmissionWording {
  family: {
    artifact: string; cas: string; evolve: string;
    review: string; run: string; trajectory: string; version: string; workspace: string;
  };
  hint: {
    artifact: string; cas: string; evolve: string;
    review: string; run: string; trajectory: string; version: string; workspace: string;
    unparsed: string;
  };
  unparsed: (raw: string) => string;
  /** Used when neither JSON nor `String()` can describe the entry. */
  unrepresentable: string;
}

export interface OmissionRow {
  /** Stable per row, in manifest order; duplicated entries stay distinct. */
  key: string;
  /** What the row says: the dialog's family name plus the package's own text. */
  label: string;
  /** Shown on hover, only where the label is terse (a reference or raw value). */
  hint?: string;
}

/**
 * Built without `Object.prototype`, because the lookup below is on untrusted
 * package text: a plain object inherits `constructor`, `toString` and the rest,
 * so a token named `constructor` would otherwise pass as a known family and the
 * entry would render as an invented reference instead of the raw line.
 */
const FAMILY: Record<string, keyof OmissionWording["family"]> = Object.assign(Object.create(null) as Record<string, keyof OmissionWording["family"]>, {
  artifact: "artifact",
  "artifact-review": "review",
  cas: "cas",
  evolve: "evolve",
  review: "review",
  "review-feedback": "review",
  "review-task": "review",
  run: "run",
  trajectory: "trajectory",
  version: "version",
  workspace: "workspace",
});

/** A machine reference, as the export side writes it: `<token>:<rest>`. */
const REFERENCE = /^([a-z][a-z-]*):(.+)$/s;

/**
 * A reference row split by its known shape.
 *
 * The writers put free text — an `error.message`, which itself contains colons,
 * or a `sha256:<64 hex>` candidate hash, which occupies two tokens — in the last
 * fields. Each shape is therefore read with bounded fields, and a shape this
 * build does not know falls back to the raw text rather than to a guess:
 *
 *  - `workspace:<session>:<path>:<reason...>`: second field is the path;
 *  - `evolve:<run>:sha256:<digest>:<reason...>`, `evolve:<run>:<hash>:<reason...>`
 *    and `evolve:<run>:<reason...>` (a candidate hash is `sha256:<64 hex>`);
 *  - `<token>:<id>:<reason...>` for the remaining families.
 *
 * The reason is returned untouched: it is package text.
 */
function parseReference(text: string): { detail: string; family: keyof OmissionWording["family"]; reason: string } | undefined {
  const match = REFERENCE.exec(text);
  if (!match) return undefined;
  const family = Object.hasOwn(FAMILY, match[1]!) ? FAMILY[match[1]!] : undefined;
  if (!family) return undefined;
  const rest = match[2]!;

  let detail = "";
  let reason = "";
  if (family === "workspace") {
    const fields = rest.split(":");
    if (fields.length < 3) return undefined;
    detail = fields[1]!;
    reason = fields.slice(2).join(":");
  } else if (family === "evolve") {
    const fields = rest.split(":");
    if (fields.length >= 4 && /^sha256$/i.test(fields[1]!)) {
      detail = `${fields[0]}:sha256:${fields[2]}`;
      reason = fields.slice(3).join(":");
    } else if (fields.length >= 3) {
      detail = `${fields[0]}:${fields[1]}`;
      reason = fields.slice(2).join(":");
    } else if (fields.length === 2) {
      detail = fields[0]!;
      reason = fields[1]!;
    } else {
      reason = rest;
    }
  } else {
    const split = rest.indexOf(":");
    if (split === -1) {
      detail = rest;
    } else {
      detail = rest.slice(0, split);
      reason = rest.slice(split + 1);
    }
  }

  return { detail, family, reason };
}

/**
 * A textual form of an untrusted entry that never throws.
 *
 * `JSON.stringify` is preferred because it keeps the package's structure visible;
 * it raises `RangeError` on a deeply nested object. `String()` is the fallback and
 * raises `TypeError` when the entry's `toString` is not callable. Neither call may
 * decide whether the dialog renders, so the final answer is a placeholder from the
 * dialog's own dictionary.
 */
function describeEntry(item: unknown, wording: OmissionWording): string {
  if (typeof item === "object" && item !== null) {
    try {
      const json = JSON.stringify(item);
      if (typeof json === "string") return json;
    } catch {
      // Deeply nested: fall through to the placeholder below, because `String()`
      // would call the entry's own `toString`.
    }
    return wording.unrepresentable;
  }
  try {
    return String(item);
  } catch {
    return wording.unrepresentable;
  }
}

/**
 * One row per manifest entry, in manifest order. `key` is the index alone: rows
 * never reorder, so it is unique, and building it from the entry would call
 * `String()` on untrusted package content — `{"toString": null}` throws there,
 * before the guarded conversion below could run.
 */
export function omissionRows(items: readonly unknown[], wording: OmissionWording): OmissionRow[] {
  return items.map((item, index) => {
    const key = String(index);

    if (typeof item !== "string") {
      // Untrusted package content: a non-string is shown as its own text rather
      // than dropped or thrown on, and it still counts toward the summary. Both
      // conversions can fail on a crafted entry: `JSON.stringify` overflows on a
      // deeply nested object, and `String()` throws when `toString` is not
      // callable, so the last resort is a fixed placeholder that reads neither.
      return { key, hint: wording.hint.unparsed, label: wording.unparsed(describeEntry(item, wording)) };
    }

    const text = item.trim();
    const reference = parseReference(text);
    if (!reference) {
      // A sentence the package wrote: shown as it came, in its own language.
      return { key, label: text };
    }

    const head = [wording.family[reference.family], reference.detail].filter(Boolean).join(" · ");
    return {
      key,
      hint: wording.hint[reference.family],
      label: reference.reason ? `${head} · ${reference.reason}` : head,
    };
  });
}
