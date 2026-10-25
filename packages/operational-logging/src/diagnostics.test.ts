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

import { diagnosticText, formatErrorDiagnostic, errorIssueUrl, DIAGNOSTIC_MAX_CHARS, DIAGNOSTIC_MAX_ENCODED } from "./diagnostics.js";
import { redactLogText, redactLogValue } from "./redaction.js";

const base = { title: "Request failed", detail: "Connection refused", version: "1.2.3 (abc123)", os: "Linux", locale: "en", requestId: "request-1", runId: "run-1", sessionId: "session-1" };

test("diagnostics contain environment, error, correlation IDs and only the last five log lines", () => {
  const bundle = formatErrorDiagnostic({ ...base, snapshot: { logs: Array.from({ length: 10 }, (_, i) => `line-${i}`), logStatus: "available" } });
  for (const value of Object.values(base)) assert.ok(bundle.includes(value));
  assert.doesNotMatch(bundle, /line-4/);
  assert.match(bundle, /line-5/);
  assert.match(bundle, /line-9/);
});

test("redaction covers headers, quoted secrets, camel/snake keys, URL credentials and private keys", () => {
  for (const value of [
    "Authorization: Basic private-value",
    'Cookie: sid=private-value; preference=private-value',
    'Set-Cookie: sid=private-value',
    'apiToken=private-value access_token=private-value client_secret=private-value',
    '{"apiKey":"private-value with spaces", "password":"private-value"}',
    'https://user:private-value@example.test/?api_key=private-value',
    'Bearer private-value',
    '-----BEGIN PRIVATE KEY-----\nprivate-value\n-----END PRIVATE KEY-----',
  ]) assert.doesNotMatch(redactLogText(value), /private-value/);
  assert.deepEqual(redactLogValue({ cookie: "private-value", prompt: "research text", args: { command: "research text" } }), { cookie: "[REDACTED]", prompt: "[OMITTED]", args: "[OMITTED]" });
});

test("oversized Unicode errors are explicitly bounded before use in clipboard and GitHub URL", () => {
  const bundle = formatErrorDiagnostic({ ...base, title: "错误🧪".repeat(2000), detail: 'api_key="private-value" ' + "测试🧪".repeat(10000) });
  assert.ok(bundle.length <= DIAGNOSTIC_MAX_CHARS);
  assert.ok(encodeURIComponent(bundle).length <= DIAGNOSTIC_MAX_ENCODED);
  assert.match(bundle, /\[truncated\]/);
  assert.doesNotMatch(bundle, /private-value/);
  const url = new URL(errorIssueUrl("错误🧪".repeat(2000), bundle));
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/openJiuwen-ai/sciencediscovery/issues/new");
  assert.ok(url.searchParams.get("body")!.endsWith(bundle));
  assert.ok(url.toString().length < 8500);
});

test("redaction precedes truncation and missing logs are explicit", () => {
  assert.doesNotMatch(diagnosticText('api_key="' + "private-value".repeat(1000) + '"', 60), /private-value/);
  assert.match(formatErrorDiagnostic(base), /Unavailable:/);
  assert.doesNotThrow(() => formatErrorDiagnostic({ ...base, detail: "\ud800" }));
});


test("home-directory usernames are redacted before truncation in errors and exported log metadata", () => {
  const paths = [
    "/home/alice/.sciencediscovery-data/logs/api.log",
    "/Users/bob/project/file.ts",
    String.raw`C:\Users\charlie\AppData\Local\log.txt`,
    String.raw`C:\\Users\\daniel\\AppData\\Local\\log.txt`,
    "C:/Users/erin/project/log.txt",
    String.raw`c:\users\Frank Smith\AppData\Local\log.txt`,
    "/home/研究员/project/log.txt",
  ];
  const detail = paths.join("\n") + "\n/tmp/sciencediscovery-test/out.log\n/var/log/service.log\nBearer sk-testsecret api_key=private-value";
  const bundle = formatErrorDiagnostic({
    ...base, title: paths[0]!, detail,
    snapshot: { logs: paths.map(path => `path=${path}`), logStatus: "available" },
  });
  assert.doesNotMatch(bundle, /alice|bob|charlie|daniel|erin|Frank Smith|研究员|sk-testsecret|private-value/);
  assert.match(bundle, /\/home\/\[REDACTED\]\//);
  assert.match(bundle, /\/Users\/\[REDACTED\]\//);
  assert.ok(bundle.includes("C:\\Users\\[REDACTED]\\"));
  assert.match(bundle, /\/tmp\/sciencediscovery-test\/out\.log/);
  assert.match(bundle, /\/var\/log\/service\.log/);
  assert.ok(bundle.length <= DIAGNOSTIC_MAX_CHARS);
  assert.ok(encodeURIComponent(bundle).length <= DIAGNOSTIC_MAX_ENCODED);
  assert.doesNotMatch(diagnosticText("/home/alice/" + "x".repeat(1000), 24), /alice/);
  const url = new URL(errorIssueUrl(paths[1]!, bundle));
  assert.ok(url.searchParams.get("body")!.endsWith(bundle), "copy and draft use identical sanitized diagnostics");
  assert.doesNotMatch(decodeURIComponent(url.toString()), /alice|bob|charlie|daniel|erin|Frank Smith|研究员/);
});

test("the public issue URL also sanitizes a raw diagnostic supplied by a caller", () => {
  const url = new URL(errorIssueUrl("/Users/bob/error.ts", String.raw`/home/alice/log.txt C:\Users\charlie\log.txt Bearer sk-testsecret api_key=private-value`));
  const text = url.searchParams.get("title")! + url.searchParams.get("body")!;
  assert.doesNotMatch(text, /alice|bob|charlie|sk-testsecret|private-value/);
  assert.match(text, /\[REDACTED\]/);
});
