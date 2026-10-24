// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { expect } from "@playwright/test";
import { researchTrajectoryFixture } from "./support/research-package.fixture.ts";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { artifactTree, cleanupJourney, createProjectAndSession, openProjectSession, type JourneyFixture } from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: Restore research history, file provenance, artifact provenance, execution logs and scientific memory from an evidence package.
 * Steps:
 * 1. Create a Project and Session.
 * 2. Open the Session import action, inspect and confirm a complete .sdresearch package.
 * 3. Preview undeclared Python/JSON, PNG, empty, large and binary workspace files; download their original names and bytes.
 * 4. Confirm the conversation, exact model input, complete long reasoning, file revisions and artifact code/output are visible.
 * 5. Inspect the artifact in scientific memory and the archived task logs.
 * 6. Reload and confirm the snapshot remains read-only; create an independent research copy.
 * 7. Confirm the source notice disappears after ten seconds and stays hidden after reload.
 * 8. Compare history, artifact versions, task logs and scientific memory; edit only the copy.
 * 9. Compare necessary/complete export previews, file defaults, downloaded scope and original reasoning.
 * Environment: Isolated local API, Runner, memory graph and web stack.
 * Type: mocked
 * LLM: none; package fixture contains a historical transcript and workspace file.
 * WebSearch: none.
 * PaperSources: none.
 * MCP: none.
 * OtherExternal: none.
 * Credentials: E2E_API_TOKEN for the isolated stack only.
 * CostSideEffects: Temporary Project and Session are removed; no paid calls.
 */
test("complete research package import restores a visible Session history", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@arch:arm64", "@mocked"] }, async ({ page, journey }) => {
  page.setDefaultTimeout(15_000);
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en-US"));
  let fixture: JourneyFixture | undefined;
  const previewFiles = [
    { path: "分析 Script.py", bytes: Buffer.from('# 原始脚本\r\nif True:\r\n    print("研究")\r\n') },
    { path: "参数 Data.json", bytes: Buffer.from('{\n  "precision": 1.234567890123456789e-10,\n  "note": "原始格式"\n}\n') },
    { path: "研究 图像.PNG", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOIqpj2HwAFAAJoyXH0AwAAAABJRU5ErkJggg==", "base64") },
    { path: "empty.txt", bytes: Buffer.alloc(0) },
    { path: "large.log", bytes: Buffer.from("original log\n".repeat(30_000) + "END_OF_ORIGINAL_FILE\n") },
    { path: "raw.bin", bytes: Buffer.from([0, 255, 1, 2, 128, 13, 10]) },
  ];
  const packageFixture = researchTrajectoryFixture(previewFiles);
  const packageBytes = packageFixture.bytes;
  journey.scenario({ goal: "Restore viewable research evidence, provenance, task logs and scientific memory by importing a package.", preconditions: ["Isolated product stack with persistent memory graph", "Local historical package fixture only; no commands are executed"] });
  try {
    await journey.step("Create a Project and Session", "The target Session is ready to receive the package.", async () => {
      fixture = await createProjectAndSession(page, { projectName: `Package import ${Date.now()}`, sessionTitle: "Package target" });
      await openProjectSession(page, fixture);
    });
    await journey.step("Inspect and import from the Session menu", "The package preview is shown before import and the restored Session opens afterwards.", async () => {
      await page.getByRole("button", { name: /More actions for Package target/ }).click();
      await page.getByRole("menuitem", { name: "导入证据包", exact: true }).click();
      const chooser = page.locator(".research-export-dialog input[type=file]");
      await chooser.setInputFiles({ name: "complete.sdresearch", mimeType: "application/octet-stream", buffer: Buffer.from(packageBytes) });
      const dialog = page.getByRole("dialog", { name: "导入证据包", exact: true });
      await expect(dialog).toContainText("将导入到当前空会话");
      await dialog.getByRole("button", { name: "导入", exact: true }).click();
      await expect(dialog).toContainText("1 个会话");
      await expect(dialog.getByRole("button", { name: "创建新会话继续研究", exact: true })).toBeEnabled();
      await dialog.getByRole("button", { name: "查看导入会话", exact: true }).click();
    });
    await journey.step("Verify restored history and file", "The imported transcript is visible and its workspace object is readable from the target Session.", async () => {
      await expect(page.getByText("Imported evidence prompt visible in history")).toBeVisible();
      const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${encodeURIComponent(fixture!.session.id)}/file?path=results%2Fverified.csv`, { headers: authorizationHeader() });
      expect(response.ok()).toBeTruthy();
      expect(await response.text()).toBe("value\n42\n");
    });
    await journey.step("Compare export scope before sharing", "Necessary selects evidence files and marks trajectory limits; complete resets defaults and retains the full reasoning in its downloaded package.", async () => {
      await page.getByRole("button", { name: /More actions for Imported history/ }).click();
      await page.getByRole("menuitem", { name: "导出", exact: true }).click();
      await page.getByRole("menuitem", { name: "导出证据包", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "导出证据包", exact: true });
      await expect(dialog).toContainText("包含轨迹摘要");
      await dialog.getByText("自定义内容", { exact: true }).click();
      const result = dialog.locator("label").filter({ hasText: "results/verified.csv" }).getByRole("checkbox");
      const scratch = dialog.locator("label").filter({ hasText: "参数 Data.json" }).getByRole("checkbox");
      await expect(result).toBeChecked();
      await expect(scratch).not.toBeChecked();
      const downloadPackage = async () => {
        const pending = page.waitForEvent("download");
        await dialog.getByRole("button", { name: "导出证据包", exact: true }).click();
        const download = await pending;
        const stream = await download.createReadStream();
        if (!stream) throw new Error("Missing evidence package download");
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const response = await page.request.post(`${apiBaseUrl()}/api/projects/${fixture!.project.id}/research-package/inspect`, {
          headers: { ...authorizationHeader(), "content-type": "application/octet-stream" }, data: Buffer.concat(chunks),
        });
        expect(response.ok()).toBeTruthy();
        return response.json();
      };
      await expect(dialog.getByRole("button", { name: "导出证据包", exact: true })).toBeEnabled();
      const necessary = await downloadPackage();
      expect(necessary.manifest.exportProfile.level).toBe("necessary");
      expect(necessary.manifest.exportProfile.capabilities.fullTrajectory).toBe(false);
      expect(necessary.manifest.exportProfile.omitted.workspaceFiles).toBe(previewFiles.length);
      await page.getByRole("button", { name: /More actions for Imported history/ }).click();
      await page.getByRole("menuitem", { name: "导出", exact: true }).click();
      await page.getByRole("menuitem", { name: "导出证据包", exact: true }).click();
      await dialog.getByRole("button", { name: "完整导出", exact: false }).click();
      await expect(dialog).not.toContainText("包含轨迹摘要");
      await dialog.getByText("自定义内容", { exact: true }).click();
      await expect(scratch).toBeChecked();
      await expect(dialog.getByRole("button", { name: "导出证据包", exact: true })).toBeEnabled();
      const complete = await downloadPackage();
      expect(complete.manifest.exportProfile.level).toBe("complete");
      expect(complete.manifest.exportProfile.capabilities.fullTrajectory).toBe(true);
      expect(complete.manifest.exportProfile.included.trajectoryEvents).toBeGreaterThan(necessary.manifest.exportProfile.included.trajectoryEvents);
    });
    await journey.step("Inspect imported model input and complete reasoning", "The exact frozen input and all reasoning packets, including the final marker, remain readable after reload.", async () => {
      await page.getByRole("button", { name: "轨迹", exact: true }).click();
      const viewer = page.locator(".trajectory-view");
      for (const reload of [false, true]) {
        if (reload) await page.reload();
        await viewer.locator('.trajectory-event-list button[data-event-type="context.captured"]').click();
        await viewer.locator(".trajectory-input").getByRole("button", { name: "原始 JSON", exact: true }).click();
        await expect.poll(async () => JSON.parse(await viewer.locator(".trajectory-raw").innerText())).toEqual(packageFixture.input);
        await viewer.locator('.trajectory-event-list button[data-event-type="assistant.thinking.delta"]').click();
        expect(await viewer.locator(".trajectory-value").innerText()).toBe(packageFixture.thinking);
      }
      await page.keyboard.press("Escape");
    });
    await journey.step("Preview and download ordinary workspace files", "Undeclared Python/JSON retain their formatting; PNG renders as an image; empty, large and binary files have clear states, and icon downloads keep the original name and bytes.", async () => {
      const tree = await artifactTree(page);
      await tree.openPhysicalFiles();
      for (const file of previewFiles) {
        await page.getByRole("button", { name: `Open ${file.path}`, exact: true }).click();
        const dialog = page.locator(".workspace-file-preview-modal").getByRole("dialog");
        await expect(dialog.getByRole("heading", { name: file.path, exact: true })).toBeVisible();
        if (/\.(py|json)$/.test(file.path)) {
          expect(await dialog.getByLabel("Original file content", { exact: true }).textContent()).toBe(file.bytes.toString());
        } else if (/\.png$/i.test(file.path)) {
          const image = dialog.getByRole("img", { name: file.path, exact: true });
          await expect(image).toBeVisible();
          await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
          await expect(dialog).not.toContainText("This binary file or text encoding cannot be previewed.");
        } else if (file.path === "empty.txt") {
          await expect(dialog).toContainText("This file is empty.");
        } else if (file.path === "large.log") {
          await expect(dialog).toContainText("Download the complete original file");
          await expect(dialog.getByLabel("Original file content", { exact: true })).not.toContainText("END_OF_ORIGINAL_FILE");
        } else {
          await expect(dialog).toContainText("This binary file or text encoding cannot be previewed.");
        }
        const downloadEvent = page.waitForEvent("download");
        const downloadButton = dialog.getByRole("button", { name: "Download", exact: true });
        await expect(downloadButton.locator("svg")).toBeVisible();
        await expect(downloadButton).toHaveText("");
        await downloadButton.click();
        const download = await downloadEvent;
        expect(download.suggestedFilename()).toBe(file.path);
        const stream = await download.createReadStream();
        if (!stream) throw new Error("Download did not produce a readable original file");
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks)).toEqual(file.bytes);
        await page.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible();
      }
    });
    await journey.step("Inspect file provenance", "The generated file retains its execution, artifact v4 and two recorded revisions.", async () => {
      const tree = await artifactTree(page);
      await tree.openPhysicalFiles();
      const fileRow = page.locator(".workspace-file-tree-row").filter({ hasText: "verified.csv" });
      await fileRow.hover();
      await fileRow.getByRole("button", { name: "View provenance for results/verified.csv", exact: true }).click();
      const details = page.getByRole("dialog").filter({ has: page.locator(".workspace-provenance") });
      await expect(details).toContainText("run_shell");
      await expect(details).toContainText("v4");
      await expect(details.locator(".workspace-provenance-revisions > li")).toHaveCount(2);
    });
    await journey.step("Inspect artifact provenance", "The artifact shows its restored code and execution output.", async () => {
      await page.getByRole("button", { name: "Close detail viewer", exact: true }).click();
      const tree = await artifactTree(page);
      await tree.artifacts.filter({ hasText: "verified.csv" }).click();
      const details = page.locator(".artifact-modal-panel");
      await details.getByRole("button", { name: "Provenance", exact: true }).click();
      await expect(details).toContainText("printf");
      await expect(details).toContainText("research-output-42");
    });
    await journey.step("Inspect scientific memory", "The artifact opens its restored memory chain with four nodes and three edges.", async () => {
      const details = page.locator(".artifact-modal-panel");
      await details.getByRole("button", { name: "View this product in ScienceMemory" }).click();
      const memory = page.locator(".memory-explorer-panel");
      await expect(memory).toBeVisible();
      await expect(memory).toContainText("verified.csv");
      await memory.getByRole("button", { name: "Skip", exact: true }).click();
      await expect(memory.locator(".memory-explorer-stats")).toContainText("4 / 4 nodes");
      await expect(memory.locator(".memory-explorer-stats")).toContainText("3 / 3 edges");
    });
    await journey.step("Inspect archived task logs", "The imported completed execution shows its original output without contacting the source Runner.", async () => {
      await page.getByRole("button", { name: "Close ScienceMemory", exact: true }).click();
      // Close any artifact viewer left beneath the memory explorer.
      await page.keyboard.press("Escape");
      const tasks = page.locator('aside.workspace-panel [data-folder="tasks"]');
      if (await tasks.getAttribute("open") === null) await tasks.locator(":scope > summary").click();
      await tasks.locator("summary").filter({ hasText: "Executions" }).click();
      await tasks.locator("summary").filter({ hasText: "original-unreachable-runner" }).click();
      await tasks.getByRole("button", { name: "View logs", exact: true }).click();
      await expect(tasks.getByLabel("Execution logs")).toContainText("research-output-42");
      await expect(tasks.getByLabel("Execution logs")).toContainText("historical-warning");
      await tasks.getByLabel("Execution logs").scrollIntoViewIfNeeded();
    });
    await journey.step("Reopen imported research", "Reloading preserves the transcript, artifact and scientific memory.", async () => {
      await page.reload();
      await expect(page.getByText("Imported evidence prompt visible in history")).toBeVisible();
      const tree = await artifactTree(page);
      await expect(tree.artifacts.filter({ hasText: "verified.csv" })).toBeVisible();
      const response = await page.request.get(`${apiBaseUrl()}/api/memory/subgraph?session_id=${encodeURIComponent(fixture!.session.id)}`, { headers: authorizationHeader() });
      expect(response.ok()).toBeTruthy();
      const graph = await response.json();
      expect(graph.nodes.some((node: { label: string }) => node.label === "Artifact")).toBeTruthy();
      await tree.artifacts.filter({ hasText: "verified.csv" }).click();
      await page.locator(".artifact-modal-panel").getByRole("button", { name: "View this product in ScienceMemory" }).click();
      const memory = page.locator(".memory-explorer-panel");
      await expect(memory).toContainText("verified.csv");
      await expect(memory.locator(".memory-explorer-stats")).toContainText("4 / 4 nodes");
      await expect(memory.locator(".memory-explorer-stats")).toContainText("3 / 3 edges");
    });
    await journey.step("Continue in an independent Session", "The locked snapshot rejects writes; a new Session contains the same evidence and can be edited independently.", async () => {
      await page.getByRole("button", { name: "Close ScienceMemory", exact: true }).click();
      await page.keyboard.press("Escape");
      const sourceId = fixture!.session.id;
      const endpoint = (id: string, suffix: string) => `${apiBaseUrl()}/api/sessions/${encodeURIComponent(id)}${suffix}`;
      const read = async (id: string, suffix = "") => {
        const response = await page.request.get(endpoint(id, suffix), { headers: authorizationHeader() });
        expect(response.ok()).toBeTruthy(); return response.json();
      };
      await expect(page.locator("form.composer textarea")).toHaveCount(0);
      await expect(page.locator("form.composer .research-snapshot-composer")).toContainText("导入证据快照 · 只读");
      await expect(page.locator("form.composer").getByRole("button", { name: "创建新会话继续研究", exact: true })).toBeEnabled();
      await expect(page.locator(".research-snapshot-banner")).toHaveCount(0);
      const denied = await page.request.post(endpoint(sourceId, "/files"), { headers: authorizationHeader(), data: { path: "results/verified.csv", content: "changed" } });
      expect(denied.status()).toBe(409);
      expect((await denied.json()).code).toBe("SESSION_EVIDENCE_LOCKED");
      const original = await read(sourceId);
      const beforeRuns = await read(sourceId, "/execution-runs");
      const beforeArtifacts = await read(sourceId, "/artifacts");
      const graphFor = async (id: string) => {
        const response = await page.request.get(`${apiBaseUrl()}/api/memory/subgraph?session_id=${encodeURIComponent(id)}`, { headers: authorizationHeader() });
        expect(response.ok()).toBeTruthy(); return response.json();
      };
      const originalGraph = await graphFor(sourceId);
      for (const action of ["archive", "restore"]) {
        const response = await page.request.post(endpoint(sourceId, `/${action}`), { headers: authorizationHeader() });
        expect(response.ok()).toBeTruthy();
      }
      const stillLocked = await page.request.post(endpoint(sourceId, "/files"), { headers: authorizationHeader(), data: { path: "results/verified.csv", content: "changed" } });
      expect(stillLocked.status()).toBe(409);
      const continuationResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/api/sessions/${sourceId}/research-continuations`));
      await page.clock.install();
      await page.getByRole("button", { name: "创建新会话继续研究", exact: true }).click();
      const response = await continuationResponse;
      const operation = await response.json();
      await expect.poll(async () => (await read(sourceId, `/research-continuations/${operation.id}`)).state, { timeout: 60_000 }).toBe("ready");
      const completed = await read(sourceId, `/research-continuations/${operation.id}`);
      const retried = await page.request.post(endpoint(sourceId, "/research-continuations"), { headers: authorizationHeader(), data: response.request().postDataJSON() });
      expect(retried.ok()).toBeTruthy();
      expect(await retried.json()).toEqual(completed);
      const copyId = completed.entrySessionId;
      expect(copyId).not.toBe(sourceId);
      await expect(page.getByRole("heading", { name: /继续研究/ })).toBeVisible();
      await expect(page.locator("form.composer textarea")).toBeEnabled();
      await expect(page.locator(".research-snapshot-banner")).toContainText("New research will not change the original snapshot.");
      await page.clock.fastForward(10_000);
      await expect(page.locator(".research-snapshot-banner")).toHaveCount(0);
      await page.reload();
      await expect(page.locator("form.composer textarea")).toBeEnabled();
      await expect(page.locator(".research-snapshot-banner")).toHaveCount(0);
      const copied = await read(copyId);
      const copiedTrajectory = await read(copyId, "/trajectory");
      for (const entry of copiedTrajectory.entries as { id: string; kind: string }[]) {
        const detail = await read(copyId, `/trajectory/detail?id=${encodeURIComponent(entry.id)}`);
        expect(detail.context.input).toEqual(packageFixture.input);
        if (entry.kind === "thinking") expect(detail.value.packets.map((packet: { event: { delta: string } }) => packet.event.delta).join("")).toBe(packageFixture.thinking);
      }
      for (const file of previewFiles) {
        const response = await page.request.get(endpoint(copyId, `/file?path=${encodeURIComponent(file.path)}`), { headers: authorizationHeader() });
        expect(response.ok()).toBeTruthy();
        expect(await response.body()).toEqual(file.bytes);
      }
      expect(copied.messages.map(({ content, role, createdAt }: { content: string; role: string; createdAt: string }) => ({ content, role, createdAt }))).toEqual(original.messages.map(({ content, role, createdAt }: { content: string; role: string; createdAt: string }) => ({ content, role, createdAt })));
      expect((await read(copyId, "/execution-runs")).length).toBe(beforeRuns.length);
      const copiedArtifacts = await read(copyId, "/artifacts");
      expect(copiedArtifacts).toHaveLength(beforeArtifacts.length);
      const versions = await read(copyId, `/artifacts/${copiedArtifacts[0].id}/versions`);
      expect(versions[0].version).toBe(4);
      const provenance = await read(copyId, "/workspace/provenance?path=results%2Fverified.csv");
      expect(provenance.revisions).toHaveLength(2);
      expect(provenance.currentRevision.artifactVersionIds).toContain(versions[0].id);
      const graph = await graphFor(copyId);
      expect(graph.nodes).toHaveLength(originalGraph.nodes.length);
      expect(graph.edges).toHaveLength(originalGraph.edges.length);
      const changed = await page.request.post(endpoint(copyId, "/files"), { headers: authorizationHeader(), data: { path: "results/verified.csv", content: "value\n99\n" } });
      expect(changed.ok()).toBeTruthy();
      const originalFile = await page.request.get(endpoint(sourceId, "/file?path=results%2Fverified.csv"), { headers: authorizationHeader() });
      expect(await originalFile.text()).toBe("value\n42\n");
      expect((await read(sourceId)).messages).toEqual(original.messages);
      expect(await graphFor(sourceId)).toEqual(originalGraph);
    });
  } finally {
    if (fixture) await cleanupJourney(page, fixture);
  }
});

/**
 * E2E-META
 * Purpose: Copy a research question and branch a completed reply with inherited evidence and a persistent return link.
 * Steps:
 * 1. Import historical research into an empty Session and open its transcript.
 * 2. Copy the user question and verify the clipboard content and success feedback.
 * 3. Branch the completed reply and verify the writable chat, inherited artifact and source reference.
 * 4. Reload, return to the source reply and verify the original snapshot remains read-only.
 * Environment: Isolated local API, Runner, memory graph and web stack.
 * Type: mocked
 * LLM: none; the imported fixture provides the completed research reply.
 * WebSearch: none.
 * PaperSources: none.
 * MCP: none.
 * OtherExternal: none.
 * Credentials: E2E_API_TOKEN for the isolated stack only.
 * CostSideEffects: Temporary Project and Sessions are removed; no paid calls.
 */
test("copy a user message and branch a completed research reply", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@arch:arm64", "@mocked"] }, async ({ page, journey }) => {
  let fixture: JourneyFixture | undefined;
  await page.addInitScript(() => {
    localStorage.setItem("sciencediscovery-locale", "en-US");
    // Capture the clipboard API boundary without depending on OS clipboard permissions.
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { localStorage.setItem("journey-copied-message", text); },
    } });
  });
  journey.scenario({ goal: "Copy a research question and continue a completed reply in an independent chat with a persistent way back.",
    preconditions: ["Isolated product stack and scientific memory", "Historical evidence fixture; no live model requests"] });
  try {
    let sourceMessageId = "";
    let branchId = "";
    await journey.step("Open historical research", "The imported question and completed reply are visible.", async () => {
      fixture = await createProjectAndSession(page, { projectName: `Chat branch ${Date.now()}`, sessionTitle: "Branch target" });
      const imported = await page.request.post(`${apiBaseUrl()}/api/projects/${fixture.project.id}/research-package/import?sessionId=${fixture.session.id}`,
        { headers: authorizationHeader(), data: Buffer.from(researchTrajectoryFixture().bytes) });
      expect(imported.ok()).toBeTruthy();
      const source = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture.session.id}`, { headers: authorizationHeader() });
      sourceMessageId = (await source.json()).messages[1].id;
      await openProjectSession(page, fixture);
    });
    await journey.step("Copy the user question", "The clipboard receives the original question and the copy action reports success.", async () => {
      await page.locator("article.message.user").getByRole("button", { name: "Copy message", exact: true }).click();
      await expect.poll(() => page.evaluate(() => localStorage.getItem("journey-copied-message"))).toBe("Imported evidence prompt visible in history");
      await expect(page.locator("article.message.user .copy-button")).toHaveClass(/copied/);
    });
    await journey.step("Branch the assistant reply", "One new writable chat opens with inherited evidence and a return boundary.", async () => {
      expect(await page.locator("article.message.user .message-more-button").count()).toBe(0);
      const response = page.waitForResponse((item) => item.request().method() === "POST" && item.url().endsWith("/conversation-branches"));
      await page.getByRole("button", { name: "More reply actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Branch to new chat", exact: true }).click();
      const operation = await (await response).json();
      const endpoint = `${apiBaseUrl()}/api/sessions/${fixture!.session.id}/research-continuations/${operation.id}`;
      await expect.poll(async () => (await (await page.request.get(endpoint, { headers: authorizationHeader() })).json()).state, { timeout: 60_000 }).toBe("ready");
      branchId = (await (await page.request.get(endpoint, { headers: authorizationHeader() })).json()).entrySessionId;
      await expect(page.getByRole("button", { name: "Continue from chat", exact: true })).toBeVisible();
      await expect(page.locator("form.composer textarea")).toBeEnabled();
      const tree = await artifactTree(page);
      await expect(tree.artifacts.filter({ hasText: "verified.csv" })).toBeVisible();
      const branch = await page.request.get(`${apiBaseUrl()}/api/sessions/${branchId}`, { headers: authorizationHeader() });
      expect((await branch.json()).conversationBranch.sourceMessageId).toBe(sourceMessageId);
    });
    await journey.step("Reload and return to the source", "The boundary survives reload and returns to the source reply without changing the imported snapshot.", async () => {
      await page.reload();
      await page.getByRole("button", { name: "Continue from chat", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Imported history", exact: true })).toBeVisible();
      await expect(page.locator(`#chat-message-${sourceMessageId}`)).toBeFocused();
      await expect(page.locator("form.composer textarea")).toBeDisabled();
      await expect(page.getByRole("button", { name: "Continue from chat", exact: true })).toHaveCount(0);
    });
  } finally {
    if (fixture) await cleanupJourney(page, fixture);
  }
});
