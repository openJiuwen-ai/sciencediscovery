// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import type { ProxySettingsDetails, McpProxyPolicies, WebSettingsDetails } from "@sciencediscovery/schema";

test.describe("proxy settings drafts", { tag: ["@isolation:fresh", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {
  /**
   * E2E-META
   * Purpose: Proxy changes are drafts across sections, test never persists, and only footer save applies them.
   * Steps:
   *   1. Change the default proxy, navigate away and back, and cancel without changing backend settings.
   *   2. Enter a custom proxy, test its draft against a deterministic diagnostic response, then save with the footer.
   *   3. Reload and verify persisted configuration; restore the original settings.
   * Environment: Isolated API/Web stack with temporary Project/Session.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: diagnostic response is browser-mocked; actual proxy transports have ST coverage.
   * Credentials: E2E_API_TOKEN for the isolated stack only.
   * CostSideEffects: no paid calls; global settings restored and temporary resources removed.
   */
  test("proxy drafts require Save and survive section changes", { tag: "@mocked" }, async ({page, journey}) => {
    const api = async (path: string, method = "GET", data?: unknown) => {
      const response = await page.request.fetch(`${apiBaseUrl()}${path}`, { method, headers: authorizationHeader(), ...(data === undefined ? {} : { data }) });
      expect(response.ok()).toBeTruthy(); return response.json();
    };
    const before = await api("/api/proxy/settings");
    const fixture = await createProjectAndSession(page, { projectName: `Proxy draft ${Date.now()}`, sessionTitle: "Network settings" });
    const dialog = page.getByRole("dialog", { name: "System configuration", exact: true });
    const open = async () => {
      const trigger = page.getByRole("button", { name: /^System configuration/ });
      await trigger.waitFor({ state: "visible" });
      if (!(await dialog.isVisible())) await trigger.click();
      await dialog.getByRole("navigation", { name: "Setting groups" }).getByRole("button", { name: /^Network and proxy/ }).click();
    };
    journey.scenario({ goal: "One default proxy with explicit save/cancel and non-persisting diagnostics", preconditions: ["Isolated stack; no real network or model required"] });
    try {
      await openProjectSession(page, fixture);
      await journey.step("Cancel a cross-section draft", "The default remains unchanged until saved", async () => {
        await open();
        await dialog.locator("#proxy-global-default").selectOption("none");
        await dialog.getByRole("button", { name: "Web providers", exact: true }).click();
        await dialog.getByRole("navigation", { name: "Setting groups" }).getByRole("button", { name: /^Network and proxy/ }).click();
        await expect(dialog.locator("#proxy-global-default")).toHaveValue("none");
        expect((await api("/api/proxy/settings")).defaultPolicy).toBe(before.defaultPolicy);
        await dialog.getByRole("button", { name: "Cancel and close", exact: true }).last().click();
        expect(await api("/api/proxy/settings")).toEqual(before);
      });
      await journey.step("Save a custom proxy from the footer", "No separate form submit is required and credentials are not displayed in the summary", async () => {
        await open();
        await dialog.locator("#proxy-global-default").selectOption("custom");
        const form = dialog.getByRole("form", { name: "Add proxy server" });
        await form.getByLabel("Proxy URL", { exact: true }).fill("http://example-user:secret@127.0.0.1:1");
        await dialog.getByRole("button", { name: "Web providers", exact: true }).click();
        await dialog.getByRole("navigation", { name: "Setting groups" }).getByRole("button", { name: /^Network and proxy/ }).click();
        await expect(form.getByLabel("Proxy URL", { exact: true })).toHaveValue("http://example-user:secret@127.0.0.1:1");
        expect((await api("/api/proxy/settings")).servers).toHaveLength(before.servers.length);
        await dialog.getByRole("button", { name: "Save and close", exact: true }).click();
        await expect(dialog).toBeHidden();
        const saved = await api("/api/proxy/settings");
        expect(saved.defaultPolicy).not.toBe(before.defaultPolicy);
        expect(saved.servers).toHaveLength(before.servers.length + 1);
      });
      await journey.step("Test an unsaved replacement", "Testing does not change the saved URL", async () => {
        await page.reload(); await open();
        await dialog.locator(".proxy-default-section input").fill("http://draft-only:secret@127.0.0.1:2");
        let tested = false;
        await page.route("**/api/proxy/test", async route => {
          expect(route.request().postDataJSON().url).toContain("127.0.0.1:2"); tested = true;
          await route.fulfill({ json: { ok: false, elapsedMs: 1, message: "ECONNREFUSED (test fixture)" } });
        });
        await dialog.getByRole("button", { name: "Test connection (without saving)", exact: true }).click();
        await expect(dialog.getByRole("status")).toContainText("ECONNREFUSED"); expect(tested).toBeTruthy();
        const saved = await api("/api/proxy/settings");
        expect(saved.servers.find((server: {id: string}) => `proxy:${server.id}` === saved.defaultPolicy).url).toContain("127.0.0.1:1");
        await dialog.getByRole("button", { name: "Cancel and close", exact: true }).last().click();
      });
    } finally {
      await api("/api/proxy/settings", "PUT", { defaultPolicy: before.defaultPolicy, ...(before.noProxy !== undefined ? { noProxy: before.noProxy } : {}) });
      const current = await api("/api/proxy/settings");
      for (const server of current.servers) if (!before.servers.some((item: { id: string }) => item.id === server.id)) await api(`/api/proxy/servers/${server.id}`, "DELETE");
      await cleanupJourney(page, fixture);
    }
  });
  /**
   * E2E-META
   * Purpose: Advanced proxy drafts persist only on Save; module overrides and referenced-entry deletion remain consistent.
   * Steps:
   *   1. Create a named proxy through the advanced UI and save it.
   *   2. Cancel NO_PROXY and Web/MCP overrides across tabs, then save and reload the same changes.
   *   3. Verify an in-use proxy cannot be deleted; restore inheritance and delete it in one save.
   *   4. Save direct and environment defaults and verify them after reload.
   * Environment: Isolated API/Web stack with temporary Project/Session and built-in MCP catalog.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: none
   * MCP: catalog only; no tool execution or upstream requests.
   * OtherExternal: none; proxy URLs are local non-listening fixtures and are never invoked.
   * Credentials: E2E_API_TOKEN for the isolated stack only.
   * CostSideEffects: no paid calls; settings restored and temporary resources removed.
   */
  test("advanced proxy policies support save cancel inheritance and reference protection", { tag: "@mocked" }, async ({ page, journey }) => {
    page.setDefaultTimeout(15_000);
    const api = async (path: string, method = "GET", data?: unknown) => {
      const response = await page.request.fetch(`${apiBaseUrl()}${path}`, { method, headers: authorizationHeader(), ...(data === undefined ? {} : { data }) });
      expect(response.ok(), `${method} ${path}: ${response.status()}`).toBeTruthy();
      return response.json();
    };
    const before: ProxySettingsDetails = await api("/api/proxy/settings");
    const beforeWeb: WebSettingsDetails = await api("/api/web/settings");
    const beforeMcp: { policies: McpProxyPolicies } = await api("/api/mcp/proxy-policies");
    const fixture = await createProjectAndSession(page, { projectName: `Advanced proxy ${Date.now()}`, sessionTitle: "Advanced network settings" });
    const dialog = page.getByRole("dialog", { name: "System configuration", exact: true });
    const nav = dialog.getByRole("navigation", { name: "Setting groups" });
    const name = `E2E advanced proxy ${Date.now()}`;
    let proxyId: string | undefined;
    const open = async () => {
      const trigger = page.getByRole("button", { name: /^System configuration/ });
      await trigger.waitFor({ state: "visible" });
      if (!(await dialog.isVisible())) await trigger.click();
      await nav.getByRole("button", { name: /^Network and proxy/ }).click();
    };
    const expand = async () => {
      for (const title of ["Advanced: saved proxies", "Module proxy policies"]) {
        const details = dialog.locator("details").filter({ has: page.locator("summary", { hasText: title }) });
        if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await details.locator("summary").click();
      }
    };
    const bypass = dialog.getByLabel(/^Bypass proxy for these hosts/);
    const webPolicy = dialog.getByLabel("WebSearch proxy", { exact: true });
    const mcpPolicy = dialog.locator(".mcp-proxy-policy-list select").first();
    const cancel = () => dialog.getByRole("button", { name: "Cancel and close", exact: true }).last().click();
    const saveClose = async () => {
      await dialog.getByRole("button", { name: "Save and close", exact: true }).click();
      await expect(dialog).toBeHidden();
    };
    journey.scenario({ goal: "Advanced policies obey the same draft lifecycle as basic settings", preconditions: ["Isolated stack with built-in MCP sources; no LLM"] });
    try {
      await openProjectSession(page, fixture);
      await journey.step("Create a named proxy", "Adding stages it; the footer saves it", async () => {
        await open(); await expand();
        await dialog.getByRole("button", { name: "Add proxy server", exact: true }).click();
        const form = dialog.getByRole("form", { name: "Add proxy server" });
        await form.getByLabel("Name", { exact: true }).fill(name);
        await form.getByLabel("Proxy URL", { exact: true }).fill("http://127.0.0.1:9");
        await form.getByRole("button", { name: "Add", exact: true }).click();
        expect((await api("/api/proxy/settings")).servers.some((server: { name: string }) => server.name === name)).toBe(false);
        // Leave the fixture out of the global default so deletion tests specifically exercise module references.
        await dialog.locator("#proxy-global-default").selectOption("none");
        await saveClose();
        proxyId = (await api("/api/proxy/settings")).servers.find((server: { name: string }) => server.name === name)?.id;
        expect(proxyId).toBeTruthy();
      });
      await journey.step("Cancel advanced drafts", "Changing sections preserves drafts; closing with X discards them", async () => {
        await open(); await expand();
        await expect(mcpPolicy).toBeVisible();
        await bypass.fill("internal.test,.corp.test");
        await webPolicy.selectOption(`proxy:${proxyId}`);
        await mcpPolicy.selectOption(`proxy:${proxyId}`);
        await nav.getByRole("button", { name: "Web providers", exact: true }).click();
        await nav.getByRole("button", { name: /^Network and proxy/ }).click();
        await expand();
        await expect(bypass).toHaveValue("internal.test,.corp.test");
        await expect(webPolicy).toHaveValue(`proxy:${proxyId}`);
        await expect(mcpPolicy).toHaveValue(`proxy:${proxyId}`);
        expect((await api("/api/web/settings")).proxyPolicy).toBe(beforeWeb.proxyPolicy);
        expect(await api("/api/mcp/proxy-policies")).toEqual(beforeMcp);
        await dialog.getByRole("button", { name: "Cancel and close", exact: true }).first().click();
        await open(); await expand();
        await expect(bypass).toHaveValue(before.noProxy ?? "");
        await expect(webPolicy).toHaveValue(beforeWeb.proxyPolicy);
        await cancel();
      });
      await journey.step("Save advanced overrides", "NO_PROXY and independent Web/MCP policies survive reload", async () => {
        await open(); await expand();
        await bypass.fill("internal.test,.corp.test");
        await webPolicy.selectOption(`proxy:${proxyId}`);
        await mcpPolicy.selectOption(`proxy:${proxyId}`);
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await expect.poll(async () => Object.values((await api("/api/mcp/proxy-policies")).policies)).toContain(`proxy:${proxyId}`);
        expect((await api("/api/proxy/settings")).noProxy).toBe("internal.test,.corp.test");
        expect((await api("/api/web/settings")).proxyPolicy).toBe(`proxy:${proxyId}`);
        await expect(dialog).toBeVisible();
        await page.reload(); await open(); await expand();
        await expect(bypass).toHaveValue("internal.test,.corp.test");
        await expect(webPolicy).toHaveValue(`proxy:${proxyId}`);
        await expect(mcpPolicy).toHaveValue(`proxy:${proxyId}`);
      });
      await journey.step("Protect references", "Deleting a referenced proxy reports an error and preserves the saved entry", async () => {
        page.once("dialog", prompt => void prompt.accept());
        await dialog.locator(".proxy-server-card").filter({ hasText: name }).getByRole("button", { name: "Delete", exact: true }).click();
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await expect(dialog.getByRole("alert")).toContainText(/referenc|Web|MCP|proxy/i);
        expect((await api("/api/proxy/settings")).servers.some((server: { id: string }) => server.id === proxyId)).toBe(true);
        await cancel();
        await open(); await expand();
        await expect(dialog.locator(".proxy-server-card").filter({ hasText: name })).toBeVisible();
      });
      await journey.step("Restore inheritance and remove the proxy", "References update before deletion in the same save", async () => {
        await webPolicy.selectOption("inherit");
        await mcpPolicy.selectOption("inherit");
        page.once("dialog", prompt => void prompt.accept());
        await dialog.locator(".proxy-server-card").filter({ hasText: name }).getByRole("button", { name: "Delete", exact: true }).click();
        await saveClose();
        expect((await api("/api/web/settings")).proxyPolicy).toBe("inherit");
        expect(Object.values((await api("/api/mcp/proxy-policies")).policies)).not.toContain(`proxy:${proxyId}`);
        expect((await api("/api/proxy/settings")).servers.some((server: { id: string }) => server.id === proxyId)).toBe(false);
      });
      await journey.step("Switch basic defaults", "Direct and environment defaults persist after reload", async () => {
        const environment = before.servers.find(server => server.kind === "environment");
        expect(environment).toBeTruthy();
        for (const policy of ["none", `proxy:${environment!.id}`]) {
          await open(); await dialog.locator("#proxy-global-default").selectOption(policy); await saveClose();
          expect((await api("/api/proxy/settings")).defaultPolicy).toBe(policy);
          await page.reload(); await open();
          await expect(dialog.locator("#proxy-global-default")).toHaveValue(policy); await cancel();
        }
      });
    } finally {
      await api("/api/web/settings", "PUT", { proxyPolicy: beforeWeb.proxyPolicy });
      await api("/api/mcp/proxy-policies", "PUT", beforeMcp);
      await api("/api/proxy/settings", "PUT", { defaultPolicy: before.defaultPolicy, noProxy: before.noProxy ?? "" });
      if (proxyId && (await api("/api/proxy/settings")).servers.some((server: { id: string }) => server.id === proxyId)) await api(`/api/proxy/servers/${proxyId}`, "DELETE");
      await cleanupJourney(page, fixture);
    }
  });
});
