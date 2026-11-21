// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createTest } from "../../../../../test/support/tagged/compat.mjs";
import { searchDeepSeek } from "./deepseek.js";
import { renderExaContents, renderTavilyExtract } from "./fetch.js";
import { statusErrorCode, thrownErrorCode } from "./http.js";
import { buildTavilyAuthHeaders, normalizeBraveResults, normalizeExaResults, normalizeTavilyResults } from "./search.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

test("native provider normalizers preserve bounded result shapes and empty-page semantics", () => {
  assert.deepEqual(normalizeBraveResults(JSON.stringify({ web: { results: [{ title: " A ", description: " D ", url: "https://a" }, { title: "B", url: "https://b" }] } }), 1), [
    { title: "A", content: "D", url: "https://a" },
  ]);
  assert.deepEqual(normalizeTavilyResults(JSON.stringify({ results: [{ title: "T", content: "body", url: "https://t" }] }), 5), [
    { title: "T", content: "body", url: "https://t" },
  ]);
  assert.deepEqual(normalizeExaResults(JSON.stringify({ results: [{ title: "E", highlights: ["one", 2, "two"], url: "https://e" }] }), 5), [
    { title: "E", content: "one\ntwo", url: "https://e" },
  ]);
  assert.equal(renderTavilyExtract({ failed_results: [{ error: "blocked" }] }), "Error: blocked");
  assert.match(renderTavilyExtract({ results: [{ title: "Paper", raw_content: "content" }] }), /# Paper/);
  assert.equal(renderExaContents({ results: [] }), "Error: No results found");
});

test("native HTTP error classification keeps provider failures actionable", () => {
  assert.equal(statusErrorCode(401), "unauthorized");
  assert.equal(statusErrorCode(429), "rate-limited");
  assert.equal(statusErrorCode(503), "server-error");
  assert.equal(statusErrorCode(422), "semantic-error");
  assert.equal(thrownErrorCode(new Error("request timed out")), "timeout");
  assert.equal(thrownErrorCode(new Error("socket reset")), "transport-error");
  assert.deepEqual(buildTavilyAuthHeaders(undefined), { "content-type": "application/json" });
  assert.deepEqual(buildTavilyAuthHeaders("secret"), { "content-type": "application/json", authorization: "Bearer secret" });
});

test("DeepSeek rejects an oversized query before any network call", async () => {
  await assert.rejects(
    searchDeepSeek("x".repeat(129), { apiKey: "key", maxResults: 3, timeoutMs: 1000 } as never),
    /at most 128 Unicode characters/,
  );
});
