// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { requireRealEnv, requireRealStack, test } from './helpers/e2e.ts';
import { cleanupJourney, createProjectAndSession, openProjectSession, sendUserMessage, waitForRunTerminal } from './helpers/journeys.ts';
import { drbApi } from './helpers/deepresearchbench.ts';
import { collectFinalDelivery } from './helpers/real-delivery.ts';
import { apiBaseUrl, authorizationHeader } from './e2e-auth.js';
import { realApiProxy } from './helpers/real-api-proxy.mjs';

// Adapted scenarios, implemented through ScienceDiscovery's public product APIs.
// See .ci/README.md for the upstream reference and the observable contracts.
const scenarios = [
  ['response', 'Short response and stream completion'],
  ['tool', 'A real command result reaches the final answer'],
  ['files', 'Read and edit a workspace file without changing its neighbour'],
  ['memory', 'Reopen a Session and recall its previous turn'],
  ['artifact', 'A delivered version remains readable after follow-up'],
  ['workspace', 'Relative file writes stay in the selected Session'],
  ['cancel', 'Cancel a live run and continue the session'],
] as const;

async function api(page: Page, path: string, method: string, data?: unknown) {
  const response = await page.request.fetch(`${apiBaseUrl()}${path}`, { headers: authorizationHeader(), method, ...(data === undefined ? {} : {data}) });
  expect(response.ok(), `${method} ${path}: HTTP ${response.status()}`).toBe(true);
  return response.json();
}

async function uploadFile(page: Page, sessionId: string, name: string, text: string) {
  const response = await page.request.post(`${apiBaseUrl()}/api/sessions/${sessionId}/workspace/upload`, {
    headers: authorizationHeader(),
    multipart: { files: { name, mimeType: 'text/plain', buffer: Buffer.from(text) } },
  });
  expect(response.status()).toBe(201);
  const result = await response.json();
  expect(result.errors).toEqual([]);
  expect(result.uploaded.some((file: { path: string }) => file.path === name)).toBe(true);
}

async function readFile(page: Page, sessionId: string, name: string) {
  const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${sessionId}/file?path=${encodeURIComponent(name)}`, {
    headers: authorizationHeader(),
  });
  expect(response.ok(), `read workspace file ${name}: HTTP ${response.status()}`).toBe(true);
  return response.text();
}

for (const [id,title] of scenarios) {
/**
 * E2E-META
 * Purpose: Verify one short backend-independent real model/API contract through the running product.
 * Steps:
 *   1. Check credentials and the isolated stack; create a temporary real-model Session.
 *   2. Submit the selected basic task, observe completion or cancellation and verify its durable result.
 *   3. Read usage, save the shared usage ledger, and remove the owned records.
 * Environment: Isolated product stack selected by CI_E2E_BACKEND; standard fixture and a basic project with optional skill/plan/scheduler plugins disabled.
 * Type: real
 * LLM: Real OpenAI-compatible endpoint behind a metered pass-through; no model stub or AI judge.
 * WebSearch: none requested
 * PaperSources: none
 * MCP: No external connector; backend-selected product workspace and shell tools.
 * OtherExternal: Configured model endpoint only; local API, browser and Runner.
 * Credentials: E2E_API_TOKEN, E2E_LLM_BASE_URL, E2E_LLM_MODEL, E2E_LLM_TOKEN.
 * CostSideEffects: Billable model calls with no suite request/token cap; reported usage and unreported calls are recorded. Temporary records removed in finally.
 */
  test(`L3-${id}: ${title}`, { tag: ['@real','@category:e2e','@os:linux','@arch:amd64','@model:real','@tier:l3','@sandbox:bubblewrap'] }, async ({page,journey}, info) => {
    test.setTimeout(180_000);
    journey.scenario({ goal: title, preconditions: ['Isolated selected backend', 'Real OpenAI-compatible model', 'Shared basic API usage ledger'] });
    const real = requireRealEnv(info,'E2E_LLM_BASE_URL','E2E_LLM_MODEL','E2E_LLM_TOKEN');
    await requireRealStack(info);
    const ledger = resolve(process.env.CI_RUNTIME_DIR ?? '.e2e-data', 'basic-api-usage.json');
    const proxy = await realApiProxy({baseUrl:real.E2E_LLM_BASE_URL,token:real.E2E_LLM_TOKEN,ledger});
    let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
    try {
      await journey.step('Prepare the selected product backend', 'A new Session uses the real model and owns all its records', async () => {
        fixture = await createProjectAndSession(page, {approvalMode:'always_allow',projectName:`Basic ${id} ${randomUUID()}`,sessionTitle:title,
          model:{baseUrl:proxy.baseUrl,apiToken:proxy.token,model:real.E2E_LLM_MODEL!,name:`Basic ${id}`,apiVariant:'openai'}});
        // These short contracts need workspace tools, not the research
        // skill catalog or delegation. Configure the owned Project through
        // the public product API, identically for either execution backend.
        const plugins = `/api/projects/${fixture.project.id}/plugins`;
        const baseline = await api(page,plugins,'GET');
        await api(page,`${plugins}/bridge`,'POST',{apiVersion:1,pluginId:'host.settings',scope:{projectId:fixture.project.id},kind:'command',method:'replace',
          input:{expectedRevision:baseline.revision,overrides:{...baseline.settings.overrides,
            plugins:Object.fromEntries(['skill','plan','scheduler'].map(name=>[name,{enabled:false}]))}}});
        await api(page,`/api/sessions/${fixture.session.id}`,'PATCH',{
          skillSelectionMode:'selected',enabledSkillIds:[],enabledSkillLibraries:[],enabledConnectorIds:[],specialistId:null,
        });
        await openProjectSession(page,fixture);
      });
      const prefix = `/api/sessions/${fixture!.session.id}`;
      const completedRuns: string[] = [];
      const submit = async (prompt: string) => {
        const run = await sendUserMessage(page,fixture!.session.id,`${prompt} Keep the final answer brief. Do not delegate or use web search.`);
        const terminal = await waitForRunTerminal(page,fixture!.session.id,run.id,120_000);
        expect(terminal.status,terminal.error).toBe('completed');
        completedRuns.push(run.id);
        return {run,delivery:await collectFinalDelivery(page,fixture!.session.id,run.id)};
      };
      await journey.step('Complete the basic user task', title, async () => {
        const marker = `probe-${randomUUID().slice(0,8)}`;
        if (id === 'tool') {
          // The prompt does not contain the secret marker: only a successful
          // tool read can supply it to the model's final answer.
          await uploadFile(page, fixture!.session.id, 'command-input.txt', `${marker}\n`);
          const firstRequest = proxy.requests.length;
          const {delivery} = await submit('Use run_shell to execute cat command-input.txt in the Session workspace. Wait for execution completion if needed, then report the exact output.');
          expect(delivery.answer).toContain(marker);
          const messages = proxy.requests.slice(firstRequest).flatMap((request: any) => request.messages ?? []);
          expect(messages.some((message: any) => (message.tool_calls ?? []).some((call: any) =>
            call.function?.name?.includes('run_shell')))).toBe(true);
          expect(messages.some((message: any) => message.role === 'tool'
            && JSON.stringify(message.content).includes(marker))).toBe(true);
        } else if (id === 'files') {
          const original = `code=${marker}\nstatus=draft\n`;
          const untouched = `KEEP-${randomUUID()}\n`;
          await uploadFile(page, fixture!.session.id, 'note.txt', original);
          await uploadFile(page, fixture!.session.id, 'untouched.txt', untouched);
          const {delivery} = await submit('Read note.txt. Replace only status=draft with status=final, preserving all other bytes. Read it back, then report its code value. Do not change untouched.txt.');
          expect(delivery.answer).toContain(marker);
          expect(await readFile(page, fixture!.session.id, 'note.txt')).toBe(original.replace('status=draft', 'status=final'));
          expect(await readFile(page, fixture!.session.id, 'untouched.txt')).toBe(untouched);
        } else if (id === 'memory') {
          await submit(`Remember the code ${marker}. Just acknowledge it.`);
          // Reopen through the product and verify stored history before the
          // next model request. This covers client reconnection, not a server restart.
          await page.goto('about:blank');
          await openProjectSession(page, fixture!);
          const session = await drbApi<any>(page, prefix);
          expect(JSON.stringify(session.messages)).toContain(marker);
          const firstRequest = proxy.requests.length;
          const {delivery} = await submit('What code did I give you in the preceding message? Do not use tools.');
          expect(delivery.answer).toContain(marker);
          expect(proxy.requests.slice(firstRequest).some((request: any) =>
            JSON.stringify(request.messages).includes(marker))).toBe(true);
        } else if (id === 'workspace') {
          const neighbour = await api(page, `/api/projects/${fixture!.project.id}/sessions`, 'POST', {
            title: 'Untouched workspace', modelId: fixture!.model!.id,
          });
          const untouched = `NEIGHBOUR-${randomUUID()}\n`;
          await uploadFile(page, neighbour.id, 'where.txt', untouched);
          await uploadFile(page, fixture!.session.id, 'where.txt', 'before\n');
          await openProjectSession(page, fixture!);
          await submit(`Replace where.txt in this Session workspace with exactly ${marker} followed by a newline. Use a relative path and read the file back.`);
          expect(await readFile(page, fixture!.session.id, 'where.txt')).toBe(`${marker}\n`);
          expect(await readFile(page, neighbour.id, 'where.txt')).toBe(untouched);
        } else if (id==='artifact') {
          const {delivery}=await submit(`Use workspace tools to write ${marker}.md containing the text ${marker}, declare it as an artifact and give its filename.`);
          expect(delivery.status).toBe('passed');
          const artifact=delivery.artifacts.find(a=>a.logicalName.endsWith(`${marker}.md`));
          expect(artifact).toBeDefined();
          expect(artifact!.text).toContain(marker);
          await submit('Acknowledge the delivery without changing any files.');
          const response=await page.request.get(`${apiBaseUrl()}${prefix}/artifact-versions/${artifact!.version}/content`,{headers:authorizationHeader()});
          expect(response.ok()).toBe(true);
          expect(await response.text()).toBe(artifact!.text);
          await page.reload();
          await openProjectSession(page,fixture!);
          expect((await drbApi<any[]>(page,`${prefix}/artifacts`)).some(a=>a.id===artifact!.id)).toBe(true);
        } else if (id==='cancel') {
          const firstRequest = proxy.requests.length;
          const run=await sendUserMessage(page,fixture!.session.id,'Write a long numbered list of 500 distinct scientific terms. Do not use tools.');
          // Exclude auxiliary title requests: only the agent request carries tools.
          await expect.poll(()=>proxy.requests.slice(firstRequest).some((r:any)=>r.tools?.length && r.stream && r.contentDeltas>0),{timeout:60_000}).toBe(true);
          await api(page,`${prefix}/runs/${run.id}/cancel`,'POST',{});
          expect((await waitForRunTerminal(page,fixture!.session.id,run.id,30_000)).status).toBe('cancelled');
          expect((await submit('Reply with the word READY.')).delivery.answer).toContain('READY');
          expect((await drbApi<any[]>(page,`${prefix}/runs`)).filter(r=>['queued','running'].includes(r.status))).toHaveLength(0);
        } else {
          const {run,delivery}=await submit('Reply with the word READY. Do not call tools.');
          expect(delivery.answer).toContain('READY');
          expect(proxy.requests.some((r:any)=>r.tools?.length && r.stream===true && r.contentDeltas>0 && r.finishReasons.includes('stop'))).toBe(true);
          const events=await drbApi<any[]>(page,`${prefix}/runs/${run.id}/events`);
          expect(JSON.stringify(events)).toContain('run.completed');
        }
      });
      await journey.step('Verify usage and persist cost evidence', 'The product reports invocations and the shared request ledger remains available', async () => {
        const usage=await drbApi<any>(page,`${prefix}/usage`);
        expect(usage.totals.invocationCount).toBeGreaterThan(0);
        // A title-generation call must not hide missing usage for the actual Run.
        for (const runId of completedRuns) {
          const runUsage = usage.byRun.find((entry: {key: string}) => entry.key === runId);
          expect(runUsage, `reported usage for completed Run ${runId}`).toBeDefined();
          expect(runUsage.inputTokens).toBeGreaterThan(0);
          expect(runUsage.outputTokens).toBeGreaterThan(0);
        }
        await info.attach('real-api-usage',{body:JSON.stringify(usage),contentType:'application/json'});
      });
    } finally {
      try {
        if (fixture) {
          await page.request.post(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/runs/current/cancel`, {
            headers: authorizationHeader(), data: {},
          }).catch(() => undefined);
          await cleanupJourney(page, fixture);
        }
      } finally {
        await proxy.stop();
        // Keep cost evidence for failures too, including cancelled or unreported calls.
        try { await info.attach('real-api-ledger', {body: readFileSync(ledger), contentType: 'application/json'}); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
  });
}
