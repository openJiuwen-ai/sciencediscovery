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
    const previousBudget = process.env.SCIENCE_AGENT_LLM_MAX_TOKENS;
    process.env.SCIENCE_AGENT_LLM_MAX_TOKENS = "128";
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
      // This client uses only the standard library. ST runs independently of UT,
      // whose SCIENCE_TEST_PYTHON points at a service venv that ST does not create.
      await promisify(execFile)("python3", ["-c", "import sys; from sciencediscovery_evolve.completion import completion_for; usage=[]; result=completion_for(sys.argv[1],sys.argv[2],max_tokens=128,timeout=2,on_usage=usage.append)('synthetic sidecar request'); assert result == 'OK'; assert usage == []", `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/evolve-llm/synthetic-run/v1/chat/completions`, token], {
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
      assert.equal(apiProtocol === "openai-responses" ? imageRequest.body.max_output_tokens : imageRequest.body.max_tokens, 128);
    } finally {
      if (previousBudget === undefined) delete process.env.SCIENCE_AGENT_LLM_MAX_TOKENS; else process.env.SCIENCE_AGENT_LLM_MAX_TOKENS = previousBudget;
      await gateway.close(); await provider.close(); tokens.revoke("synthetic-run");
      await new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); });
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}

for (const responseKind of ['invalid-shape', 'truncated-hidden-reasoning', 'transient-provider-error', 'truncated-idea-stage'] as const) test(`${responseKind}: real Python clients preserve model classification and never retry deterministic shape failures`, async () => {
  let upstreamCalls = 0;
  const provider = createServer(async (req, res) => {
    for await (const _ of req) {}
    upstreamCalls++;
    const status = responseKind === 'transient-provider-error' && upstreamCalls === 1 ? 503 : 200;
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(status === 503 ? { error: 'original temporary provider cause' } : responseKind === 'invalid-shape' ? {} : {
      choices: [{ message: { role: 'assistant', content: responseKind.startsWith('truncated-') ? null : 'OK' }, finish_reason: responseKind.startsWith('truncated-') ? 'length' : 'stop' }],
      ...(responseKind.startsWith('truncated-') ? { usage: { prompt_tokens: 6, completion_tokens: 8, total_tokens: 14 } } : {}),
    }));
  });
  await new Promise<void>(r => provider.listen(0, '127.0.0.1', r));
  const tokens = new RunTokenRegistry(), token = tokens.issue('synthetic', 'session', 'model');
  const spend: ModelInvocationUsage[] = [];
  const proxy = createServer((req, res) => void handleEvolveCompletion(req, res, 'synthetic', { tokens, store: {
    getModel: () => ({ id: 'model', name: 'synthetic', model: 'synthetic', baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, apiProtocol: 'openai-chat-completions' }),
    getModelApiToken: () => 'synthetic', resolveProxy: () => ({ mode: 'direct' }), appendModelInvocationUsage: async (u: ModelInvocationUsage) => { spend.push(u); },
  } as never }).catch(error => res.writeHead(500).end(String(error))));
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  try {
    const script = responseKind === 'truncated-idea-stage'
      ? `import asyncio,tempfile; from pathlib import Path; from sciencediscovery_idea_tree.research import IdeaTreeEngine,ResearchStore,node,now
async def run():
 with tempfile.TemporaryDirectory() as folder:
  state=dict(id='r',projectId='p',sessionId='s',objective='Synthetic',materials='',modelId='m',settings=dict(maxTokensPerCall=8,maxTokens=100000),status='paused',phase='design',round=0,tokens=0,usageKnown=True,currentNodeId=None,nodes=[node('ROOT',None,'Goal','direction',0)],createdAt=now(),updatedAt=now())
  store=ResearchStore(Path(folder)); engine=IdeaTreeEngine(state,store,dict(url=sys.argv[1],token=sys.argv[2]))
  try: await engine.ask('design',{})
  except ValueError as e: assert 'empty or truncated model output' in str(e)
  else: raise AssertionError('Empty stage succeeded')
  persisted=store.read('p','s','r'); assert persisted['tokens']==14 and engine.reserved==0 and persisted['activities'][-1]['status']=='failed'
asyncio.run(run())`
      : responseKind === 'truncated-hidden-reasoning'
      ? "from sciencediscovery_evolve.completion import completion_for; usage=[]; failures=[]; result=completion_for(sys.argv[1],sys.argv[2],max_tokens=8,timeout=2,on_usage=usage.append)('synthetic',on_failure=failures.append); assert result == ''; assert failures == []; assert len(usage)==1 and usage[0].total==14 and usage[0].completion==8 and usage[0].capped"
      : "from pathlib import Path; from sciencediscovery_idea_tree.research import IdeaTreeEngine,ResearchStore; engine=IdeaTreeEngine({},ResearchStore(Path('.tmp')),dict(url=sys.argv[1],token=sys.argv[2])); " + (responseKind === 'invalid-shape'
        ? "\ntry: engine.transport('synthetic',{},64)\nexcept RuntimeError as error: assert 'Model HTTP 422' in str(error) and 'Invalid Chat completion response' in str(error)\nelse: raise AssertionError('Malformed provider response was accepted')"
        : "assert engine.transport('synthetic',{},64) == ('OK',None)");
    await promisify(execFile)('python3', ['-c', 'import sys; '+script, `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/internal/evolve-llm/synthetic/v1/chat/completions`, token], {
      timeout: 5000, env: { ...process.env, PYTHONPATH: [fileURLToPath(new URL('../../evolve/src/', import.meta.url)), fileURLToPath(new URL('../../idea-tree/src/', import.meta.url))].join(':') },
    });
    assert.equal(upstreamCalls, responseKind === 'transient-provider-error' ? 2 : 1);
    if (responseKind === 'invalid-shape') assert.equal(spend.length, 0, 'No reported counts or zero cost may be invented for a rejected body');
    else if (responseKind.startsWith('truncated-')) assert.equal(spend[0]?.outputTokens, 8);
    else assert.equal(spend[0]?.usageStatus, 'provider-not-reported');
  } finally {
    tokens.revoke('synthetic');
    for (const server of [proxy, provider]) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  }
});

for (const kind of ['server', 'server-type', 'server-exhausted', 'client', 'unknown'] as const) test(`${kind}: reported native Responses errors preserve cause and existing bounded retry`, async () => {
  let calls = 0;
  const provider = createServer(async (req, res) => {
    for await (const _ of req) {}
    calls++;
    const failed = kind === 'server-exhausted' || calls === 1;
    const error = kind === 'server-type' ? { type: 'server_error' } : { code: kind.startsWith('server') ? 'server_error' : kind === 'client' ? 'invalid_request_error' : 'unknown_error' };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(failed
      ? { object: 'response', status: 'failed', output: [], error: { ...error, message: 'original native cause' } }
      : { object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }));
  });
  await new Promise<void>(r => provider.listen(0, '127.0.0.1', r));
  const tokens = new RunTokenRegistry(), token = tokens.issue('native-error', 'session', 'model');
  const spend: ModelInvocationUsage[] = [];
  const proxy = createServer((req, res) => void handleEvolveCompletion(req, res, 'native-error', { tokens, store: {
    getModel: () => ({ id: 'model', name: 'synthetic', model: 'synthetic', baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, apiProtocol: 'openai-responses' }),
    getModelApiToken: () => 'local-key', resolveProxy: () => ({ mode: 'direct' }), appendModelInvocationUsage: async (u: ModelInvocationUsage) => { spend.push(u); },
  } as never }).catch(error => res.writeHead(500).end(String(error))));
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  try {
    const success = kind === 'server' || kind === 'server-type';
    const status = kind === 'client' ? 400 : kind === 'unknown' ? 422 : 502;
    const script = "from pathlib import Path; from sciencediscovery_idea_tree.research import IdeaTreeEngine,ResearchStore; engine=IdeaTreeEngine({},ResearchStore(Path('.tmp')),dict(url=sys.argv[1],token=sys.argv[2])); " + (success
      ? "assert engine.transport('synthetic',{},64) == ('OK',None)"
      : `\ntry: engine.transport('synthetic',{},64)\nexcept RuntimeError as error: assert 'Model HTTP ${status}' in str(error) and 'original native cause' in str(error)\nelse: raise AssertionError('Provider error accepted')`);
    const address = proxy.address();
    assert.ok(address && typeof address !== 'string');
    await promisify(execFile)('python3', ['-c', 'import sys; '+script, `http://127.0.0.1:${address.port}`, token], { timeout: 5000, env: { ...process.env, PYTHONPATH: [fileURLToPath(new URL('../../evolve/src/', import.meta.url)), fileURLToPath(new URL('../../idea-tree/src/', import.meta.url))].join(':') } });
    assert.equal(calls, kind.startsWith('server') ? 2 : 1);
    assert.ok(spend.every(u => u.usageStatus === 'provider-not-reported'));
  } finally {
    tokens.revoke('native-error');
    for (const server of [proxy, provider]) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  }
});
