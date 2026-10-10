// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// One serialized basic shard owns this ledger, including Playwright worker
// restarts after a failure. Count retries as requests. Input bytes are a
// conservative payload budget, not a claim of provider token measurement.
export function reserveRequest(path, body) {
  const used = existsSync(path) ? JSON.parse(readFileSync(path)) : { requests: 0, inputBytes: 0, reservedOutputTokens: 0 };
  const inputBytes = Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools }));
  const output = Math.min(1024, 20_000 - used.reservedOutputTokens);
  if (used.requests >= 24 || used.inputBytes + inputBytes > 300_000 || output <= 0) throw new Error('REAL_API_BUDGET_EXHAUSTED');
  const next = { requests: used.requests + 1, inputBytes: used.inputBytes + inputBytes, reservedOutputTokens: used.reservedOutputTokens + output };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next));
  return { used: next, maxTokens: output };
}

/** A bounded pass-through to the configured real provider, never a model stub. */
export async function realApiProxy({ baseUrl, token, ledger }) {
  const upstream = new URL(`${baseUrl.replace(/\/$/, '')}/chat/completions`);
  if (!['http:', 'https:'].includes(upstream.protocol)) throw new Error('Invalid model endpoint');
  const localToken = randomUUID();
  const requests = [], controllers = new Set();
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.headers.authorization !== `Bearer ${localToken}`) {
      response.writeHead(403).end(); return;
    }
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 120_000);
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      let text = '';
      for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 300_000) throw new Error('REAL_API_PAYLOAD_TOO_LARGE'); }
      const body = JSON.parse(text);
      const reservation = reserveRequest(ledger, body);
      body.max_tokens = reservation.maxTokens;
      delete body.max_completion_tokens;
      const captured={ messages: body.messages, tools: body.tools, stream: body.stream, responseChunks: 0 };
      requests.push(captured);
      const result = await fetch(upstream, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
      response.writeHead(result.status, { 'content-type': result.headers.get('content-type') ?? 'application/json' });
      for await (const chunk of result.body ?? []) { captured.responseChunks++; response.write(chunk); }
      response.end();
    } catch {
      // Neither a provider response nor its URL/token belongs in diagnostics.
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Real API transport or budget failed; inspect the budget ledger and provider availability' } }));
    } finally { clearTimeout(timer); controllers.delete(controller); }
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, token: localToken, requests,
    stop: async () => { for (const controller of controllers) controller.abort(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); } };
}
