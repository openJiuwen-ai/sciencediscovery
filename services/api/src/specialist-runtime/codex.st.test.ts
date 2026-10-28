// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:st", "os:linux", "arch:amd64", "arch:arm64", "model:mock"] });
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxedCodex } from "./launcher.js";
import { Codex } from "@openai/codex-sdk";
import { CodexSpecialistAdapter } from "./codex.js";

/** Official SDK + unmodified pinned CLI against a loopback-only Responses fixture. */
test("Runner outer sandbox and inner Codex full access complete a provider turn without nested userns", { timeout: 30000 }, async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/responses")) { res.writeHead(404); res.end(); return; }
    let text = ""; for await (const chunk of req) text += chunk;
    if (!text) { res.writeHead(400); res.end("missing body"); return; }
    const body = JSON.parse(text);
    assert.equal(req.headers.authorization, "Bearer fixture-key");
    assert.doesNotMatch(JSON.stringify(body), /fixture-key/, "the credential must not enter the model request body");
    const offered = JSON.stringify(body.tools);
    assert.doesNotMatch(offered, /"(?:exec_command|shell_command|shell|local_shell|write_stdin)"/);
    calls++;
    const output = JSON.stringify({ summary: "Local Codex result", tools: [] });
    const message = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: output, annotations: [] }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "response.created", response: { id: "resp_fixture", status: "in_progress" } });
    send({ type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } });
    send({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: message.id, delta: output });
    send({ type: "response.output_item.done", output_index: 0, item: message });
    send({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [message], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const root = await mkdtemp(join(tmpdir(), "sd-codex-st-"));
  try {
    const codexPathOverride = await sandboxedCodex(root, root);
    const adapter = new CodexSpecialistAdapter((options, thread) => new Codex({ ...options, baseUrl, codexPathOverride,
      config: { ...options.config, model_provider: "fixture", model_providers: { fixture: { name: "Local fixture", base_url: baseUrl, env_key: "CODEX_API_KEY", wire_api: "responses", supports_websockets: false } } },
    }).startThread(thread));
    const result = await adapter.invoke({ workspaceRoot: root, prompt: "Return a final structured answer without tools.", signal: AbortSignal.timeout(20000), model: "gpt-5.4", maxTurns: 1, tools: [], credential: async () => "fixture-key" }, async () => {});
    assert.equal(result.summary, "Local Codex result");
    assert.ok(result.runtimeSessionId);
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
