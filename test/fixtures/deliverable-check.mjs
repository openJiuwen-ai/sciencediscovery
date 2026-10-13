// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createRequire } from "node:module";
import { createServer } from "node:http";
const require = createRequire(new URL("../../services/api/package.json", import.meta.url));
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

export const deliverableHeadingRule = "Methods, Results, and References must each be Markdown ATX headings outside fenced code blocks. "
  + "Both unnumbered headings such as `## Methods` and numbered headings such as `## 3. Methods` count; the same applies to Results and References. "
  + "Remove at most one leading numeric section number (for example `3.`, `3.1`, `3.1.`, or `4)`) followed by whitespace, and strip trailing heading `#` markers. "
  + "The remaining heading text must equal exactly Methods, Results, or References, case-insensitively. "
  + "Longer names such as `Methods and materials` or `3. Methodology`, prose mentions, and headings inside fenced code blocks do not count.";

export function checkDeliverable(text) {
  // Ignore fenced code: a sample heading is not a report section.
  let fence;
  const headings = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (!fence) {
      const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
      // A section number is optional; the rest must still be the exact section name.
      if (heading) headings.push(heading[1].replace(/^\d+(?:\.\d+)*[.)]?\s+/, "").toLowerCase());
    }
  }
  const missing = ["Methods", "Results", "References"].filter(h => !headings.includes(h.toLowerCase()));
  return { ok: missing.length === 0, missing, message: missing.length ? `Missing sections: ${missing.join(", ")}` : "Required sections present" };
}

export async function startDeliverableChecker() {
  const calls = [];
  const active = new Set();
  const http = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/mcp") { response.writeHead(405).end(); return; }
    const server = new Server({ name: "deliverable-check", version: "1.0.0" }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "deliverable_check",
      description: `${deliverableHeadingRule} Check the full final report. Do not summarize or alter report_text.`,
      inputSchema: { type: "object", properties: { report_text: { type: "string", minLength: 1 } }, required: ["report_text"], additionalProperties: false } }] }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      if (params.name !== "deliverable_check" || typeof params.arguments?.report_text !== "string" || !params.arguments.report_text.trim())
        return { isError: true, content: [{ type: "text", text: "Expected deliverable_check with nonempty report_text" }] };
      const report = params.arguments.report_text;
      const result = checkDeliverable(report);
      calls.push({ at: new Date().toISOString(), report_text: report, result });
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    });
    active.add(server);
    response.on("close", () => { active.delete(server); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(request, response); }
    catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${http.address().port}/mcp`, calls,
    stop: async () => { await Promise.allSettled([...active].map(s => s.close())); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); } };
}
