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

/**
 * The right column after it is open: the artifact list across Sessions, the two
 * searches, the version picker, a failed read, and the list divider.
 *
 * These are all states a render alone cannot prove. A group folds, a search
 * changes what the list holds, a picker replaces the document in a tab that
 * stays where it is, and a divider is driven by keys as well as the pointer.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  CREATED_AT,
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  makeSession,
  type JsonRecord,
  type Mock,
  type MockOptions,
} from "./fixtures.js";

const SESSION = "session-1";
const OTHER_SESSION = "session-2";
/** The title `makeSession()` gives the open Session; the artifact records below
 *  are headed by it unless a case says otherwise. */
const SESSION_TITLE = "晶体结构分析";

/** One artifact and one of its versions, in the shape the API answers with. */
function output(
  artifactId: string,
  version: number,
  over: { name?: string; path?: string; sessionId?: string; sessionTitle?: string; title?: string } = {},
): JsonRecord {
  const name = over.name ?? `${artifactId}.md`;
  return {
    artifact: {
      createdAt: "2026-10-01T08:00:00.000Z",
      // The heading a group falls back to when the Session is not in the
      // sidebar's listing: the server records the title the artifact was
      // written under, which is the Session's — never the artifact's own.
      createdInSessionTitle: over.sessionTitle ?? SESSION_TITLE,
      id: artifactId,
      kind: "document",
      logicalName: name,
      name,
      origin: "run",
      projectId: "project-1",
      sessionId: over.sessionId ?? SESSION,
      title: over.title ?? artifactId,
      updatedAt: "2026-10-01T09:30:00.000Z",
    },
    version: {
      artifactId,
      content: { hash: `sha256:${artifactId}` },
      createdAt: "2026-10-01T09:30:00.000Z",
      executionRunIds: [],
      id: `${artifactId}-v${version}`,
      inputArtifactVersionIds: [],
      mediaType: "text/markdown",
      projectId: "project-1",
      sessionId: over.sessionId ?? SESSION,
      sourcePath: over.path ?? `reports/${name}`,
      version,
    },
  };
}

function calls(mock: Mock, path: string): JsonRecord[] {
  return mock.calls.filter((entry) => entry.method === "GET" && entry.path === path);
}

async function openPanel(page: Page): Promise<Locator> {
  await page.goto("/");
  await page.getByRole("button", { name: "工作区面板" }).click();
  const panel = page.locator(".workspace-panel");
  await expect(panel).toBeVisible();
  return panel;
}

async function openArtifacts(page: Page): Promise<Locator> {
  const panel = await openPanel(page);
  await panel.getByRole("tab", { name: "产物" }).click();
  return panel;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test.describe("产物列表", () => {
  test("every Session's group folds on its own, the open one first and open", async ({ page }) => {
    const mock = await installMockApi(page, {
      artifactContents: {
        "artifact-1-v1": "晶格图的内容",
        "artifact-2-v1": "轨道图的内容",
      },
      artifactsBySession: {
        [SESSION]: [output("artifact-1", 1, { sessionTitle: "晶体结构分析", title: "晶格图" })],
        [OTHER_SESSION]: [output("artifact-2", 1, {
          sessionId: OTHER_SESSION,
          sessionTitle: "轨道分析",
          title: "轨道图",
        })],
      },
      sessions: [
        makeSession(),
        makeSession({ id: OTHER_SESSION, title: "轨道分析" }),
      ],
    });
    const panel = await openArtifacts(page);

    const current = panel.locator(".panel-output").filter({ hasText: "晶体结构分析" });
    const other = panel.locator(".panel-output").filter({ hasText: "轨道分析" });
    await expect(current).toContainText("当前会话");
    await expect(current.getByRole("button", { name: "晶格图" })).toBeVisible();
    // A Session the reader is not in starts folded; its heading is the way in.
    await expect(other.getByRole("button", { name: "轨道图" })).toHaveCount(0);

    await other.locator(".panel-output-head").click();
    await other.getByRole("button", { name: "轨道图" }).click();

    // The row opens the version it shows, through the Session that wrote it.
    await expect(panel.locator(".doc-body")).toContainText("轨道图的内容");
    expect(calls(mock, `/api/sessions/${OTHER_SESSION}/artifact-versions/artifact-2-v1/content`)).toHaveLength(1);
    // The Session the panel opened on is read by the boot listing and again by
    // the panel's own refresh; a Session the reader is not in is read once.
    expect(calls(mock, `/api/sessions/${OTHER_SESSION}/artifact-outputs`)).toHaveLength(1);
  });

  test("the search matches the name and the folder, and says when nothing does", async ({ page }) => {
    await installMockApi(page, {
      artifacts: [
        output("artifact-1", 1, { name: "plot.png", path: "figures/plot.png", title: "晶格图" }),
        output("artifact-2", 1, { name: "data.csv", path: "tables/data.csv", title: "数据表" }),
      ],
      sessions: [makeSession()],
    });
    const panel = await openArtifacts(page);
    const search = panel.getByLabel("搜索产物");

    // The path is searchable: two artifacts can share a name, and the folder is
    // the only thing that tells them apart.
    await search.fill("figures");
    await expect(panel.getByRole("button", { name: "晶格图" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "数据表" })).toHaveCount(0);

    await search.fill("数据");
    await expect(panel.getByRole("button", { name: "数据表" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "晶格图" })).toHaveCount(0);

    await search.fill("没有这个");
    await expect(panel.locator(".panel-empty")).toHaveText("没有匹配的内容。");

    await search.fill("");
    await expect(panel.getByRole("button", { name: "晶格图" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "数据表" })).toBeVisible();
  });

  test("the workspace tree narrows to the matching files and their folders", async ({ page }) => {
    await installMockApi(page, {
      files: [
        { modifiedAt: "2026-10-01T09:30:00.000Z", path: "data/a.csv", size: 16 },
        { modifiedAt: "2026-10-01T09:30:00.000Z", path: "notes.md", size: 32 },
      ],
      sessions: [makeSession()],
    });
    const panel = await openPanel(page);
    // The panel opens on 产物; the file tree is a click away.
    await panel.getByRole("tab", { name: "工作区" }).click();
    const search = panel.getByLabel("搜索文件");
    await expect(panel.getByRole("button", { name: /notes\.md/u })).toBeVisible();

    await search.fill("data");
    await expect(panel.getByRole("button", { name: /a\.csv/u })).toBeVisible();
    await expect(panel.getByRole("button", { name: /notes\.md/u })).toHaveCount(0);

    await search.fill("没有这个");
    await expect(panel.locator(".panel-empty")).toHaveText("没有匹配的内容。");
  });
});

test.describe("版本", () => {
  test("a row opens the newest version and the picker replaces it in the same tab", async ({ page }) => {
    const mock = await installMockApi(page, {
      artifactContents: {
        "artifact-1-v2": "上一版本的内容",
        "artifact-1-v3": "最新版本的内容",
      },
      artifacts: [
        output("artifact-1", 1, { title: "综述", path: "reports/summary.md" }),
        output("artifact-1", 2, { title: "综述", path: "reports/summary.md" }),
        output("artifact-1", 3, { title: "综述", path: "reports/summary.md" }),
      ],
      sessions: [makeSession()],
    });
    const panel = await openArtifacts(page);

    // One row per artifact, not per version: versions live behind the picker.
    await expect(panel.getByRole("button", { name: "综述" })).toHaveCount(1);
    await panel.getByRole("button", { name: "综述" }).click();
    await expect(panel.locator(".doc-body")).toContainText("最新版本的内容");
    await expect(panel.getByRole("button", { name: "版本" })).toHaveText("v3");

    await panel.getByRole("button", { name: "版本" }).click();
    const menu = panel.getByRole("menu", { name: "版本" });
    await expect(menu.getByRole("menuitemradio")).toHaveText(["v3", "v2", "v1"]);
    await expect(menu.getByRole("menuitemradio", { name: "v3" })).toHaveAttribute("aria-checked", "true");

    await menu.getByRole("menuitemradio", { name: "v2" }).click();

    await expect(panel.locator(".doc-body")).toContainText("上一版本的内容");
    await expect(panel.getByRole("button", { name: "版本" })).toHaveText("v2");
    // The version is a property of the open document: still one tab.
    await expect(panel.locator(".doc-tab-label")).toHaveCount(1);
    expect(calls(mock, `/api/sessions/${SESSION}/artifact-versions/artifact-1-v2/content`)).toHaveLength(1);
  });

  test("Escape closes the picker and hands focus back to its trigger", async ({ page }) => {
    await installMockApi(page, {
      artifacts: [
        output("artifact-1", 1, { title: "综述" }),
        output("artifact-1", 2, { title: "综述" }),
      ],
      sessions: [makeSession()],
    });
    const panel = await openArtifacts(page);
    await panel.getByRole("button", { name: "综述" }).click();

    const trigger = panel.getByRole("button", { name: "版本" });
    await trigger.click();
    await expect(panel.getByRole("menu", { name: "版本" })).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(panel.getByRole("menu", { name: "版本" })).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

test.describe("读取失败", () => {
  test("a document that could not be read says why, and clicking the row again retries it", async ({ page }) => {
    const options: MockOptions = {
      artifactContents: { "artifact-1-v1": "综述的正文" },
      artifacts: [output("artifact-1", 1, { title: "综述" })],
      fail: {
        message: "artifact bytes are missing",
        method: "GET",
        path: /artifact-versions\/artifact-1-v1\/content/u,
      },
      sessions: [makeSession()],
    };
    const mock = await installMockApi(page, options);
    const panel = await openArtifacts(page);

    await panel.getByRole("button", { name: "综述" }).click();
    await expect(panel.locator(".doc-body .panel-empty")).toContainText("artifact bytes are missing");

    // A failed tab is filled again by the next click rather than being left as
    // a dead end, and the tab itself stays where it is instead of flickering
    // between two entries.
    delete options.fail;
    await panel.getByRole("button", { name: "综述" }).click();

    await expect(panel.locator(".doc-body")).toContainText("综述的正文");
    await expect(panel.locator(".doc-tab-label")).toHaveCount(1);
    expect(calls(mock, `/api/sessions/${SESSION}/artifact-versions/artifact-1-v1/content`)).toHaveLength(2);
  });
});

test.describe("子代理的运行记录", () => {
  const RUN = "run-1";
  const CHILD = "child-1";
  const DESCRIPTION = "排序候选结构";
  const ANSWER = "前三个结构的排名是稳定的。";

  /**
   * A Session whose one finished run delegated a child.
   *
   * The two halves of the record are where the product keeps them: the run's
   * log holds the snapshot that names the task and its status, and the catalog
   * holds the steps — a run stream deliberately keeps a child without them,
   * which is what the panel's own read of `.../subagents` is for. The snapshot
   * still carries an empty `steps` array, as the server's does.
   */
  function recorded(): MockOptions {
    const snapshot = {
      createdAt: CREATED_AT,
      id: CHILD,
      input: { description: DESCRIPTION, prompt: "按能量排序。", subagentType: "general-purpose" },
      maxTurns: 12,
      parentTurnId: "turn-1",
      sessionId: SESSION,
      status: "completed",
      steps: [],
      timeoutSeconds: 600,
      turnCount: 3,
    };
    const answer = "我把候选结构交给了一个子任务。";
    const run = {
      assistantMessageId: "message-assistant",
      createdAt: CREATED_AT,
      finishedAt: CREATED_AT,
      id: RUN,
      prompt: "分析晶体结构",
      queueOrder: 0,
      sessionId: SESSION,
      status: "completed",
      userMessageId: "message-user",
    };
    return {
      runsBySession: {
        [SESSION]: [{
          // The tail is the run's own ending, and it is what makes the replay a
          // finished one: without it the folded line would read as still going.
          events: [
            { model: { name: "Qwen Max" }, runId: RUN, settings: {}, type: "run.started" },
            { responseId: "response-1", turn: 1, type: "assistant.response.started" },
            { delta: answer, responseId: "response-1", turn: 1, type: "assistant.delta" },
            { subagent: snapshot, type: "subagent.updated" },
            {
              files: [],
              message: { content: answer, createdAt: CREATED_AT, id: "message-assistant", role: "assistant" },
              type: "run.completed",
            },
            { run, status: "completed", type: "run.status" },
          ],
          run,
        }],
      },
      sessions: [makeSession({
        messages: [
          { content: "分析晶体结构", createdAt: CREATED_AT, id: "message-user", role: "user" },
          { content: "存下来的回答。", createdAt: CREATED_AT, id: "message-assistant", role: "assistant" },
        ],
      })],
      subagentsBySession: {
        [SESSION]: [{
          ...snapshot,
          steps: [
            { content: "先看三组候选结构。", createdAt: CREATED_AT, id: "step-1", kind: "assistant", status: "completed" },
            { content: ANSWER, createdAt: CREATED_AT, id: "step-2", kind: "assistant", status: "completed" },
          ],
        }],
      },
    };
  }

  test("the line opens its record, a second press keeps it, and the panel's own control closes it", async ({ page }) => {
    await installMockApi(page, recorded());
    await page.goto("/");
    // The child's line is part of the run's own fold, where it was delegated.
    await page.locator(".run-fold summary").click();
    const line = page.getByRole("button", { name: `Subagent ${DESCRIPTION}` });
    await line.click();

    const panel = page.locator(".workspace-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".subagent-output")).toContainText(ANSWER);
    // A record is a mode of the panel, not a third tab beside the groups.
    await expect(panel.getByRole("tab")).toHaveCount(0);

    // The line is a row the reader chose to read. Pressing it again asks for the
    // same thing; taking the record away would read as a misread, not a choice.
    await line.click();
    await expect(panel.locator(".subagent-output")).toContainText(ANSWER);
    await expect(panel.getByRole("tab")).toHaveCount(0);

    await panel.getByRole("button", { name: "返回产物和文件" }).click();
    await expect(panel.getByRole("tab", { name: "产物" })).toBeVisible();
    await expect(panel.locator(".subagent-detail")).toHaveCount(0);
  });
});

test.describe("列表分隔条", () => {
  test("the divider is a separator the arrow keys resize, and the way back when the document closes", async ({ page }) => {
    await installMockApi(page, {
      artifacts: [output("artifact-1", 1, { title: "综述" })],
      sessions: [makeSession()],
    });
    const panel = await openArtifacts(page);

    const divider = panel.getByRole("separator", { name: "调整列表宽度" });
    const value = async () => Number(await divider.getAttribute("aria-valuenow"));
    await divider.focus();

    // The list starts at whatever width the panel measured, so the case proves
    // the direction of the step rather than a fixed number.
    const start = await value();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(value).toBeLessThan(start);
    await expect(panel.locator(".panel-body")).toHaveAttribute(
      "style",
      new RegExp(`--panel-list-width: ${await value()}px`, "u"),
    );

    // Past the widest the list may be, the document column snaps shut and the
    // divider becomes the way back rather than a resize handle.
    for (let step = 0; step < 20; step += 1) await page.keyboard.press("ArrowRight");
    const restore = panel.getByRole("separator", { name: "展开" });
    await expect(restore).toBeVisible();
    await restore.focus();
    await page.keyboard.press("Enter");

    // Enter on a closed column restores the default split instead of nudging.
    await expect(panel.getByRole("separator", { name: "调整列表宽度" })).toHaveAttribute(
      "aria-valuenow",
      /^[1-9]\d*$/u,
    );
  });
});
