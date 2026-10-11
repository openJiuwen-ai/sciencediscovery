// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { requireRealEnv, requireRealStack, test } from './helpers/e2e.ts';
import { cleanupJourney, createProjectAndSession, openProjectSession, sendUserMessage, waitForRunTerminal } from './helpers/journeys.ts';
import { drbApi } from './helpers/deepresearchbench.ts';
import { collectFinalDelivery } from './helpers/real-delivery.ts';
import { apiBaseUrl, authorizationHeader } from './e2e-auth.js';
import { realApiProxy } from './helpers/real-api-proxy.mjs';

const scenarios = [
  ['response', 'Short response and stream completion'],
  ['tool', 'Tool result reaches the final answer'],
  ['memory', 'A follow-up recalls the previous turn'],
  ['artifact', 'A delivered version remains readable after follow-up'],
  ['dependency', 'The second tool consumes the first result'],
  ['structured', 'Structured tool arguments preserve numeric types'],
  ['cancel', 'Cancel a live run and continue the session'],
] as const;

async function api(page: Page, path: string, method: string, data?: unknown) {
  const response = await page.request.fetch(`${apiBaseUrl()}${path}`, { headers: authorizationHeader(), method, ...(data === undefined ? {} : {data}) });
  expect(response.ok(), `${method} ${path}: HTTP ${response.status()}`).toBe(true);
  return response.json();
}

for (const [id,title] of scenarios) {
/**
 * E2E-META
 * Purpose: Verify one short backend-independent real model/API contract through the running product.
 * Steps:
 *   1. Check credentials and the isolated stack; create a temporary real-model Session.
 *   2. Submit the selected basic task, observe completion or cancellation and verify its durable result.
 *   3. Read usage, save the shared usage ledger, and remove the owned records.
 * Environment: Isolated product stack selected by CI_E2E_BACKEND; standard fixture, local MCP echo server and a basic project with optional skill/plan/scheduler plugins disabled.
 * Type: real
 * LLM: Real OpenAI-compatible endpoint behind a metered pass-through; no model stub or AI judge.
 * WebSearch: none requested
 * PaperSources: none
 * MCP: Local deterministic echo/add_numbers tools; standard workspace tools for artifact delivery.
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
    let mcp: string | undefined;
    try {
      await journey.step('Prepare the selected product backend', 'A new Session uses the real model and owns all its records', async () => {
        fixture = await createProjectAndSession(page, {approvalMode:'always_allow',projectName:`Basic ${id} ${randomUUID()}`,sessionTitle:title,
          model:{baseUrl:proxy.baseUrl,apiToken:proxy.token,model:real.E2E_LLM_MODEL!,name:`Basic ${id}`,apiVariant:'openai'}});
        // These short contracts need workspace/MCP tools, not the research
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
      const submit = async (prompt: string) => {
        const run = await sendUserMessage(page,fixture!.session.id,`${prompt} Keep the final answer brief. Do not delegate or use web search.`);
        const terminal = await waitForRunTerminal(page,fixture!.session.id,run.id,120_000);
        expect(terminal.status,terminal.error).toBe('completed');
        return {run,delivery:await collectFinalDelivery(page,fixture!.session.id,run.id)};
      };
      await journey.step('Complete the basic user task', title, async () => {
        const marker = `probe-${randomUUID().slice(0,8)}`;
        if (['tool','dependency','structured'].includes(id)) {
          const server = await api(page,'/api/mcp/servers','POST',{name:`Basic tools ${marker}`,command:process.execPath,
            args:[fileURLToPath(new URL('./fixtures/mcp-echo.mjs',import.meta.url))],enabled:true});
          mcp = server.id;
          // Connector inventory is loaded with the Session; refresh after a
          // server is created through the API, as a user reopening it would.
          await page.reload();
          await openProjectSession(page,fixture!);
          await page.locator('.connector-picker-trigger').click();
          const connector = page.locator('.connector-picker-popover').getByRole('checkbox',{name:new RegExp(`Basic tools ${marker}`)});
          await connector.click();
          await expect(connector).toBeChecked();
          await page.keyboard.press('Escape');
          const prompt = id === 'tool' ? `Use the selected local MCP echo tool on ${marker}, then report exactly the tool's uppercase result.`
            : id === 'dependency' ? 'Use the selected local MCP add_numbers tool on 7 and 11. After receiving its result, call add_numbers again with that result and 13, then report the second result.'
            : 'Use the selected local MCP add_numbers tool with JSON arguments a=17 and b=25 (numbers, not strings). Report the returned sum.';
          const {delivery} = await submit(prompt);
          expect(delivery.answer).toContain(id === 'tool' ? marker.toUpperCase() : id === 'dependency' ? '31' : '42');
          const invocations = await drbApi<any[]>(page,`${prefix}/mcp/invocations`);
          expect(invocations.filter(v=>v.sourceId===mcp && v.status==='succeeded').length).toBeGreaterThanOrEqual(id==='dependency'?2:1);
          const messages = proxy.requests.flatMap((r:any)=>r.messages ?? []);
          const calls = messages.flatMap((m:any)=>m.tool_calls ?? []).filter((c:any)=>c.function?.name?.includes('mcp__'));
          expect(calls.length).toBeGreaterThan(0);
          if (id==='structured') expect(calls.some((c:any)=>{const a=JSON.parse(c.function.arguments);return a.a===17&&a.b===25;})).toBe(true);
          if (id==='dependency') {
            // Inspect one complete model context: the second call must follow
            // the first tool's delivered result, not two independent calls.
            expect(proxy.requests.some((r:any)=>{
              const ms=r.messages ?? [];
              return ms.some((m:any,i:number)=>(m.tool_calls??[]).some((c:any)=>{
                const a=JSON.parse(c.function.arguments);return a.a===18&&a.b===13;
              }) && ms.slice(0,i).some((prior:any)=>prior.role==='tool'&&String(prior.content).includes('18')));
            })).toBe(true);
          }
        } else if (id==='memory') {
          await submit(`Remember the code ${marker}. Just acknowledge it.`);
          const {delivery}=await submit('What code did I give you in the preceding message?');
          expect(delivery.answer).toContain(marker);
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
          const run=await sendUserMessage(page,fixture!.session.id,'Write a long numbered list of 500 distinct scientific terms. Do not use tools.');
          await expect.poll(()=>proxy.requests.some((r:any)=>r.stream&&r.responseChunks>0),{timeout:60_000}).toBe(true);
          await api(page,`${prefix}/runs/${run.id}/cancel`,'POST',{});
          expect((await waitForRunTerminal(page,fixture!.session.id,run.id,30_000)).status).toBe('cancelled');
          expect((await submit('Reply with the word READY.')).delivery.answer).toContain('READY');
          expect((await drbApi<any[]>(page,`${prefix}/runs`)).filter(r=>['queued','running'].includes(r.status))).toHaveLength(0);
        } else {
          const {run,delivery}=await submit('Reply with the word READY. Do not call tools.');
          expect(delivery.answer).toContain('READY');
          expect(proxy.requests.some((r:any)=>r.stream===true)).toBe(true);
          const events=await drbApi<any[]>(page,`${prefix}/runs/${run.id}/events`);
          expect(JSON.stringify(events)).toContain('run.completed');
        }
      });
      await journey.step('Verify usage and persist cost evidence', 'The product reports invocations and the shared request ledger remains available', async () => {
        const usage=await drbApi<any>(page,`${prefix}/usage`);
        expect(usage.totals.invocationCount).toBeGreaterThan(0);
        await info.attach('real-api-usage',{body:JSON.stringify(usage),contentType:'application/json'});
      });
    } finally {
      try {
        if (fixture) {
          await page.request.post(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/runs/current/cancel`,{headers:authorizationHeader(),data:{}}).catch(()=>undefined);
          await cleanupJourney(page,fixture);
        }
      } finally {
        try { if (mcp) await page.request.delete(`${apiBaseUrl()}/api/mcp/servers/${mcp}`,{headers:authorizationHeader()}); }
        finally {
          await proxy.stop();
          // Keep cost evidence for failures too, including cancelled or unreported calls.
          try { await info.attach('real-api-ledger',{body:readFileSync(ledger),contentType:'application/json'}); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
    }
  });
}
