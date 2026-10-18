// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './helpers/e2e.ts';
import { apiBaseUrl, authorizationHeader } from './e2e-auth.js';

for (const [kind, locale] of [['responses-min16', 'en'], ['reasoning-limit', 'en'], ['reasoning-limit', 'zh-CN'], ['auth', 'zh-CN'], ['empty', 'en']] as const) {
  /**
   * E2E-META
   * Purpose: Save valid budget-limited model setup without certifying compatibility; preserve real failure rollback.
   * Steps:
   *   1. Start an owned native provider fixture without model requests.
   *   2. Open the wizard and select explicit custom model/protocol without probing.
   *   3. Read the bounded cost disclosure, consent and submit exactly one basic request.
   *   4. Verify saved configuration or failed-setup rollback and accurate capability notice.
   *   5. Inspect reachable warning/actions and horizontal overflow at390px.
   *   6. Inspect readable warning/actions and horizontal overflow at1440px.
   * Environment: Owned API/Web and loopback HTTP fixture; no Runner/full stack.
   * Type: mocked
   * LLM: native synthetic min16/truncated/auth/empty fixture; no paid requests.
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none
   * Credentials: synthetic local token only.
   * CostSideEffects: own provider/model records, removed after each case.
   */
  test(`(${locale}) ${kind} wizard preserves honest setup and rollback`, { tag: ['@mocked', '@isolation:global', '@category:e2e', '@os:linux', '@arch:amd64', '@model:mock', '@sandbox:none'] }, async ({ page, journey }) => {
    journey.scenario({ goal: 'Configure a native model with a bounded check and honest outcome', preconditions: ['Owned API/Web; loopback synthetic fixture only'] });
    await page.addInitScript(value => localStorage.setItem('science-agent-locale', value), locale);
    const name = `Budget fixture ${randomUUID()}`, requests: Record<string, any>[] = [];
    const protocol = kind === 'responses-min16' ? 'openai-responses' : 'openai-chat-completions';
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const b of req) raw += b;
      const body = JSON.parse(raw); requests.push(body);
      const status = kind === 'auth' ? 401 : kind === 'responses-min16' && body.max_output_tokens < 16 ? 400 : 200;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(status !== 200 ? { error: { message: 'Synthetic provider rejection' } }
        : kind === 'responses-min16' ? { object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }
        : { choices: [{ message: kind === 'empty' ? { content: '' } : { content: null, reasoning_content: 'synthetic reasoning' }, finish_reason: kind === 'empty' ? 'stop' : 'length' }], usage: { prompt_tokens: 1, completion_tokens: 8, total_tokens: 9 } }));
    });
    const call = async (path: string, data?: unknown, method = data ? 'POST' : 'GET') => {
      const r = await page.request.fetch(apiBaseUrl() + path, { method, headers: authorizationHeader(), ...(data ? { data } : {}) }); expect(r.ok()).toBeTruthy(); return r.json();
    };
    const wizard = page.locator('.model-connect-wizard');
    try {
      await journey.step('Start an owned native provider fixture', 'No provider I/O before explicit setup consent', async () => { await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); expect(requests).toHaveLength(0); });
      await journey.step('Select explicit custom protocol and model in the wizard', 'Selected protocol and registration cause no completion requests', async () => {
        await page.goto('/'); await page.getByRole('button', { name: locale === 'en' ? /^System configuration/ : /^系统设置/ }).click();
        const dialog = page.getByRole('dialog'); const nav = dialog.getByRole('navigation', { name: locale === 'en' ? 'Setting groups' : '设置分组' });
        if (!await nav.isVisible()) await dialog.getByRole('button', { name: locale === 'en' ? /^Settings directory/ : /^设置目录/ }).click();
        await nav.getByRole('button', { name: locale === 'en' ? /^Model registry/ : /^模型注册表/ }).click();
        if (!await wizard.count()) await dialog.getByRole('button', { name: locale === 'en' ? /Connect model/ : /连接模型/ }).click();
        await wizard.locator('#wizard-provider-select').selectOption('custom'); await wizard.locator('#wizard-custom-name').fill(name);
        await wizard.locator('#wizard-custom-url').fill(`http://127.0.0.1:${(server.address() as any).port}/v1`); await wizard.locator('#wizard-custom-model').fill('synthetic'); await wizard.locator('#wizard-api-key').fill('synthetic-local');
        await wizard.getByRole('button', { name: locale === 'en' ? 'Advanced configuration' : '高级配置', exact: true }).click(); await wizard.locator('#wizard-api-protocol').selectOption(protocol); expect(requests).toHaveLength(0);
      });
      await journey.step('Read cost disclosure and consent to one bounded request', 'Submit disabled until consent, exactly one request with selected output limit', async () => {
        const submit = wizard.locator('.wizard-submit-button'); await expect(submit).toBeDisabled();
        await expect(wizard.locator('.wizard-probe-consent')).toContainText('16'); await wizard.locator('.wizard-probe-consent input').check(); await submit.click();
        await expect.poll(() => requests.length).toBe(1); expect(protocol === 'openai-responses' ? requests[0]!.max_output_tokens : requests[0]!.max_tokens).toBe(protocol === 'openai-responses' ? 16 : 8);
      });
      await journey.step('Verify saved setup or precise rollback', 'Budget-only limitation saves an unconfirmed profile; real errors roll back', async () => {
        const failed = kind === 'auth' || kind === 'empty';
        await expect(wizard.locator(failed ? '.wizard-alert-error' : '[role="status"]')).toBeVisible();
        if (kind === 'reasoning-limit') await expect(wizard).toContainText(locale === 'en' ? 'compatibility unconfirmed' : '兼容性未确认');
        const providers = (await call('/api/providers')).providers.filter((p: any) => p.name === name); expect(providers).toHaveLength(failed ? 0 : 1);
        if (!failed) expect(providers[0].apiProtocol).toBe(protocol);
        expect(requests).toHaveLength(1);
      });
      for (const width of [390, 1440]) await journey.step(`Inspect wizard at${width}px`, 'Outcome text wraps and setup controls remain reachable', async () => {
        await page.setViewportSize({ width, height: 800 }); await wizard.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy(); await expect(wizard.locator('.wizard-submit-button')).toBeVisible();
      });
    } finally {
      try {
        const own = (await call('/api/providers')).providers.find((p: any) => p.name === name);
        if (own) { const models = (await call('/api/models')).filter((m: any) => m.providerId === own.id); const settings = (await call('/api/settings')).overrides;
          if (models.some((m: any) => m.id === settings.modelId)) { delete settings.modelId; await call('/api/settings', settings, 'PUT'); }
          await call(`/api/providers/${own.id}`, undefined, 'DELETE');
        }
      } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    }
  });
}
