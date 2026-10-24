// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel } from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: Researchers discover the five domain databases and inspect a built-in tool with validation feedback.
 * Steps:
 *   1. Create a Session and open built-in MCP sources.
 *   2. Inspect AlphaFold's parameter schema and submit a malformed accession.
 *   3. Verify visible parameter validation feedback, then return to all five sources.
 * Environment: Isolated committed product stack, pinned Chromium and bundled biomed MCP server.
 * Type: mocked
 * LLM: Local model stub for Session setup only; no scientific inference.
 * WebSearch: none
 * PaperSources: none
 * MCP: Real bundled stdio discovery; malformed input is rejected before any provider request.
 * OtherExternal: none; live database success and files have a separate opt-in API journey.
 * Credentials: E2E_API_TOKEN only.
 * CostSideEffects: Temporary local Project/Session/model and one rejected Inspector request; cleaned afterward.
 */
test("Inspect domain scientific databases", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap", "@mocked"] }, async ({ page, journey }) => {
  journey.scenario({ goal: "Find supported domain databases and diagnose an invalid prediction lookup", preconditions: ["Isolated product stack with biomed enabled", "No external database calls required"] });
  await page.addInitScript(() => localStorage.setItem("science-agent-locale", "zh-CN"));
  const stub = await scriptedModel([{ text: "Ready" }]);
  const fixture = await createProjectAndSession(page, { projectName: `Domain databases ${Date.now()}`, sessionTitle: "Inspect predictions", model: { ...stub, name: "Domain database journey" } });
  const dialog = page.getByRole("dialog", { name: "系统设置" });
  const settings = dialog.locator(".mcp-settings");
  try {
    await openProjectSession(page, fixture);
    await journey.step("查找领域数据库", "内置列表包含 GEO、ChEMBL、ClinVar、PDB 和 AlphaFold DB", async () => {
      await page.getByRole("button", { name: /^系统设置/ }).click();
      await dialog.getByRole("navigation", { name: "设置分组" }).getByRole("button", { name: /^MCP 服务器/ }).click();
      await settings.getByRole("tab", { name: /内置/ }).click();
      for (const source of ["GEO", "ChEMBL", "ClinVar", "PDB", "AlphaFold DB"]) await expect(settings.locator(".mcp-builtin strong", { hasText: new RegExp(`^${source}$`) })).toBeVisible();
      const entry = settings.locator(".mcp-builtin").filter({ has: page.locator("strong", { hasText: "AlphaFold DB" }) });
      await entry.locator("summary").click();
      await entry.getByRole("button", { name: "MCP Inspector", exact: true }).click();
    });
    await journey.step("查看参数并诊断错误", "显示 UniProt 编号约束；非法编号得到明确失败反馈", async () => {
      await settings.getByLabel("工具", { exact: true }).selectOption("alphafold_lookup_prediction");
      await settings.locator(".mcp-tool summary").click();
      await expect(settings.locator(".mcp-tool pre")).toContainText('"pattern"');
      await settings.getByLabel("调用参数（JSON）").fill('{"accession":"../../invalid"}');
      await settings.getByRole("button", { name: "执行工具", exact: true }).click();
      await expect(settings.getByRole("alert")).toContainText("accession");
    });
    await journey.step("继续检查数据源", "返回后仍可查看 GEO 的样本和文件发现工具", async () => {
      await settings.getByRole("button", { name: "返回服务器列表", exact: true }).click();
      const geo = settings.locator(".mcp-builtin").filter({ has: page.locator("strong", { hasText: /^GEO$/ }) });
      await geo.locator("summary").click();
      await expect(geo).toContainText("geo_get_samples");
      await expect(geo).toContainText("geo_list_files");
      await expect(geo.getByRole("button", { name: "MCP Inspector", exact: true })).toBeVisible();
    });
  } finally { await cleanupJourney(page, fixture); await stub.stop(); }
});
