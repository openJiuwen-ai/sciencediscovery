// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { test, requireRealEnv, requireRealStack } from './helpers/e2e.ts';
import { createProjectAndSession, cleanupJourney, openProjectSession, sendUserMessage, waitForRunTerminal } from './helpers/journeys.ts';
import { apiBaseUrl, authorizationHeader } from './e2e-auth.js';
import { collectFinalDelivery } from './helpers/real-delivery.ts';
import { realApiProxy } from './helpers/real-api-proxy.mjs';
import { unavailableRunner } from './fixtures/unavailable-runner.mjs';

async function api(page: Page, path: string, method = 'GET', data?: unknown): Promise<any> {
  const response = await page.request.fetch(`${apiBaseUrl()}${path}`, { method, headers:authorizationHeader(), ...(data === undefined ? {} : {data}) });
  expect(response.ok(), `${method} ${path}: HTTP ${response.status()}`).toBe(true);
  return response.json();
}

// Examine what was actually sent back to the model, not just the visible UI.
function protocol(requests: any[]) {
  const messages = requests.flatMap(request => request.messages ?? []);
  const calls = [...new Map<string, any>(messages.flatMap(message => message.tool_calls ?? []).map(call => [call.id, call])).values()];
  return {calls, results:messages.filter(message => message.role === 'tool')};
}

for (const wait of [true, false]) {
  /**
   * E2E-META
   * Purpose: A real model autonomously chooses whether Runner failure requires a user-wait card.
   * Steps:
   *   1. Register an isolated real Runner with a missing sandbox executable and restrict a temporary Session to it.
   *   2. Submit natural language without tool names; observe either an explicit wait card or a final explanation.
   *   3. Cancel the waiting operation through the browser, verify the choice reaches the model and no code is dispatched, and save evidence.
   * Environment: Isolated selected product backend, real browser, temporary real Runner with controlled dependency failure.
   * Type: real
   * LLM: Real OpenAI-compatible API via metered pass-through; no scripted model, tool-choice override or judge.
   * WebSearch: none requested
   * PaperSources: none
   * MCP: none
   * OtherExternal: Configured model endpoint only; all Runner faults are local.
   * Credentials: E2E_API_TOKEN, E2E_LLM_BASE_URL, E2E_LLM_MODEL, E2E_LLM_TOKEN.
   * CostSideEffects: Billable short model interaction, bounded test deadline, no automatic retries. Usage and failure traces retained; owned records removed in finally.
   */
  test(`L3-runner-${wait ? 'wait' : 'finish'}: real model ${wait ? 'requests user help and resumes after cancellation' : 'honors the request to explain failure without waiting'}`,
    {tag:['@real','@category:e2e','@os:linux','@arch:amd64','@model:real','@tier:l3','@sandbox:bubblewrap']}, async ({page, journey}, info) => {
    test.setTimeout(240_000);
    const real = requireRealEnv(info, 'E2E_LLM_BASE_URL', 'E2E_LLM_MODEL', 'E2E_LLM_TOKEN');
    await requireRealStack(info);
    journey.scenario({goal:'The model decides whether to wait; the framework never implicitly opens a card or replays code', preconditions:['Real model', 'Disposable API stack', 'Isolated unavailable Runner']});
    const ledger = info.outputPath('runner-recovery-usage.json');
    const proxy = await realApiProxy({baseUrl:real.E2E_LLM_BASE_URL,token:real.E2E_LLM_TOKEN,ledger});
    let runner: Awaited<ReturnType<typeof unavailableRunner>> | undefined;
    let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
    let hostId: string | undefined;
    let runId: string | undefined;
    let operationId: string | undefined;
    const started = Date.now();
    try {
      await journey.step('Prepare an unavailable execution target', 'The real Runner is connected but reports sandbox unavailable; no waiting card exists', async () => {
        runner = await unavailableRunner();
        const host = await api(page,'/api/runners','POST',{alias:`recovery-${randomUUID()}`,connectionKind:'direct',endpoint:runner.endpoint,token:runner.token});
        hostId = host.id;
        expect(host.status).toBe('ready');
        expect((await api(page,`/api/runners/${hostId}/connect`,'POST',{})).state).toBe('ready');
        const capability = await api(page,`/api/runners/${hostId}/execution-capability`,'POST',{});
        expect(capability.connected).toBe(true);
        expect(capability.capability).toMatchObject({ready:false,reason:'dependency-unavailable'});
        fixture = await createProjectAndSession(page,{approvalMode:'always_allow',projectName:`Runner recovery ${randomUUID()}`,sessionTitle:`Runner recovery ${wait ? 'wait' : 'finish'}`,
          model:{name:'Runner recovery real E2E',baseUrl:proxy.baseUrl,apiToken:proxy.token,model:real.E2E_LLM_MODEL!,apiVariant:'openai'}});
        await api(page,`/api/projects/${fixture.project.id}`,'PATCH',{runnerIds:[hostId]});
        const plugins = `/api/projects/${fixture.project.id}/plugins`;
        const baseline = await api(page,plugins);
        await api(page,`${plugins}/bridge`,'POST',{apiVersion:1,pluginId:'host.settings',scope:{projectId:fixture.project.id},kind:'command',method:'replace',input:{expectedRevision:baseline.revision,overrides:{...baseline.settings.overrides,plugins:Object.fromEntries(['skill','plan','scheduler'].map(name=>[name,{enabled:false}]))}}});
        await api(page,`/api/sessions/${fixture.session.id}`,'PATCH',{runnerIds:[hostId],skillSelectionMode:'selected',enabledSkillIds:[],enabledSkillLibraries:[],enabledConnectorIds:[],specialistId:null});
        await openProjectSession(page,fixture);
        expect(await api(page,`/api/sessions/${fixture.session.id}/execution-blocks`)).toEqual([]);
      });
      const prefix = `/api/sessions/${fixture!.session.id}`;
      const card = page.getByRole('region',{name:/^(Execution blocked|执行受阻)$/});
      await journey.step('Let the real model choose its response to the blocker', 'Only an explicit model wait call opens a card', async () => {
        // Deliberately do not name check_runner, wait_for_runner, operation_id,
        // or tell the model to show a card. This tests tool-description following.
        const prompt = `Use only Runner ${hostId} to execute the harmless shell command printf 'runner-recovery-proof'. I need its actual execution output, not a prediction. Do not delegate, browse, install packages, repair the host, or switch to another machine. ${wait
          ? 'If execution is blocked by the environment, pause and wait for my decision so I can handle the environment before you continue.'
          : 'If execution is blocked by the environment, briefly explain why and end your response. Do not wait for me, ask for a decision, or retry.'}`;
        const run = await sendUserMessage(page,fixture!.session.id,prompt);
        runId = run.id;
        if (wait) {
          await expect(card).toBeVisible({timeout:120_000});
          const blocks = await api(page,`${prefix}/execution-blocks`);
          expect(blocks).toHaveLength(1);
          expect(blocks[0]).toMatchObject({runnerId:hostId});
          expect(blocks[0].operationId).toBeTruthy();
          operationId = blocks[0].operationId;
          const trace = protocol(proxy.requests);
          // The pending wait is only captured in the next model input after
          // cancellation; match its arguments once the loop has resumed.
          expect(JSON.stringify(trace.results)).toContain('RUNNER_UNAVAILABLE');
          expect(JSON.stringify(trace.results)).toContain(blocks[0].operationId);
          await page.reload();
          await expect(card).toBeVisible();
          await journey.step('Inspect the restored waiting card', 'Reload preserves the same live decision card', async () => {
            await expect(card).toBeVisible();
          });
          await card.getByRole('button',{name:/Cancel operation|取消本次操作/}).click();
          await expect(card).toHaveCount(0);
        }
        const terminal = await waitForRunTerminal(page,fixture!.session.id,run.id,90_000);
        expect(terminal.status,terminal.error).toBe('completed');
        expect(await api(page,`${prefix}/execution-blocks`)).toEqual([]);
        await expect(card).toHaveCount(0);
        const delivery = await collectFinalDelivery(page,fixture!.session.id,run.id);
        expect(delivery.answer.trim().length).toBeGreaterThan(0);
        const trace = protocol(proxy.requests);
        if (wait) {
          const waitCalls = trace.calls.filter(call=>call.function?.name==='wait_for_runner');
          expect(waitCalls).toHaveLength(1);
          expect(JSON.parse(waitCalls[0].function.arguments).operation_id).toBe(operationId);
          const waitIndex = trace.calls.findIndex(call=>call.id===waitCalls[0].id);
          expect(trace.calls.slice(waitIndex+1).filter(call=>/^(run_shell|run_python|execute_python|execute_scientific)$/.test(call.function?.name ?? ''))).toEqual([]);
          const result = trace.results.find(message=>message.tool_call_id===waitCalls[0].id);
          expect(result).toBeDefined();
          expect(JSON.stringify(result)).toContain('cancel');
        } else {
          expect(trace.calls.some(call=>call.function?.name==='wait_for_runner')).toBe(false);
          // The model must have observed the real failure, not just guessed it.
          expect(JSON.stringify(trace.results)).toMatch(/dependency-unavailable|RUNNER_UNAVAILABLE/);
        }
        expect(runner!.requests.some(request=>request.path==='/execution-capability')).toBe(true);
        expect(runner!.requests.filter(request=>request.method==='POST' && /^\/(execute|execute-shell|shell-executions)(?:\/|$)/.test(request.path))).toEqual([]);
        expect(await api(page,`${prefix}/subagents`)).toEqual([]);
      });
    } finally {
      try {
        await info.attach('model-protocol',{body:JSON.stringify({model:real.E2E_LLM_MODEL,backend:process.env.CI_E2E_BACKEND,elapsedMs:Date.now()-started,requests:proxy.requests,runnerRequests:runner?.requests}),contentType:'application/json'});
        if (fixture) {
          if (runId) await api(page,`/api/sessions/${fixture.session.id}/runs/${runId}/cancel`,'POST',{}).catch(()=>undefined);
          await cleanupJourney(page,fixture);
        }
        if (hostId) await api(page,`/api/remote-hosts/${hostId}`,'DELETE');
      } finally {
        try { await runner?.stop(); }
        finally {
          await proxy.stop();
          try { await info.attach('real-api-ledger',{body:readFileSync(ledger),contentType:'application/json'}); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
    }
  });
}
