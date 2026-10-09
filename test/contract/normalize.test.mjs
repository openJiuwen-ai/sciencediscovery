//!/usr/bin/env bash
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

import assert from "node:assert/strict";
import { createTest } from "../support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

import { createNormalizer, diff, scrubValue } from "./normalize.mjs";

test("ids are numbered by first appearance so the same id stays recognisable", () => {
  const normalize = createNormalizer();
  const out = normalize.json({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    parent: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    again: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
  });
  assert.deepEqual(out, { again: "<uuid:1>", id: "<uuid:1>", parent: "<uuid:2>" });
});

test("two runs with different ids and times normalise to the same value", () => {
  const record = (id, time) => createNormalizer().json({ createdAt: time, id, title: `session ${id}` });
  assert.deepEqual(
    record("11111111-1111-4111-8111-111111111111", "2026-01-01T00:00:00.000Z"),
    record("22222222-2222-4222-8222-222222222222", "2026-09-21T10:11:12.345Z"),
  );
});

test("digests, workspace ids, long hex tokens and time-like numbers are hidden", () => {
  const out = createNormalizer().json({
    digest: `sha256:${"a".repeat(64)}`, workspaceId: `ws_${"b".repeat(64)}`, token: "c".repeat(40),
    queuedAt: 1789939122918, count: 3, durationMs: 15, runnerVersion: "73015b2e",
  });
  assert.deepEqual(out, {
    count: 3, digest: "<sha256>", durationMs: "<volatile>", queuedAt: "<time-number>",
    runnerVersion: "<volatile>", token: "<hex>", workspaceId: "<workspace>",
  });
});

test("object key order does not matter but array order does", () => {
  const normalize = createNormalizer();
  assert.equal(JSON.stringify(normalize.json({ b: 1, a: 2 })), JSON.stringify(normalize.json({ a: 2, b: 1 })));
  assert.notEqual(JSON.stringify(normalize.json([1, 2])), JSON.stringify(normalize.json([2, 1])));
});

test("diff names the path of every difference and nothing when equal", () => {
  assert.deepEqual(diff({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(
    diff({ a: 1, list: [1, 2], gone: true }, { a: 2, list: [1, 2, 3] }),
    [
      { path: "$.a", expected: 1, actual: 2 },
      { path: "$.gone", expected: true, actual: undefined },
      { path: "$.list[2]", expected: undefined, actual: 3 },
    ],
  );
});

test("the sandbox-specific name of the system environment is hidden", () => {
  const normalize = createNormalizer();
  assert.deepEqual(normalize.json({ a: "system-python3-bwrap-v1", b: "system-shell-seatbelt-v1" }), {
    a: "<system-environment>", b: "<system-environment>",
  });
});

test("a stub's port and the sandbox's random temp directory name are hidden", () => {
  const normalize = createNormalizer();
  assert.equal(normalize.text("http://127.0.0.1:56778/v1"), "http://127.0.0.1:<port>/v1");
  assert.equal(normalize.text("/data/runner-runtime/tmp/seatbelt-fW42DG/x"), "/data/runner-runtime/tmp/seatbelt-<tmp>/x");
});

test("the runner build version is hidden even inside a JSON string, and scrubbing is idempotent", () => {
  const normalize = createNormalizer();
  const raw = { chunk: '{"runnerVersion":"f2dbe052-dirty","sandbox":"bubblewrap"}', nested: '{\\"runnerVersion\\":\\"73015b2e\\"}' };
  const once = normalize.json(raw);
  assert.equal(once.chunk, '{"runnerVersion":"<volatile>","sandbox":"bubblewrap"}');
  assert.equal(once.nested, '{\\"runnerVersion\\":\\"<volatile>\\"}');
  assert.deepEqual(scrubValue(once), once);
});

test("scrubbing an older recording applies rules that were added after it was made", () => {
  const old = { body: { chunk: '{"runnerVersion":"aaa1111","x":1}' } };
  assert.deepEqual(scrubValue(old), { body: { chunk: '{"runnerVersion":"<volatile>","x":1}' } });
});

test("a bare host:port for a local stub is hidden too, with or without the scheme", () => {
  const normalize = createNormalizer();
  assert.equal(normalize.text("127.0.0.1:59652"), "127.0.0.1:<port>");
  assert.equal(normalize.text("http://127.0.0.1:59652/v1"), "http://127.0.0.1:<port>/v1");
});

test("the rate and its date are hidden wherever they appear: they come from an outside service", () => {
  const out = createNormalizer().json({ quote: { provider: "Frankfurter", rate: 6.6999, effectiveDate: "2026-09-21" } });
  assert.deepEqual(out.quote, { provider: "Frankfurter", rate: "<volatile>", effectiveDate: "<volatile>" });
});

test("a runner's host measurements are hidden as one value", () => {
  const out = createNormalizer().json({ runnerStatus: { state: "ready", resources: { cpuCores: 2, uptimeSeconds: 9.5 } } });
  assert.deepEqual(out.runnerStatus, { state: "ready", resources: "<volatile>" });
});

test("the build version a runner reports on either side is hidden", () => {
  const out = createNormalizer().json({ localVersion: "abc-dirty", remoteVersion: "abc-dirty" });
  assert.deepEqual(out, { localVersion: "<volatile>", remoteVersion: "<volatile>" });
});

test("this checkout's path is hidden, so a recording does not depend on where it was made", async () => {
  const { REPO_ROOT } = await import("./normalize.mjs");
  assert.equal(scrubValue(`cwd ${REPO_ROOT}/test/fixtures`), "cwd <repo>/test/fixtures");
});

test("a custom MCP server's generated id is numbered like a uuid", () => {
  const normalize = createNormalizer();
  assert.equal(normalize.text("custom-683c5afc5d06 and custom-0b782b84a4f9 and custom-683c5afc5d06"),
    "<custom-mcp:1> and <custom-mcp:2> and <custom-mcp:1>");
});

test("a home directory is hidden, wherever the recording was made", () => {
  assert.equal(scrubValue("/root/.ssh/authorized_keys"), "<home>/.ssh/authorized_keys");
  assert.equal(scrubValue("/home/alice/data/x"), "<home>/data/x");
  assert.equal(scrubValue("/Users/bob/Downloads"), "<home>/Downloads");
  assert.equal(scrubValue("/rootless/keep"), "/rootless/keep");
  assert.equal(scrubValue("https://www.ncbi.nlm.nih.gov/home/about/policies/"), "https://www.ncbi.nlm.nih.gov/home/about/policies/", "a URL path is not a home directory");
  assert.equal(scrubValue("cwd /root/work"), "cwd <home>/work");
});

test("exchange rates are one volatile value: the service may not have answered", () => {
  const out = createNormalizer().json({ exchangeRates: [{ rate: 1 }], filters: { timeZone: "Asia/Shanghai" } });
  assert.deepEqual(out, { exchangeRates: "<volatile>", filters: { timeZone: "Asia/Shanghai" } });
});
