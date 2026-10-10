// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// One serialized basic shard owns this ledger, including Playwright worker
// restarts after a failure. Reserve input payload bytes as a conservative
// token allowance, then refund against actual provider usage when reported.
// Cancelled/unreported calls keep their reservation; they never count as free.
export function reserveRequest(path, body) {
  const used = existsSync(path) ? JSON.parse(readFileSync(path)) : { requests: 0, inputBytes: 0, reservedInputTokens: 0, reservedOutputTokens: 0, unreportedCalls: 0 };
  const inputBytes = Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools }));
  const output = Math.min(1024, 20_000 - used.reservedOutputTokens);
  if (used.exceeded || used.requests >= 24 || used.reservedInputTokens + inputBytes > 300_000 || output <= 0) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...used, rejectedRequests: (used.rejectedRequests ?? 0) + 1, lastRejection: 'REAL_API_BUDGET_EXHAUSTED' }));
    throw new Error('REAL_API_BUDGET_EXHAUSTED');
  }
  const next = { ...used, requests: used.requests + 1, inputBytes: used.inputBytes + inputBytes,
    reservedInputTokens: used.reservedInputTokens + inputBytes, reservedOutputTokens: used.reservedOutputTokens + output, unreportedCalls: used.unreportedCalls + 1 };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next));
  return { used: next, inputAllowance: inputBytes, maxTokens: output };
}

export function settleRequest(path, reservation, usage) {
  const input=usage?.prompt_tokens ?? usage?.input_tokens;
  const output=usage?.completion_tokens ?? usage?.output_tokens;
  if (![input,output].every(v=>Number.isSafeInteger(v)&&v>=0)) return;
  const used=JSON.parse(readFileSync(path));
  used.reservedInputTokens += input-reservation.inputAllowance;
  used.reservedOutputTokens += output-reservation.maxTokens;
  used.unreportedCalls--;
  used.exceeded ||= used.reservedInputTokens>300_000 || used.reservedOutputTokens>20_000;
  writeFileSync(path,JSON.stringify(used));
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
      const decoder=new TextDecoder();let pending='',usage;
      const parse=line=>{try { const value=JSON.parse(line.replace(/^data:\s*/,''));if(value.usage)usage=value.usage; } catch { /* SSE markers/partial records. */ }};
      for await (const chunk of result.body ?? []) {
        captured.responseChunks++;response.write(chunk);
        pending+=decoder.decode(chunk,{stream:true});
        if (result.headers.get('content-type')?.includes('text/event-stream')) {
          const lines=pending.split('\n');pending=lines.pop();for(const line of lines)parse(line);
        }
        if(pending.length>1_000_000) throw new Error('Provider response exceeds budget');
      }
      parse(pending+decoder.decode());
      settleRequest(ledger,reservation,usage);
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
