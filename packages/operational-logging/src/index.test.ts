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

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { createOperationalLogger } from "./index.js";

function withTempDataDir(context: test.TestContext): string {
  const tempRoot = resolve(process.cwd(), ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const dataDir = mkdtempSync(resolve(tempRoot, "operational-logging-"));
  context.after(() => rmSync(dataDir, { force: true, recursive: true }));
  return dataDir;
}

test("filters messages below the configured level", (context) => {
  const logger = createOperationalLogger({
    category: "api",
    dataDir: withTempDataDir(context),
    env: { SCIENCE_AGENT_LOG_LEVEL: "warn" },
    service: "api",
  });

  logger.info("ignored");
  logger.warn("kept", { runId: "run-1" });

  const contents = readFileSync(logger.path, "utf8");
  assert.doesNotMatch(contents, /ignored/);
  assert.match(contents, /WARN \[api\] event=kept runId=run-1/);
});

test("rotates logs by size and keeps bounded backups", (context) => {
  const logger = createOperationalLogger({
    category: "runner",
    dataDir: withTempDataDir(context),
    env: {
      SCIENCE_AGENT_LOG_BACKUP_COUNT: "2",
      SCIENCE_AGENT_LOG_MAX_BYTES: "180",
    },
    service: "runner",
  });

  for (let index = 0; index < 12; index += 1) {
    logger.info("rotation_probe", { index, value: "x".repeat(40) });
  }

  assert.ok(readFileSync(logger.path, "utf8").length > 0);
  assert.ok(readFileSync(`${logger.path}.1`, "utf8").length > 0);
  assert.ok(readFileSync(`${logger.path}.2`, "utf8").length > 0);
  assert.throws(() => readFileSync(`${logger.path}.3`, "utf8"), /ENOENT/);
});

test("redacts sensitive keys and credential-like text", (context) => {
  const logger = createOperationalLogger({
    category: "run",
    dataDir: withTempDataDir(context),
    service: "api",
  });

  logger.error("tool_failed", {
    apiKey: "api-key-value",
    errorMessage: 'Authorization: Bearer header-secret JSON={"apiKey":"json-secret"}',
    nested: { password: "password-value", safe: "visible" },
    prompt: "full user prompt",
    token: "token-value",
  });

  const contents = readFileSync(logger.path, "utf8");
  assert.match(contents, /\[REDACTED\]/);
  assert.match(contents, /visible/);
  assert.match(contents, /\[OMITTED\]/);
  assert.doesNotMatch(contents, /full user prompt/);
  for (const secret of ["api-key-value", "header-secret", "json-secret", "password-value", "token-value"]) {
    assert.doesNotMatch(contents, new RegExp(secret));
  }
});
