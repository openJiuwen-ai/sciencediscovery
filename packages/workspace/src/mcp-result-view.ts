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

/** MCP providers return canonical records for audit, citation and later
 * governed downloads. Models need a smaller, bounded view of those records;
 * the complete provider result remains available in the invocation ledger. */

export const MCP_MODEL_RESULT_MAX_BYTES = 48 * 1024;
const MCP_MODEL_STRING_MAX_BYTES = 4 * 1024;
const MCP_MODEL_ARRAY_MAX_ITEMS = 25;
const MCP_MODEL_OBJECT_MAX_ENTRIES = 50;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(characters.slice(0, middle).join(""), "utf8") <= Math.max(0, maxBytes - 3)) low = middle;
    else high = middle - 1;
  }
  return { text: `${characters.slice(0, low).join("")}...`, truncated: true };
}

function uniqueStrings(...groups: unknown[]): string[] {
  return [...new Set(groups.flatMap((group) => Array.isArray(group) ? group : [])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

function citationText(record: JsonObject): string | undefined {
  const citation = object(record.primaryCitation);
  if (typeof citation?.markdown === "string") return citation.markdown;
  if (typeof citation?.label === "string") return citation.label;
  return undefined;
}

function compactRecord(record: JsonObject, abstractMaxBytes = MCP_MODEL_STRING_MAX_BYTES): JsonObject {
  const rawAuthors = Array.isArray(record.authors)
    ? record.authors.filter((author): author is string => typeof author === "string")
    : [];
  const authors = rawAuthors.slice(0, 8).map((author) => truncateUtf8(author, 160).text);
  const abstract = typeof record.abstract === "string"
    ? truncateUtf8(record.abstract, abstractMaxBytes)
    : undefined;
  return {
    id: record.identifier,
    title: typeof record.title === "string" ? truncateUtf8(record.title, 1_000).text : record.title,
    ...(authors.length ? { authors, authorCount: rawAuthors.length,
      ...(authors.length < rawAuthors.length ? { authorsTruncated: true } : {}) } : {}),
    ...(record.year !== undefined ? { year: record.year } : {}),
    ...(record.url !== undefined ? { url: record.url } : {}),
    ...(citationText(record) ? { citation: citationText(record) } : {}),
    ...(record.contentScope !== undefined ? { contentScope: record.contentScope } : {}),
    ...(record.peerReviewStatus !== undefined ? { peerReviewStatus: record.peerReviewStatus } : {}),
    ...(abstract ? { abstract: abstract.text, ...(abstract.truncated ? { abstractTruncated: true } : {}) } : {}),
  };
}

function searchMetadata(result: JsonObject): JsonObject {
  const data = object(result.data);
  if (!data) return {};
  const keys = ["query", "returned", "total", "offset", "hasMore", "nextOffset", "sortBy", "sortOrder"];
  return Object.fromEntries(keys.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
}

function fitEvidenceView(view: JsonObject, recordsKey: "papers" | "records"): JsonObject {
  const records = view[recordsKey] as JsonObject[];
  let omitted = 0;
  while (utf8Bytes(view) > MCP_MODEL_RESULT_MAX_BYTES) {
    const withAbstract = records
      .filter((record) => typeof record.abstract === "string" && Buffer.byteLength(record.abstract, "utf8") > 256)
      .toSorted((left, right) => Buffer.byteLength(String(right.abstract), "utf8") - Buffer.byteLength(String(left.abstract), "utf8"))[0];
    if (withAbstract) {
      const current = String(withAbstract.abstract);
      const shortened = truncateUtf8(current.replace(/\.\.\.$/, ""), Math.max(256, Math.floor(Buffer.byteLength(current, "utf8") / 2)));
      withAbstract.abstract = shortened.text;
      withAbstract.abstractTruncated = true;
      continue;
    }
    const withAuthors = records.findLast((record) => Array.isArray(record.authors) && record.authors.length > 1);
    if (withAuthors) {
      (withAuthors.authors as unknown[]).pop();
      withAuthors.authorsTruncated = true;
      continue;
    }
    if (records.length > 1) {
      records.pop();
      omitted += 1;
      continue;
    }
    break;
  }
  if (omitted) {
    view.recordsOmitted = omitted;
    view.truncated = true;
  }
  const recordsTruncated = records.some((record) => record.abstractTruncated === true || record.authorsTruncated === true);
  if (recordsTruncated) view.truncated = true;
  if (view.truncated === true) {
    const detail = view.sourceId === "arxiv" ? " Use get_paper with an arXiv identifier when a full abstract is needed." : "";
    view.instruction = view.hasMore === true
      ? `Use nextOffset to request the next result page.${detail}`
      : `Refine the query or lower the result limit.${detail}`;
  }
  if (utf8Bytes(view) <= MCP_MODEL_RESULT_MAX_BYTES) return view;
  return {
    sourceId: view.sourceId,
    toolId: view.toolId,
    ...(view.invocationId ? { invocationId: view.invocationId } : {}),
    truncated: true,
    instruction: "The MCP result exceeded the model-view budget. Refine the request or lower its result limit.",
  };
}

function evidenceView(result: JsonObject, sourceId: string, toolId: string): JsonObject | undefined {
  if (!Array.isArray(result.records)) return undefined;
  const recordObjects = result.records.map(object);
  if (recordObjects.some((record) => !record)) return undefined;
  const recordsKey = sourceId === "arxiv" ? "papers" : "records";
  const recordWarnings = recordObjects.flatMap((record) => record?.warnings ?? []);
  const view: JsonObject = {
    sourceId,
    toolId,
    ...(typeof result.invocationId === "string" ? { invocationId: result.invocationId } : {}),
    ...searchMetadata(result),
    returned: object(result.data)?.returned ?? recordObjects.length,
    warnings: uniqueStrings(result.warnings, recordWarnings),
    [recordsKey]: recordObjects.map((record) => compactRecord(record!, sourceId === "arxiv" && toolId === "get_paper" ? 24_000 : undefined)),
  };
  if (view.hasMore === true && !view.instruction) {
    view.instruction = "Use nextOffset to request the next result page.";
  }
  return fitEvidenceView(view, recordsKey);
}

function compactUnknown(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    const compacted = truncateUtf8(value, MCP_MODEL_STRING_MAX_BYTES);
    return compacted.truncated ? { text: compacted.text, truncated: true } : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 6) return { truncated: true, reason: "maximum depth reached" };
  if (Array.isArray(value)) {
    const items = value.slice(0, MCP_MODEL_ARRAY_MAX_ITEMS).map((item) => compactUnknown(item, depth + 1));
    return value.length > items.length ? [...items, { omittedItems: value.length - items.length, truncated: true }] : items;
  }
  const entries = Object.entries(value as JsonObject);
  const compacted = Object.fromEntries(entries.slice(0, MCP_MODEL_OBJECT_MAX_ENTRIES)
    .map(([key, item]) => [key, compactUnknown(item, depth + 1)]));
  if (entries.length > MCP_MODEL_OBJECT_MAX_ENTRIES) {
    compacted._projection = { omittedFields: entries.length - MCP_MODEL_OBJECT_MAX_ENTRIES, truncated: true };
  }
  return compacted;
}

/** Project an MCP result for model consumption while leaving the full result
 * untouched for details, CAS, audit and governed follow-up operations. */
export function mcpModelResultView(result: unknown, sourceId: string, toolId: string): JsonObject {
  const canonical = object(result);
  const evidence = canonical ? evidenceView(canonical, sourceId, toolId) : undefined;
  if (evidence) return evidence;
  const compacted = compactUnknown(result);
  if (utf8Bytes(compacted) <= MCP_MODEL_RESULT_MAX_BYTES) return object(compacted) ?? { result: compacted };
  const preview = truncateUtf8(JSON.stringify(compacted), MCP_MODEL_RESULT_MAX_BYTES - 1_024).text;
  return {
    sourceId,
    toolId,
    truncated: true,
    preview,
    instruction: "The MCP result exceeded the model-view budget. Refine the request or lower its result limit.",
  };
}
