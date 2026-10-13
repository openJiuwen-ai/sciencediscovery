// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createTest } from "../support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { checkDeliverable, deliverableHeadingRule, startDeliverableChecker } from "./deliverable-check.mjs";
const require = createRequire(new URL("../../services/api/package.json", import.meta.url));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
test("requires actual section headings, not prose or fenced examples", () => {
  assert.equal(checkDeliverable("## Methods\n## Results\n## References").ok, true);
  assert.deepEqual(checkDeliverable("Methods Results References").missing, ["Methods", "Results", "References"]);
  assert.deepEqual(checkDeliverable("```md\n## Methods\n```\n## Results\n## References").missing, ["Methods"]);
  assert.equal(checkDeliverable("## methods ##\r\n## RESULTS\r\n## References").ok, true);
});
test("accepts numbered Methods, Results, and References from the final report", () => {
  assert.deepEqual(checkDeliverable("## 3. Methods\n## 4. Results\n## 9. References"), {
    ok: true, missing: [], message: "Required sections present",
  });
});
test("accepts one section number followed by whitespace without changing case or closing-marker support", () => {
  for (const number of ["3", "3.", "3.1", "3.1.", "4)"]) {
    assert.equal(checkDeliverable(`# ${number}\tmethods ##\r\n### ${number} RESULTS\r\n###### ${number} References`).ok, true, number);
  }
});
test("rejects longer section names after optional numbering", () => {
  for (const heading of ["## 3. Methodology", "## Methods and materials", "## 3. Methods and materials"]) {
    assert.deepEqual(checkDeliverable(`${heading}\n## Results\n## References`).missing, ["Methods"], heading);
  }
  assert.deepEqual(checkDeliverable("## Methods\n## 4. Results overview\n## 9. References and notes").missing, ["Results", "References"]);
});
test("rejects numbers without separating whitespace and repeated number prefixes", () => {
  for (const heading of ["## 3.Methods", "## 4)Methods", "## 3. 1. Methods"]) {
    assert.deepEqual(checkDeliverable(`${heading}\n## Results\n## References`).missing, ["Methods"], heading);
  }
});
test("numbered headings only inside fenced code or prose do not count", () => {
  for (const fence of ["```", "~~~"]) {
    assert.deepEqual(checkDeliverable(`${fence}md\n## 3. Methods\n${fence}\n## 4. Results\n## 9. References`).missing, ["Methods"]);
  }
  assert.deepEqual(checkDeliverable("3. Methods\n4. Results\n9. References").missing, ["Methods", "Results", "References"]);
});
test("HTTP MCP exposes exactly one tool and records exact positive/negative inputs", async () => {
  const checker = await startDeliverableChecker();
  const client = new Client({ name: "checker-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(checker.url)));
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(t => t.name), ["deliverable_check"]);
    assert.ok(tools[0].description.includes(deliverableHeadingRule));
    for (const report of ["## Methods\n## Results\n## References", "## 3. Methods\n## 4. Results\n## 9. References", "## Methods\nMissing Results and References"]) {
      const result = await client.callTool({ name: "deliverable_check", arguments: { report_text: report } });
      assert.deepEqual(result.structuredContent, checkDeliverable(report));
      assert.equal(checker.calls.at(-1).report_text, report);
    }
    assert.equal(checker.calls.length, 3);
  } finally { await client.close(); await checker.stop(); }
});
