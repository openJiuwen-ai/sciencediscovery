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

import { expect } from "@playwright/test";

import { test } from "./helpers/e2e.ts";

test.use({ locale: "zh-CN", actionTimeout: 15_000 });

/**
 * E2E-META
 * Purpose: 每个 Runner（本机 local 与已登记远端）都在远程计算分组里列出 Ascend NPU 卡：
 *   可选卡带复选框、不可用卡禁用并说明原因；勾选通过 PUT 保存到该 Runner；选择在重开设置后保持；
 *   桌面与 390px 窄屏都无横向溢出。本旅程用浏览器路由注入可用的假 910B 清单，
 *   因为当前环境没有 Ascend 驱动（真实接口返回所有卡 sandboxUsable:false）。
 * Steps:
 *   1. 打开系统设置 → 远程计算分组：本地 Runner 卡片内出现 NPU 卡区，头部计数为“本机 3 张 · 沙箱内可用 2 张”。
 *   2. 每个卡行展示 NPU 编号与芯片名、健康徽章、HBM 用量、AI Core 百分比与温度；复选框与名称在同一阅读行。
 *   3. 不可用卡（hostIndex 2）复选框禁用并附原因文本；可选卡（hostIndex 0/4）复选框可勾选。
 *   4. 勾选 hostIndex 4 保存到 runnerId=local；再勾选 hostIndex 0 请求体按升序为 [0,4]；取消勾选 hostIndex 4 后请求体为 [0]。
 *   5. 远端 Runner 卡片展示独立的 NPU 清单（hostIndex 1/3/5），勾选保存到它自己的 runnerId，且不影响 local 的选择。
 *   6. 关闭并重新打开设置：local 的 NPU 0 与远端的 NPU 1 仍保持勾选。
 *   7. 390px 窄屏：NPU 区、卡行与不可用原因都不产生横向溢出，复选框与名称仍可见。
 * Environment: 隔离本地栈（E2E_BASE_URL + 隔离数据目录）；NPU 清单与保存请求由浏览器本地路由确定性模拟；
 *   不依赖真实 Ascend 驱动（当前环境无驱动，所有真实卡均不可沙箱使用）。
 * Type: mocked
 * LLM: none — 仅配置与回读 NPU 选择，不发起任何模型调用。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 非本地浏览器请求被标准 fixture 拦截。
 * Credentials: E2E_API_TOKEN（隔离实例）；无其他凭据。
 * CostSideEffects: none — 本旅程不创建 Project/Session/远程机器，也不修改服务端 NPU 选择。
 */
test("J7 Runner NPU 卡片：可选/不可用/本地与远端一致且窄屏可用", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(180_000);
  journey.scenario({
    goal: "一位运维要在远程计算分组里为每台 Runner 挑选可交给沙箱的 Ascend 卡：先确认卡片列表与不可用说明，"
      + "再勾选保存到对应 Runner，重开设置后选择保持，并确认 390px 窄屏下仍整齐可用。",
    preconditions: [
      "隔离栈已启动，浏览器已持有本实例的访问 token",
      "本环境没有 Ascend 驱动，因此 NPU 清单由浏览器路由注入可用的 910B 假数据",
      "浏览器与界面语言均为 zh-CN",
      "mocked：只验证设置与状态，不发起模型调用",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("science-agent-locale", "zh-CN"));

  /** 本机 910B：hostIndex 0/4 可用，hostIndex 2 被沙箱探针拒绝。 */
  const localNpu = () => ({
    capturedAt: new Date().toISOString(),
    supported: true,
    devices: [
      { aiCorePercent: 0, chipName: "910B3", health: "OK", hbmUsedMb: 3445, hbmTotalMb: 65_536,
        hostIndex: 0, sandboxUsable: true, temperatureCelsius: 45 },
      { aiCorePercent: 12, chipName: "910B3", health: "OK", hbmUsedMb: 3418, hbmTotalMb: 65_536,
        hostIndex: 4, sandboxUsable: true, temperatureCelsius: 49 },
      { aiCorePercent: 0, chipName: "910B3", health: "Alarm", hbmUsedMb: 62_000, hbmTotalMb: 65_536,
        hostIndex: 2, sandboxUsable: false, temperatureCelsius: 78,
        sandboxUnusableReason: "dcmi model initialized failed, because the device is used. ret is -8020" },
    ],
  });
  /** 远端 910B：hostIndex 1/3 可用，hostIndex 5 不可用，与 local 完全不同，证明按 Runner 隔离。 */
  const remoteNpu = () => ({
    capturedAt: new Date().toISOString(),
    supported: true,
    devices: [
      { aiCorePercent: 5, chipName: "910B3", health: "OK", hbmUsedMb: 1800, hbmTotalMb: 65_536,
        hostIndex: 1, sandboxUsable: true, temperatureCelsius: 43 },
      { aiCorePercent: 25, chipName: "910B3", health: "OK", hbmUsedMb: 2000, hbmTotalMb: 65_536,
        hostIndex: 3, sandboxUsable: true, temperatureCelsius: 51 },
      { aiCorePercent: 0, chipName: "910B3", health: "Alarm", hbmUsedMb: 62_000, hbmTotalMb: 65_536,
        hostIndex: 5, sandboxUsable: false, temperatureCelsius: 78,
        sandboxUnusableReason: "Card is claimed by another tenant." },
    ],
  });

  /** 每个 Runner 的已保存选择；GET 与 PUT 共用同一份，模拟服务端持久化。 */
  let selections: Record<string, number[]> = {};
  const npuPuts: Array<{ devices: number[]; runnerId: string }> = [];

  await page.route("**/api/runners/npu", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ json: { local: localNpu(), selections } });
  });
  await page.route("**/api/runners/*/npu-devices", async (route) => {
    expect(route.request().method()).toBe("PUT");
    const runnerId = decodeURIComponent(route.request().url().split("/").at(-2) ?? "");
    const body = route.request().postDataJSON() as { devices: number[] };
    npuPuts.push({ devices: body.devices, runnerId });
    selections = { ...selections, [runnerId]: body.devices };
    return route.fulfill({ json: { devices: body.devices, runnerId } });
  });
  await page.route("**/api/runners", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ json: [{ id: "local", alias: "local", location: "local", connectionKind: "direct", status: "ready", runnerStatus: { state: "ready", resources: { npu: localNpu() } } }, {
      alias: "npu-910b-lab",
      runnerName: "910B analysis",
      description: "Ascend 910B analysis server",
      capabilities: {
        conda: false, containerRuntimes: [], cpuCores: 64, cuda: null, gpu: null,
        memoryBytes: 256 * 1024 ** 3, modules: true, nodeVersion: "v22.19.0",
        platform: "Linux", probedAt: new Date().toISOString(),
        runnerCommandAvailable: true, scratchPaths: ["/scratch"], slurm: false,
      },
      connectionKind: "ssh",
      createdAt: new Date().toISOString(),
      id: "e2e-npu-host",
      hostName: "192.0.2.50",
      port: 22,
      username: "operator",
      runnerCommand: "sciencediscovery-runner",
      runnerStatus: {
        connectedAt: new Date().toISOString(),
        hostId: "e2e-npu-host",
        localVersion: "0.0.0-local",
        remoteVersion: "0.0.0-remote",
        resources: {
          capturedAt: new Date().toISOString(), cpuCores: 64, loadAverage1m: 1.5,
          memoryTotalBytes: 256 * 1024 ** 3, memoryFreeBytes: 180 * 1024 ** 3,
          npu: remoteNpu(), uptimeSeconds: 604_800,
          workspaceDisk: { path: "/data", totalBytes: 200 * 1024 ** 3, availableBytes: 120 * 1024 ** 3 },
        },
        state: "ready",
      },
      status: "ready",
      updatedAt: new Date().toISOString(),
    }] });
  });

  const openRemoteSettings = async () => {
    const dialog = page.getByRole("dialog", { name: "系统设置" });
    if (!await dialog.isVisible()) await page.getByRole("button", { name: /^系统设置/ }).click();
    await dialog.getByRole("navigation", { name: "设置分组" })
      .getByRole("button", { name: /^Runner/ })
      .click();
    return dialog;
  };

  try {
    await journey.step(
      "打开远程计算分组：本地 Runner 卡片列出 NPU 卡",
      "系统设置内点开“远程计算”，本地 Runner 卡片里出现 NPU 卡区，头部显示“本机 3 张 · 沙箱内可用 2 张”，并提示沙箱内从 0 重新编号。",
      async () => {
        await page.goto("/");
        await expect(page).toHaveTitle("ScienceDiscovery");
        const dialog = await openRemoteSettings();
        await expect(dialog.getByRole("heading", { name: "Runners" })).toBeVisible();
        const localCard = dialog.locator("article.remote-host-card").filter({ hasText: "Runner ID：local" });
        await expect(localCard).toBeVisible();
        const npu = localCard.locator("section[aria-label='NPU 卡']");
        await expect(npu).toBeVisible();
        await expect(npu.locator(":scope > .remote-npu-header strong")).toHaveText("NPU 卡");
        await expect(npu).toContainText("本机 3 张 · 沙箱内可用 2 张");
        await expect(npu).toContainText(/从 0 开始重新编号/);
      },
    );

    await journey.step(
      "卡行展示编号、芯片、健康、HBM、AI Core 与温度",
      "每行 NPU {hostIndex} · {chipName} 与复选框同行；OK/Alarm 徽章、HBM 用量、AI Core 百分比和温度在右侧同行。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const npu = dialog.locator("article.remote-host-card").filter({ hasText: "Runner ID：local" })
          .locator("section[aria-label='NPU 卡']");
        await expect(npu.getByText("NPU 0 · 910B3", { exact: true })).toBeVisible();
        await expect(npu.getByText("NPU 4 · 910B3", { exact: true })).toBeVisible();
        await expect(npu).toContainText("3.4 / 64.0 GiB");
        await expect(npu).toContainText("AI Core 0%");
        await expect(npu).toContainText("45 °C");
        await expect(npu).toContainText("AI Core 12%");
        const row0 = npu.locator("li", { hasText: "NPU 0" });
        const box = await row0.getByRole("checkbox").boundingBox();
        const nameBox = await row0.locator(".remote-npu-name").boundingBox();
        if (!box || !nameBox) throw new Error("NPU row has no layout box");
        expect(Math.abs((box.y + box.height / 2) - (nameBox.y + nameBox.height / 2))).toBeLessThan(6);
      },
    );

    await journey.step(
      "不可用卡禁用并说明原因，可选卡可勾选",
      "hostIndex 2 的卡行带 unusable 样式、复选框禁用，并显示驱动拒绝原因；hostIndex 0/4 复选框可用且未勾选。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const npu = dialog.locator("article.remote-host-card").filter({ hasText: "Runner ID：local" })
          .locator("section[aria-label='NPU 卡']");
        const unusable = npu.locator("li.unusable", { hasText: "NPU 2" });
        await expect(unusable.getByRole("checkbox")).toBeDisabled();
        await expect(unusable).toContainText(/because the device is used\. ret is -8020/);
        await expect(npu.locator("li", { hasText: "NPU 0" }).getByRole("checkbox")).toBeEnabled();
        await expect(npu.locator("li", { hasText: "NPU 4" }).getByRole("checkbox")).toBeEnabled();
        await expect(npu.locator("li", { hasText: "NPU 0" }).getByRole("checkbox")).not.toBeChecked();
      },
    );

    await journey.step(
      "勾选/取消勾选把选择保存到 local Runner",
      "勾选 NPU 4 发送 PUT 到 /api/runners/local/npu-devices（[4]）；再勾选 NPU 0 请求体按升序为 [0,4]；"
      + "取消勾选 NPU 4 后请求体为 [0]，界面复选框状态与保存一致。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const npu = dialog.locator("article.remote-host-card").filter({ hasText: "Runner ID：local" })
          .locator("section[aria-label='NPU 卡']");
        const npu4 = npu.locator("li", { hasText: "NPU 4" }).getByRole("checkbox");
        await npu4.click();
        await expect.poll(() => npuPuts.at(-1)).toEqual({ devices: [4], runnerId: "local" });
        await expect(npu4).toBeChecked();
        const npu0 = npu.locator("li", { hasText: "NPU 0" }).getByRole("checkbox");
        await npu0.click();
        await expect.poll(() => npuPuts.at(-1)).toEqual({ devices: [0, 4], runnerId: "local" });
        await expect(npu0).toBeChecked();
        await npu4.click();
        await expect.poll(() => npuPuts.at(-1)).toEqual({ devices: [0], runnerId: "local" });
        await expect(npu4).not.toBeChecked();
        await expect(npu0).toBeChecked();
      },
    );

    await journey.step(
      "远端 Runner 的 NPU 清单独立并保存到自己的 runnerId",
      "远端 910B analysis 卡显示自己的清单（NPU 1/3/5），勾选 NPU 1 保存到 e2e-npu-host；local 的选择不受影响。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const remoteCard = dialog.locator(".remote-host-list article.remote-host-card").filter({ hasText: "910B analysis" });
        await expect(remoteCard).toBeVisible();
        const npu = remoteCard.locator("section[aria-label='NPU 卡']");
        await expect(npu).toBeVisible();
        await expect(npu).toContainText("本机 3 张 · 沙箱内可用 2 张");
        await expect(npu.getByText("NPU 1 · 910B3", { exact: true })).toBeVisible();
        await expect(npu.getByText("NPU 3 · 910B3", { exact: true })).toBeVisible();
        await expect(npu.locator("li.unusable", { hasText: "NPU 5" })).toContainText("Card is claimed by another tenant.");
        // 与 local 清单互不串卡。
        const localNpu = dialog.locator("article.remote-host-card").filter({ hasText: "Runner ID：local" })
          .locator("section[aria-label='NPU 卡']");
        await expect(localNpu.getByText("NPU 1", { exact: false })).toHaveCount(0);
        await npu.locator("li", { hasText: "NPU 1" }).getByRole("checkbox").click();
        await expect.poll(() => npuPuts.at(-1)).toEqual({ devices: [1], runnerId: "e2e-npu-host" });
        // local 仍保持 [0]，远端保存不覆盖它。
        expect(selections.local).toEqual([0]);
        expect(selections["e2e-npu-host"]).toEqual([1]);
      },
    );

    await journey.step(
      "关闭并重开设置：选择保持",
      "重开后 local 的 NPU 0 与远端的 NPU 1 仍勾选，未勾选的卡保持未勾选。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.locator(".system-config-footer").getByRole("button", { name: "取消并关闭" }).click();
        const reopened = await openRemoteSettings();
        const localNpu = reopened.locator("article.remote-host-card").filter({ hasText: "Runner ID：local" })
          .locator("section[aria-label='NPU 卡']");
        await expect(localNpu.locator("li", { hasText: "NPU 0" }).getByRole("checkbox")).toBeChecked();
        await expect(localNpu.locator("li", { hasText: "NPU 4" }).getByRole("checkbox")).not.toBeChecked();
        const remoteNpu = reopened.locator(".remote-host-list article.remote-host-card").filter({ hasText: "910B analysis" })
          .locator("section[aria-label='NPU 卡']");
        await expect(remoteNpu.locator("li", { hasText: "NPU 1" }).getByRole("checkbox")).toBeChecked();
      },
    );

    await journey.step(
      "390px 窄屏：NPU 区无横向溢出",
      "窄屏下 NPU 区、每个卡行与不可用原因都不越界；复选框与卡名仍可见。",
      async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const localCard = dialog.locator("article.remote-host-card").filter({ hasText: "Runner ID：local" });
        const npu = localCard.locator("section[aria-label='NPU 卡']");
        await npu.scrollIntoViewIfNeeded();
        await expect(npu.locator("li", { hasText: "NPU 0" }).getByRole("checkbox")).toBeVisible();
        await expect(npu.locator("li", { hasText: "NPU 2" })).toContainText(/because the device is used\. ret is -8020/);
        for (const element of await npu.locator(":scope, :scope > ul > li, .remote-npu-reason").all()) {
          expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        }
      },
    );
  } finally {
    await page.unrouteAll({ behavior: "wait" });
  }
});
