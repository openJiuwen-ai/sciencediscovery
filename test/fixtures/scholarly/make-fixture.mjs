#!/usr/bin/env node
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

// Records one scholarly fixture for FixtureScholarlyTransport replay.
// The filename mirrors fixtureFileName() in
// services/api/src/knowledge-engine/connectors/transport.ts — keep the two in
// sync when that algorithm changes (replay fails loudly on drift, by design).
//
// Usage:
//   node make-fixture.mjs <url> [--status N] [--from-file path] [--base64] [--header k=v ...]
// Default: fetch the URL with the production user agent and store status+body.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fixtureFileName(url) {
  const parsed = new URL(url);
  const raw = `${parsed.host}${parsed.pathname}`;
  const sanitized = raw.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);
  return `${sanitized}-${hash}`;
}

const args = process.argv.slice(2);
const url = args[0];
if (!url || !/^https?:\/\//.test(url)) {
  console.error("usage: node make-fixture.mjs <url> [--status N] [--from-file path] [--base64] [--header k=v ...]");
  process.exit(1);
}
let status = 200;
let fromFile;
let encoding = "utf8";
const headers = {};
for (let i = 1; i < args.length; i += 1) {
  if (args[i] === "--status") { status = Number(args[i + 1]); i += 1; }
  else if (args[i] === "--from-file") { fromFile = args[i + 1]; i += 1; }
  else if (args[i] === "--base64") { encoding = "base64"; }
  else if (args[i] === "--header") {
    const [key, value] = args[i + 1].split("=");
    headers[key] = value;
    i += 1;
  }
}

let body;
let resolvedStatus = status;
if (fromFile) {
  const raw = readFileSync(fromFile);
  body = encoding === "base64" ? raw.toString("base64") : raw.toString("utf8");
} else {
  const response = await fetch(url, { headers: { "user-agent": "ScienceDiscovery/1.0 (knowledge-engine connector)" } });
  resolvedStatus = status === 200 && !response.ok ? response.status : status;
  for (const pick of ["retry-after", "content-type", "location"]) {
    const value = response.headers.get(pick);
    if (value) headers[pick] = value;
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  body = encoding === "base64" ? Buffer.from(buffer).toString("base64") : new TextDecoder().decode(buffer);
}

const record = { status: resolvedStatus, ...(Object.keys(headers).length ? { headers } : {}), body, encoding };
const name = `${fixtureFileName(url)}.json`;
const outPath = resolve(dirname(fileURLToPath(import.meta.url)), name);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(record, null, encoding === "base64" ? 0 : 2) + "\n");
console.log(`${outPath}  status=${resolvedStatus} bytes=${body.length}`);
