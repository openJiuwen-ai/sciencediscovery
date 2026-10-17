// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { expect } from '@playwright/test';
import { test } from './helpers/e2e.ts';
import { apiBaseUrl, authorizationHeader } from './e2e-auth.js';

/**
 * E2E-META
 * Purpose: Save explicit global and Project approval defaults without changing existing Sessions or coupling the composer toggle to defaults.
 * Steps:
 * 1. Create a Project with built-in Ask, save global Always allow in System configuration.
 * 2. Create another Project and verify its first Session inherits Always allow.
 * 3. Save Project Ask, create a Session, then toggle only that Session.
 * 4. Reload, clear the Project default, and verify global inheritance and existing modes.
 * Environment: Isolated API/Web; no execution services required for settings and Session creation.
 * Type: mocked
 * LLM: none; no Runs submitted.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: E2E_API_TOKEN for isolated local API.
 * CostSideEffects: No paid calls; journey Projects deleted and global settings restored in finally.
 */
test('approval defaults are explicit and affect only new sessions', { tag: ['@mocked', '@isolation:instance', '@category:e2e', '@os:linux', '@arch:amd64', '@model:mock', '@sandbox:bubblewrap'] }, async ({page, journey}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('sciencediscovery-locale', 'en'));
  journey.scenario({goal:'Set defaults for new sessions while retaining control over existing sessions.', preconditions:['Isolated API/Web with no models or Runs required']});
  const api = async (path:string, method='GET', data?:unknown) => {
    const response = await page.request.fetch(apiBaseUrl()+path, {method, headers:authorizationHeader(), ...(data === undefined ? {} : {data})});
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const previous = await api('/api/settings');
  const projectIds:string[] = [];
  let first: {project:{id:string}; firstSession:{id:string; approvalMode:string}};
  let second: typeof first;
  let toggled: {id:string; approvalMode:string};
  const openProjectSettings = async (projectId:string) => {
    await page.goto(`/projects/${projectId}/settings`);
    const dialog = page.getByRole('dialog', {name:'Project settings', exact:true});
    await expect(dialog.getByLabel('Approval mode for new sessions')).toBeVisible();
    return dialog;
  };
  try {
    await journey.step('Save a global default explicitly', 'An existing Session remains Ask after global Always allow is saved.', async () => {
      await api('/api/settings', 'PUT', {});
      first = await api('/api/projects', 'POST', {name:`Approval baseline ${Date.now()}`}); projectIds.push(first.project.id);
      expect(first.firstSession.approvalMode).toBe('ask_for_dangerous');
      await page.goto('/settings/global');
      const dialog = page.getByRole('dialog', {name:'System configuration', exact:true});
      await dialog.getByLabel('Approval mode for new sessions').selectOption('always_allow');
      expect((await api('/api/settings')).overrides.defaultApprovalMode).toBeUndefined();
      await dialog.getByRole('button', {name:'Save and close', exact:true}).click();
      await expect(dialog).toBeHidden();
      expect((await api('/api/settings')).overrides.defaultApprovalMode).toBe('always_allow');
      expect((await api(`/api/sessions/${first.firstSession.id}`)).approvalMode).toBe('ask_for_dangerous');
    });
    await journey.step('Create a Project using the global default', 'Its implicit first Session visibly starts on Always allow.', async () => {
      second = await api('/api/projects', 'POST', {name:`Approval global ${Date.now()}`}); projectIds.push(second.project.id);
      expect(second.firstSession.approvalMode).toBe('always_allow');
      await page.goto(`/projects/${second.project.id}/sessions/${second.firstSession.id}`);
      await expect(page.locator('.approval-mode-toggle')).toHaveAttribute('aria-pressed', 'true');
    });
    await journey.step('Save a Project default and override one Session', 'Project Ask wins; the composer changes only that Session to Always allow.', async () => {
      const dialog = await openProjectSettings(second.project.id);
      await dialog.getByLabel('Approval mode for new sessions').selectOption('ask_for_dangerous');
      await dialog.getByRole('button', {name:'Save Project settings', exact:true}).click();
      await expect.poll(async () => (await api(`/api/projects/${second.project.id}/settings`)).overrides.defaultApprovalMode).toBe('ask_for_dangerous');
      toggled = await api(`/api/projects/${second.project.id}/sessions`, 'POST', {title:'Project Ask'});
      expect(toggled.approvalMode).toBe('ask_for_dangerous');
      await page.goto(`/projects/${second.project.id}/sessions/${toggled.id}`);
      await expect(page.locator('.approval-mode-toggle')).toHaveAttribute('aria-pressed', 'false');
      await page.locator('.approval-mode-toggle').click();
      await expect(page.locator('.approval-mode-toggle')).toHaveAttribute('aria-pressed', 'true');
      expect((await api(`/api/projects/${second.project.id}/settings`)).overrides.defaultApprovalMode).toBe('ask_for_dangerous');
      expect((await api('/api/settings')).overrides.defaultApprovalMode).toBe('always_allow');
      const next = await api(`/api/projects/${second.project.id}/sessions`, 'POST', {title:'Still Project Ask'});
      expect(next.approvalMode).toBe('ask_for_dangerous');
    });
    await journey.step('Reload and clear the Project override', 'New Sessions inherit global Always allow; older Session choices persist.', async () => {
      const dialog = await openProjectSettings(second.project.id);
      await expect(dialog.getByLabel('Approval mode for new sessions')).toHaveValue('ask_for_dangerous');
      await dialog.getByLabel('Approval mode for new sessions').selectOption('');
      await dialog.getByRole('button', {name:'Save Project settings', exact:true}).click();
      await expect.poll(async () => (await api(`/api/projects/${second.project.id}/settings`)).overrides.defaultApprovalMode).toBeUndefined();
      const next = await api(`/api/projects/${second.project.id}/sessions`, 'POST', {title:'Global inherited'});
      expect(next.approvalMode).toBe('always_allow');
      await page.goto(`/projects/${second.project.id}/sessions/${toggled.id}`); await page.reload();
      await expect(page.locator('.approval-mode-toggle')).toHaveAttribute('aria-pressed', 'true');
      expect((await api(`/api/sessions/${first.firstSession.id}`)).approvalMode).toBe('ask_for_dangerous');
    });
  } finally {
    await api('/api/settings', 'PUT', previous.overrides);
    for (const id of projectIds.reverse()) await api(`/api/projects/${id}`, 'DELETE', {confirmationId:id});
  }
});
