// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:st", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { protocolProvider } from "../../../test/helpers/protocol-provider.js";
import { startModelGateway } from "./agent-run/jiuwenswarm-model-gateway.js";
import { handleEvolveCompletion, RunTokenRegistry } from "./evolution/llm-proxy.js";
import { generateRefinedSessionTitle } from "./session-naming.js";
import { PaperService } from "./papers.js";
import { SessionStore } from "./store.js";
import { CasStore } from "@sciencediscovery/cas";
import type { ModelInvocationUsage, ModelProfile } from "@sciencediscovery/schema";

for (const apiProtocol of ["openai-chat-completions", "openai-responses", "anthropic-messages"] as const) {
  test(`${apiProtocol}: Swarm gateway and auxiliary callers complete actual protocol round trips without usage`, async () => {
    const provider = await protocolProvider(apiProtocol, { usage: "missing", parallel: true });
    const model: ModelProfile = { id: "synthetic", name: "synthetic", model: "synthetic", baseUrl: provider.baseUrl, apiProtocol, hasApiToken: true, proxyPolicy: "none", vision: true, createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z" };
    const gateway = await startModelGateway({ ...model, apiToken: "synthetic", proxy: { mode: "direct" } }, { maxTokens: 128, maxRetries: 0, requestTimeoutMs: 1000 }, AbortSignal.timeout(10000));
    const dataDir = resolve(".tmp", `protocol-st-${apiProtocol}-${process.pid}`);
    const spend: ModelInvocationUsage[] = [];
    const tokens = new RunTokenRegistry();
    const server = createServer((req, res) => { void handleEvolveCompletion(req, res, "synthetic-run", { tokens, store: {
      getModel: () => model, getModelApiToken: () => "synthetic", resolveProxy: () => ({ mode: "direct" }), appendModelInvocationUsage: async (u: ModelInvocationUsage) => { spend.push(u); },
    } as never }).catch(error => { res.writeHead(500).end(String(error)); }); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    try {
      const postGateway = (messages: unknown[]) => fetch(`${gateway.url}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" }, body: JSON.stringify({ messages, tools: [{ type: "function", function: { name: "compatibility_echo", parameters: { type: "object" } } }] }), signal: AbortSignal.timeout(2000) });
      const initial = [{ role: "system", content: "synthetic system" }, { role: "user", content: "synthetic" }];
      const first = await (await postGateway(initial)).json() as any;
      assert.equal(first.choices[0].finish_reason, "tool_calls");
      assert.equal(first.usage, undefined);
      const assistant = first.choices[0].message;
      const final = await (await postGateway([...initial, assistant, ...assistant.tool_calls.map((c: { id: string }) => ({ role: "tool", tool_call_id: c.id, content: "OK" }))])).json() as any;
      assert.equal(final.choices[0].message.content, "OK");
      assert.equal(final.choices[0].finish_reason, "stop");
      const refined = await generateRefinedSessionTitle({ apiToken: "synthetic", firstMessage: "synthetic", model });
      assert.equal(refined.title, "OK"); assert.equal(refined.usage.totalTokens, null);
      const token = tokens.issue("synthetic-run", "session", model.id);
      const evolve = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/evolve-llm/synthetic-run/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ messages: initial, max_tokens: 128, thinking: { type: "disabled" } }), signal: AbortSignal.timeout(2000) });
      assert.equal(evolve.status, 200); assert.equal((await evolve.json() as any).choices[0].message.content, "OK");
      assert.equal(spend[0]?.usageStatus, "provider-not-reported"); assert.equal(spend[0]?.costUsd, null);
      // Invoke the actual Python sidecar completion client through the authenticated proxy.
      const python = process.env.SCIENCE_TEST_PYTHON ?? "python3";
      await promisify(execFile)(python, ["-c", "import sys; from sciencediscovery_evolve.completion import completion_for; usage=[]; result=completion_for(sys.argv[1],sys.argv[2],max_tokens=128,timeout=2,on_usage=usage.append)('synthetic sidecar request'); assert result == 'OK'; assert usage == []", `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/evolve-llm/synthetic-run/v1/chat/completions`, token], {
        timeout: 5000, env: { ...process.env, PYTHONPATH: [fileURLToPath(new URL("../../evolve/src/", import.meta.url)), process.env.PYTHONPATH].filter(Boolean).join(":") },
      });
      assert.equal(spend.length, 2);

      // Paper vision uses real workspace/CAS persistence and the same HTTP provider, no Python required.
      await mkdir(dataDir, { recursive: true });
      const store = new SessionStore(dataDir); await store.load();
      const saved = await store.createModel({ ...model, apiToken: "synthetic" });
      const project = await store.createProject("Synthetic protocol check");
      const session = await store.createSession(project.id, "Synthetic protocol check", saved.id);
      const ref = await new CasStore(dataDir).put(Buffer.from("synthetic paper"));
      await store.appendPaperAcquisition({ id: "paper", sessionId: session.id, connectorId: "upload", identifier: "synthetic", license: "test", createdAt: model.createdAt, manifest: ref, manifestPath: "papers/paper/manifest.json", pdf: ref, pdfPath: "papers/paper/paper.pdf", status: "succeeded", title: "Synthetic", extraction: { generatedAt: model.createdAt, images: [], inputSha256: ref.hash, limits: {}, pageCount: 1, pages: [{ needsVision: true, page: 1, previewPath: "page.png", textCharacters: 0 }], parser: "fixture", pdfBytes: 5, schemaVersion: 1, tables: [], textCharacters: 0, textPath: "text.txt", warnings: [] } });
      const root = resolve(store.workspacePath(session.id), "papers/paper"); await mkdir(root, { recursive: true }); await writeFile(resolve(root, "page.png"), Buffer.from("synthetic image"));
      const service = new PaperService(store, "unused", "unused");
      const run = await service.analyzeVision({ modelId: saved.id, paperId: "paper", sessionId: session.id });
      const runs = await store.listPaperVisionRuns(session.id);
      assert.equal(runs.length, 1); assert.equal(runs[0]!.status, "succeeded"); assert.equal(runs[0]!.modelUsage, undefined);
      assert.match(await readFile(resolve(store.workspacePath(session.id), runs[0]!.resultPath), "utf8"), /OK/);
      const imageRequest = provider.requests.at(-1)!;
      assert.match(JSON.stringify(imageRequest.body), apiProtocol === "anthropic-messages" ? /media_type/ : apiProtocol === "openai-responses" ? /input_image/ : /image_url/);
      assert.ok(run);
    } finally {
      await gateway.close(); await provider.close(); tokens.revoke("synthetic-run");
      await new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); });
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}
