// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createTest } from "../support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { checkDeliverable, startDeliverableChecker } from "./deliverable-check.mjs";
const require = createRequire(new URL("../../services/api/package.json", import.meta.url));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
test("requires actual section headings, not prose or fenced examples", () => {
  assert.equal(checkDeliverable("## Methods\n## Results\n## References").ok, true);
  assert.deepEqual(checkDeliverable("Methods Results References").missing, ["Methods", "Results", "References"]);
  assert.deepEqual(checkDeliverable("```md\n## Methods\n```\n## Results\n## References").missing, ["Methods"]);
  assert.equal(checkDeliverable("## methods ##\r\n## RESULTS\r\n## References").ok, true);
});
test("HTTP MCP exposes exactly one tool and records exact positive/negative inputs", async () => {
  const checker = await startDeliverableChecker();
  const client = new Client({ name: "checker-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(checker.url)));
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ["deliverable_check"]);
    for (const report of ["## Methods\n## Results\n## References", "## Methods\nMissing Results and References"]) {
      const result = await client.callTool({ name: "deliverable_check", arguments: { report_text: report } });
      assert.deepEqual(result.structuredContent, checkDeliverable(report));
      assert.equal(checker.calls.at(-1).report_text, report);
    }
    assert.equal(checker.calls.length, 2);
  } finally { await client.close(); await checker.stop(); }
});
