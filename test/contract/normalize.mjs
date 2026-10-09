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

/**
 * Normalisation for contract recordings: two runs of the same scenario must produce
 * the same text, so ids, times and digests are replaced by stable placeholders.
 * Ids are numbered by first appearance, which keeps "the same id shows up here and
 * there" visible in the diff while hiding the value.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g;
const DIGEST = /sha256:[0-9a-f]{64}/g;
const WORKSPACE_ID = /ws_[0-9a-f]{64}/g;
// The system environment revision names the sandbox in use (bwrap on Linux, seatbelt on macOS).
const SYSTEM_ENVIRONMENT = /system-(?:python3|shell)-(?:bwrap|seatbelt)-v\d+/g;
// Scripted stubs listen on a free port; the sandbox makes a randomly named private temp directory.
const LOCAL_URL = /(http:\/\/)?127\.0\.0\.1:\d+/g;
const SANDBOX_TEMP = /(seatbelt|bwrap)-[A-Za-z0-9]{6}\b/g;
// Build-specific values that can sit inside a string that is itself JSON (a tool result).
const RUNNER_VERSION = /(\\*"runnerVersion\\*":\\*")[^"\\]*/g;
// Where this checkout lives differs between machines; a case that passes it to the server (`{{repoRoot}}`)
// would otherwise record one machine's path.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A custom MCP server's id is generated per run.
const CUSTOM_MCP_ID = /\bcustom-[0-9a-f]{12}\b/g;
// A person's or a service account's home directory: the machine a recording was made on is not part of the contract.
const HOME_DIR = /(?<![\w.:\-\/])(?:\/root|\/home\/[^/\s"']+|\/Users\/[^/\s"']+)(?=\/|\b)/g;
const HEX_TOKEN = /\b[0-9a-f]{32,}\b/gi;
const TIMEY_KEY = /(At|Time|Ts|Timestamp)$/;
// Keys whose value is a per-run measurement, not part of the contract.
const VOLATILE_KEYS = new Set(["durationMs", "elapsedMs", "latencyMs", "runnerVersion", "runnerVersionId", "localVersion", "remoteVersion", "pid",
  // Exchange rates come from an outside service (Frankfurter): both the number and its date move.
  // Whether there are rates at all depends on the outside service answering when the request is made.
  "exchangeRates", "rate", "effectiveDate",
  // A runner's host measurements (load, free memory, uptime, disk, data directory) differ on every read.
  "resources"]);

/**
 * The scrubs that need no numbering: safe to apply again to a recording that was already
 * normalised, so a rule added later does not invalidate an older baseline (the comparison
 * scrubs both sides).
 */
export function scrubText(value) {
  return value
    .split(REPO_ROOT).join("<repo>")
    .replace(HOME_DIR, "<home>")
    .replace(DIGEST, "<sha256>")
    .replace(WORKSPACE_ID, "<workspace>")
    .replace(SYSTEM_ENVIRONMENT, "<system-environment>")
    .replace(LOCAL_URL, "$1127.0.0.1:<port>")
    .replace(SANDBOX_TEMP, "$1-<tmp>")
    .replace(RUNNER_VERSION, "$1<volatile>");
}

export function scrubValue(value) {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v)]));
  return value;
}

export function createNormalizer() {
  const ids = new Map();
  const idFor = (value) => {
    const key = value.toLowerCase();
    if (!ids.has(key)) ids.set(key, ids.size + 1);
    return ids.get(key);
  };
  const text = (value) => scrubText(value)
    .replace(UUID, (match) => `<uuid:${idFor(match)}>`)
    .replace(CUSTOM_MCP_ID, (match) => `<custom-mcp:${idFor(match)}>`)
    .replace(ISO_TIME, "<time>")
    .replace(HEX_TOKEN, "<hex>");
  const walk = (value, key = "") => {
    if (typeof value === "string") return text(value);
    if (typeof value === "number") {
      if (TIMEY_KEY.test(key) && value > 1e11) return "<time-number>";
      if (VOLATILE_KEYS.has(key)) return "<volatile>";
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, key));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value)
        .map(([name, item]) => [name, VOLATILE_KEYS.has(name) ? "<volatile>" : walk(item, name)])
        .sort(([a], [b]) => a.localeCompare(b)));
    }
    return value;
  };
  return { json: walk, text };
}

/** A path-level diff of two normalised values; empty when they are equal. */
export function diff(expected, actual, path = "$") {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return [];
  const bothObjects = expected && actual && typeof expected === "object" && typeof actual === "object"
    && Array.isArray(expected) === Array.isArray(actual);
  if (!bothObjects) return [{ path, expected, actual }];
  const keys = Array.isArray(expected)
    ? [...Array(Math.max(expected.length, actual.length)).keys()]
    : [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  return keys.flatMap((key) => diff(expected[key], actual[key], Array.isArray(expected) ? `${path}[${key}]` : `${path}.${key}`));
}
