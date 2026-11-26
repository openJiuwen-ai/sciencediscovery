// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { test } from "node:test";
import { draftProblem, inputOf, parseMcpDrafts } from "../src/views/settings/mcp-config.js";
import { TEXT } from "../src/text.js";

test("JSON prefilling preserves argument boundaries, secret values and protocol aliases", () => {
  const args = ["/srv/my MCP/server.mjs", "", "  spaced  ", "a\nb"];
  const result = parseMcpDrafts("\uFEFF" + JSON.stringify({ mcpServers: {
    Echo: { command: "node", args, env: { TOKEN: " secret with spaces " }, enabled: true, tool_call_timeout: 73 },
    Search: { type: "streamable-http", url: "https://example.test/mcp", headers: { Authorization: "Bearer fixture" } },
    Events: { type: "sse", url: "https://example.test/sse", authMode: "oauth", oauth: { clientId: "client", clientSecret: "fixture", scope: "tools" } },
  } }));
  assert.equal(result.error, undefined);
  const [echo, search, events] = result.drafts;
  assert.ok(echo && search && events, "all three servers produce drafts");
  assert.equal(echo.enabled, false, "import is reviewed before explicitly enabling a service");
  assert.equal(echo.timeoutSeconds, "73");
  assert.deepEqual(inputOf({ ...echo, description: "edited" }).args, args);
  assert.deepEqual(inputOf(echo).env, { TOKEN: " secret with spaces " });
  assert.equal(search.transport, "http");
  assert.deepEqual(inputOf(search).headers, { Authorization: "Bearer fixture" });
  assert.equal(events.transport, "sse");
  assert.equal(events.oauth.clientSecret, "fixture");
});

test("invalid JSON structure and typed fields never become silently truncated drafts", () => {
  for (const value of [null, [], {}, { mcpServers: [] }, { mcpServers: { invalid: null } },
    { mcpServers: { bad: { command: "node", args: [1] } } },
    { mcpServers: { bad: { command: "node", env: { TOKEN: null } } } },
    { mcpServers: { bad: { type: "unsupported", url: "https://example.test" } } },
    { mcpServers: { bad: { type: "http", url: "https://example.test", headers: { Authorization: "a\nb" } } } },
    { mcpServers: { bad: { command: "node", timeoutSeconds: "60" } } },
  ]) {
    const parsed = parseMcpDrafts(JSON.stringify(value));
    assert.ok(parsed.error, JSON.stringify(value));
    assert.deepEqual(parsed.drafts, []);
  }
});

test("JSON limits apply before drafts are produced, including UTF-8 pasted data", () => {
  assert.equal(parseMcpDrafts(JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [String(index), { command: "node" }])) })).error, TEXT.settings.system.mcp.importTooMany);
  assert.equal(parseMcpDrafts("中".repeat(500001)).error, TEXT.settings.system.mcp.importFileTooLarge);
});

test("missing field values remain editable and hidden batch entries have form-equivalent constraints", () => {
  const parsed = parseMcpDrafts(JSON.stringify({ mcpServers: { Missing: { type: "stdio" }, Timeout: { command: "node", timeoutSeconds: 0 }, Url: { url: "ftp://example.test" } } }));
  assert.equal(parsed.error, undefined, "fields can be corrected without rewriting JSON");
  assert.equal(draftProblem(parsed.drafts[0]!), TEXT.settings.system.mcp.commandRequired);
  assert.equal(draftProblem(parsed.drafts[1]!), TEXT.settings.system.mcp.timeoutInvalid);
  assert.equal(draftProblem(parsed.drafts[2]!), TEXT.settings.system.mcp.urlInvalid);
});
