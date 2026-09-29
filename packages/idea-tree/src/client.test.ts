import { createTest } from "../../../test/support/tagged/compat.mjs";
const {test} = createTest(import.meta.url, {tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"]});
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {IdeaTreeServiceClient} from "./client.js";

test("MCP research binds scope outside arguments, preserves evidence and revokes the capability", async () => {
  const calls: Array<{path: string; method?: string; body: any}> = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push({path: request.url!, method: request.method, body});
    assert.equal(request.headers.authorization, "Bearer internal-test");
    response.setHeader("content-type", "application/json");
    if (request.url === "/mcp/scopes") response.end(JSON.stringify({token: "test-scope"}));
    else if (request.method === "DELETE") {response.statusCode = 204; response.end();}
    else response.end(JSON.stringify({jsonrpc: "2.0", id: 1, result: {isError: false, content: [{type: "text", text: JSON.stringify({research: {id: "research-1"}})}]}}));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
    const client = new IdeaTreeServiceClient({url, token: "internal-test"});
    const result = await client.research({operation: "create", projectId: "p", sessionId: "s", researchId: "research-1", modelId: "model",
      objective: "Compare iron catalysts", materials: "source: study-A", llm: {url: "http://127.0.0.1/callback", token: "run-test"}});
    assert.equal(result.research.id, "research-1");
    assert.equal(calls[0]!.body.sessionId, "s");
    assert.equal(calls[0]!.body.llm.token, "run-test");
    assert.deepEqual(calls[1]!.body.params, {name: "create_idea_research", arguments: {objective: "Compare iron catalysts", materials: "source: study-A"}});
    assert.equal(calls[2]!.method, "DELETE");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("service-owned tool contract and errors reach the agent without exposing transport fields", async () => {
  let revoked = false;
  const descriptor = {name: "control_idea_research", description: "Service-owned description", inputSchema: {type: "object", properties: {operation: {type: "string"}}}};
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/mcp/tools") response.end(JSON.stringify({tools: [descriptor]}));
    else if (request.url === "/mcp/scopes") response.end(JSON.stringify({token: "scope"}));
    else if (request.method === "DELETE") {revoked = true; response.statusCode = 204; response.end();}
    else response.end(JSON.stringify({result: {isError: true, content: [{text: "Research not found"}]}}));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new IdeaTreeServiceClient({url: `http://127.0.0.1:${(server.address() as {port: number}).port}`, token: "internal"});
    let observed: unknown;
    const tools = await client.tools(async (name, args) => { observed = {name, args}; return {status: "paused"}; });
    assert.deepEqual(tools[0]!.parameters, descriptor.inputSchema);
    assert.equal(tools[0]!.description, descriptor.description);
    const output = await tools[0]!.execute("call", {operation: "pause"});
    assert.deepEqual(observed, {name: descriptor.name, args: {operation: "pause"}});
    assert.deepEqual(output.details, {status: "paused"});
    await assert.rejects(client.research({operation: "get", projectId: "p", sessionId: "s", researchId: "missing"}), /Research not found/);
    assert.ok(revoked);
  } finally {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
});
