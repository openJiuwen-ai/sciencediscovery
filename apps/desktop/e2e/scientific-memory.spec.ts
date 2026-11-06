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
 * 科学记忆 as a citation, not a library: a final report's `[evidence1]` and
 * `[artifact1]` render as chips, a chip opens a card with the node's own
 * fields and the linear walk behind it, and 设置 › 科学记忆 says whether the
 * service answers right now.
 *
 * The old full-screen card list is gone on purpose. These tests assert the
 * reader's path through a report — open it, press a citation, read the card —
 * plus the two places a failure has to be visible: the card when the service
 * is off or gone, and the state beside the switch that decides it.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  makeSession,
  type JsonRecord,
  type Mock,
  type MockOptions,
} from "./fixtures.js";

const SESSION = "session-1";

const EVIDENCE: JsonRecord = {
  label: "Evidence",
  id: "evidence-1",
  sessionId: SESSION,
  excerpt: "甲烷转化率提升至 92%",
  createdAt: "2026-10-01T10:00:00.000Z",
  extra: {
    confidence: "high",
    content: "在 350 °C 下，甲烷转化率提升至 92%。",
    evidence_id: "evidence-1",
    evidence_type: "measurement",
    locator: "图 2",
    strength: "strong",
  },
};

const REPORT: JsonRecord = {
  label: "Artifact",
  id: "artifact-report#v1",
  sessionId: SESSION,
  excerpt: "report.md",
  createdAt: "2026-10-01T09:00:00.000Z",
  extra: {
    artifact_id: "artifact-report",
    content_hash: "sha256:report",
    logical_name: "report.md",
    media_type: "text/markdown",
    path: "/runs/one/report.md",
    session_id: SESSION,
    version: 1,
  },
};

/** The artifact the report cites as its raw data. It is a real artifact in
 *  the panel too, so 在产物面板中打开 has somewhere to land. */
const INPUT: JsonRecord = {
  label: "Artifact",
  id: "artifact-input#v1",
  sessionId: SESSION,
  excerpt: "previous.csv",
  createdAt: "2026-10-01T08:00:00.000Z",
  extra: {
    artifact_id: "artifact-input",
    logical_name: "previous.csv",
    media_type: "text/csv",
    path: "/runs/one/previous.csv",
    session_id: SESSION,
    version: 1,
  },
};

const PAPER: JsonRecord = {
  label: "Paper",
  id: "paper-1",
  extra: {
    abstract: "Methane conversion over a nickel catalyst rises with temperature up to 350 °C.",
    identifier: "10.1000/example",
    title: "A paper on methane",
  },
};

const CLAIM: JsonRecord = {
  label: "Claim",
  id: "claim-1",
  extra: { content: "Methane conversion is high" },
};

function chain(nodes: JsonRecord[]): JsonRecord {
  return { edges: [], nodes, total: nodes.length, truncated: false };
}

/** Evidence shows only what it was extracted from. The claim is here because
 *  the graph can walk to it; the tab must not, so the test can tell the two
 *  apart by the request it makes. */
const MEMORY: NonNullable<MockOptions["memory"]> = {
  hits: [EVIDENCE, REPORT, INPUT],
  chains: {
    "evidence-1|viewSourcePaper": chain([EVIDENCE, PAPER]),
    "evidence-1|viewCitingClaimForEvidence": chain([EVIDENCE, CLAIM]),
  },
};

const REPORT_BODY = "# 报告\n\n甲烷转化率提升 [evidence1]。原始数据见 [artifact1]。\n";

const REPORT_REFERENCES = [
  { id: "evidence-1", kind: "evidence", label: "evidence1" },
  { id: "artifact-input", kind: "artifact", label: "artifact1", version: 1 },
];

/** One artifact and one of its versions, in the shape the API answers with. */
function output(
  artifactId: string,
  version: number,
  over: {
    kind?: string;
    mediaType?: string;
    name: string;
    references?: JsonRecord[];
    versionId: string;
  },
): JsonRecord {
  return {
    artifact: {
      createdAt: "2026-10-01T08:00:00.000Z",
      createdInSessionId: SESSION,
      createdInSessionTitle: "晶体结构分析",
      currentVersion: version,
      id: artifactId,
      kind: over.kind ?? "markdown",
      logicalName: over.name,
      name: over.name,
      origin: "run",
      projectId: "project-1",
      sessionId: SESSION,
      updatedAt: "2026-10-01T09:00:00.000Z",
    },
    version: {
      artifactId,
      content: { hash: `sha256:${artifactId}`, size: 18 },
      createdAt: "2026-10-01T09:00:00.000Z",
      executionRunIds: [],
      id: over.versionId,
      inputArtifactVersionIds: [],
      mediaType: over.mediaType ?? "text/markdown",
      projectId: "project-1",
      references: over.references,
      sessionId: SESSION,
      sourcePath: `/runs/one/${over.name}`,
      version,
    },
  };
}

const REPORT_OUTPUT = output("artifact-report", 1, {
  name: "report.md",
  references: REPORT_REFERENCES,
  versionId: "version-1",
});

const INPUT_OUTPUT = output("artifact-input", 1, {
  kind: "table",
  mediaType: "text/csv",
  name: "previous.csv",
  versionId: "input-version-1",
});

/** A second artifact, derived from like any other input: the 溯源 tab lists it
 *  beside the uploaded file, and pressing it is what opens the panel. */
const TREND_OUTPUT = output("artifact-trend", 1, {
  kind: "table",
  mediaType: "text/csv",
  name: "trend.csv",
  versionId: "trend-version-1",
});

/** The cited artifact's own record of how it was made, as the 溯源 tab reads
 *  it: the file it was derived from, the code that wrote it, the execution log
 *  and the environment that run used. */
const INPUT_PROVENANCE: JsonRecord = {
  code: [{
    code: "df = pd.read_csv('raw.csv')\ndf.to_csv('previous.csv')",
    language: "python",
    runId: "run-1a2b3c4d5e6f",
    tool: "python",
  }],
  dependencies: [{
    artifact: {
      id: "source-raw",
      kind: "dataset",
      logicalName: "raw.csv",
      name: "raw.csv",
    },
    kind: "source_file",
    version: { id: "source-version-1", version: 1 },
  }, {
    artifact: {
      id: "artifact-trend",
      kind: "table",
      logicalName: "trend.csv",
      name: "trend.csv",
    },
    kind: "artifact",
    version: { id: "trend-version-1", version: 1 },
  }],
  environments: [{
    id: "env-1",
    language: "python",
    languageVersion: "3.12",
    packages: ["pandas=2.2.3"],
    platform: "linux-64",
    provisioner: "micromamba",
  }],
  executionLog: [{
    exitCode: 0,
    finishedAt: "2026-10-01T08:30:00.000Z",
    processEnvironment: { OMP_NUM_THREADS: "4" },
    runId: "run-1a2b3c4d5e6f",
    status: "succeeded",
    stderr: "",
    stdout: "wrote previous.csv",
    workingDirectory: "/runs/one",
  }],
  messages: [],
  review: [],
  version: INPUT_OUTPUT.version,
};

/** A document long enough that both of the dialog's tabs scroll: reading down
 *  the preview is what leaves the body at an offset when the tab changes. */
const LONG_SECTIONS = Array.from(
  { length: 60 },
  (_, index) => `## 第 ${index + 1} 节\n\n第 ${index + 1} 节的正文。`,
).join("\n\n");
const LONG_CODE = Array.from(
  { length: 80 },
  (_, index) => `frame_${index + 1} = pd.read_csv('raw_${index + 1}.csv')`,
).join("\n");

const LONG_OUTPUT = output("artifact-long", 1, {
  kind: "markdown",
  mediaType: "text/markdown",
  name: "long.md",
  versionId: "long-version-1",
});

const LONG_PROVENANCE: JsonRecord = {
  ...INPUT_PROVENANCE,
  code: [{ code: LONG_CODE, language: "python", runId: "run-1a2b3c4d5e6f", tool: "python" }],
  version: { id: "long-version-1", version: 1 },
};

const LONG_REPORT = output("artifact-report-long", 1, {
  name: "long-report.md",
  references: [
    { id: "evidence-1", kind: "evidence", label: "evidence1" },
    { id: "artifact-long", kind: "artifact", label: "artifact1", version: 1 },
  ],
  versionId: "long-report-version-1",
});

const LONG_REPORT_BODY = "# 报告\n\n甲烷转化率提升 [evidence1]。长文见 [artifact1]。\n";

/** Open the workspace panel on 产物 and open the report, which renders its
 *  citations as chips. */
async function openReport(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "工作区面板" }).click();
  const panel = page.locator(".workspace-panel");
  await panel.getByRole("tab", { name: "产物" }).click();
  await panel.getByRole("button", { name: "report.md" }).click();
  await expect(panel.locator(".doc-body")).toContainText("甲烷转化率提升");
  return panel;
}

function lastCall(mock: Mock, path: string): JsonRecord | undefined {
  return mock.calls.filter((call) => call.path === path).at(-1);
}

/** How many times the page asked the control plane how it is doing. */
function healthCalls(mock: Mock): number {
  return mock.calls.filter((call) => call.path === "/api/health").length;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("a report's evidence chip opens its details and provenance", async ({ page }) => {
  const mock = await installMockApi(page, {
    artifactContents: {
      "input-version-1": "样品,强度\nA,12.5\n",
      "version-1": REPORT_BODY,
    },
    artifactsBySession: { [SESSION]: [REPORT_OUTPUT, INPUT_OUTPUT] },
    memory: MEMORY,
    sessions: [makeSession()],
  });
  await page.goto("/");
  const panel = await openReport(page);

  // The chip is the alias the report wrote, with no second vocabulary.
  const chips = panel.locator(".graph-chip");
  await expect(chips).toHaveText(["evidence1", "artifact1"]);

  await chips.nth(0).click();
  const dialog = page.locator(".memory-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".memory-kind-chip")).toHaveText("证据");
  await expect(dialog.locator("h2")).toHaveText("在 350 °C 下，甲烷转化率提升至 92%。");
  // 预览 is the old UI's evidence tab: the claim, then a compact meta strip.
  await expect(dialog.getByRole("button", { name: "预览" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.locator(".evidence-content-text")).toHaveText("在 350 °C 下，甲烷转化率提升至 92%。");
  await expect(dialog.locator(".evidence-meta-prop").filter({ hasText: "图 2" })).toHaveCount(1);
  await expect(dialog.locator(".evidence-meta-prop").filter({ hasText: "measurement" })).toHaveCount(1);

  // The detail read is one scoped request, not a graph dump.
  const call = lastCall(mock, "/api/memory/query/by-node-type");
  expect(JSON.parse(call!.body!)).toEqual({ node_types: ["Evidence"], session_id: SESSION });

  // Provenance is one paper card, as in the old UI: no numbered step, no
  // "来源" heading, and the abstract is the body of the card.
  await dialog.getByRole("button", { name: "溯源" }).click();
  await expect(dialog.locator(".evidence-source-paper")).toHaveCount(1);
  await expect(dialog.locator(".evidence-source-paper-label")).toHaveText("文献");
  await expect(dialog.locator(".evidence-source-paper-title")).toHaveText("A paper on methane");
  await expect(dialog.locator(".evidence-source-paper-abstract")).toHaveText(
    "Methane conversion over a nickel catalyst rises with temperature up to 350 °C.",
  );
  await expect(dialog.getByText("来源", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Methane conversion is high")).toHaveCount(0);
  const chainCalls = mock.calls.filter((call) => call.path === "/api/memory/query/chain");
  expect(chainCalls).toHaveLength(1);
  expect(JSON.parse(chainCalls[0]!.body!).kind).toBe("viewSourcePaper");
});

test("a report's artifact chip opens the artifact itself, in a dialog over the report", async ({ page }) => {
  const mock = await installMockApi(page, {
    artifactContents: {
      "input-version-1": "样品,强度\nA,12.5\n",
      "version-1": REPORT_BODY,
    },
    artifactProvenance: { "input-version-1": INPUT_PROVENANCE },
    artifactsBySession: { [SESSION]: [REPORT_OUTPUT, INPUT_OUTPUT] },
    artifactVersions: { [`${SESSION}|artifact-input`]: [INPUT_OUTPUT.version] },
    memory: MEMORY,
    sessions: [makeSession()],
  });
  await page.goto("/");
  const panel = await openReport(page);

  // Record what the dialog holds the first moment it exists in the DOM. The
  // frame is drawn from the press — the title comes from the reference the
  // report cited, not from the answer that follows — so the reader gets the
  // dialog without waiting for two round trips.
  await page.evaluate(() => {
    const record = window as unknown as { firstFrame?: unknown };
    record.firstFrame = null;
    new MutationObserver(() => {
      if (record.firstFrame !== null) return;
      const dialog = document.querySelector(".artifact-dialog");
      if (dialog === null) return;
      record.firstFrame = {
        hasTitle: dialog.querySelector(".artifact-dialog-head h2") !== null,
      };
    }).observe(document.body, { childList: true, subtree: true });
  });

  // The chip is a way into the artifact, not into a description of it: a
  // dialog in the middle of the window draws the same document the 产物 row
  // does, the report stays open behind it, and nothing reads the graph.
  await panel.locator(".graph-chip").nth(1).click();
  const dialog = page.locator(".artifact-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".memory-kind-chip")).toHaveText("table");
  await expect(dialog.locator("h2")).toHaveText("previous.csv");
  await expect(dialog.locator(".artifact-dialog-source")).toHaveText("更新于会话 晶体结构分析");
  await expect(dialog.locator(".data-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".memory-dialog")).toHaveCount(0);
  // The press draws the frame before the bytes land: at the first moment a
  // dialog exists in the DOM it already names the artifact it is opening.
  const firstFrame = await page.evaluate(
    () => (window as unknown as { firstFrame: { hasTitle: boolean } }).firstFrame,
  );
  expect(firstFrame.hasTitle).toBe(true);
  // The old UI's tabs, and the version download beside them.
  await expect(dialog.getByRole("button", { name: "预览" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: "下载当前版本" })).toBeEnabled();
  // The report the reader was in is still the panel's open document.
  await expect(panel.locator(".doc-tab.is-active .doc-tab-name")).toHaveText("report.md");
  expect(mock.calls.filter((call) => call.path.startsWith("/api/memory/"))).toHaveLength(0);

  // 溯源 is the version's own record, as the old UI showed it: the file it was
  // derived from, the code that wrote it, the execution log and its
  // environment. Nothing here is a graph read.
  await dialog.getByRole("button", { name: "溯源" }).click();
  const provenance = dialog.locator(".memory-artifact-provenance");
  await expect(provenance).toBeVisible();
  await expect(provenance.locator(".memory-dependency.is-file")).toHaveText("raw.csv");
  await expect(provenance.locator(".memory-code-body")).toContainText("pd.read_csv");
  await expect(provenance.getByRole("button", { name: "下载脚本" })).toBeVisible();
  await expect(provenance.locator(".memory-log-body")).toContainText("wrote previous.csv");
  await expect(provenance.locator(".memory-process-environment")).toContainText("进程环境");
  await expect(provenance.locator(".memory-environment")).toContainText("pandas=2.2.3");
  expect(mock.calls.filter((call) => call.path.startsWith("/api/memory/"))).toHaveLength(0);

  // Escape returns to the report without changing either surface.
  await page.keyboard.press("Escape");
  await expect(page.locator(".artifact-dialog")).toHaveCount(0);
  await expect(panel.locator(".doc-tab.is-active .doc-tab-name")).toHaveText("report.md");
});

test("a chip press draws the dialog's frame before the version's bytes land", async ({ page }) => {
  await installMockApi(page, {
    artifactContents: {
      "input-version-1": "样品,强度\nA,12.5\n",
      "version-1": REPORT_BODY,
    },
    artifactsBySession: { [SESSION]: [REPORT_OUTPUT, INPUT_OUTPUT] },
    memory: MEMORY,
    sessions: [makeSession()],
  });
  // Hold the version's bytes so the frame it is drawn before can be observed:
  // on a local API the gap is milliseconds and a test that only waits for the
  // table would pass with or without the placeholder.
  await page.route(/\/api\/sessions\/[^/]+\/artifact-versions\/[^/]+\/content$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fallback();
  });
  await page.goto("/");
  const panel = await openReport(page);

  await panel.locator(".graph-chip").nth(1).click();
  const dialog = page.locator(".artifact-dialog");
  await expect(dialog).toBeVisible();
  // The title is the reference's, so it is there before the answer is.
  await expect(dialog.locator(".artifact-dialog-head h2")).toHaveText("previous.csv");
  await expect(dialog.locator(".artifact-dialog-body")).toHaveAttribute("aria-busy", "true");
  await expect(dialog.locator(".artifact-dialog-body .doc-note")).toHaveText("正在打开产物…");
  // The document replaces the placeholder in the same dialog.
  await expect(dialog.locator(".data-table tbody tr")).toHaveCount(1);
  await expect(dialog.locator(".doc-note")).toHaveCount(0);
});

test("a provenance tab opens at its first line, not where the preview was left", async ({ page }) => {
  await installMockApi(page, {
    artifactContents: {
      "long-report-version-1": LONG_REPORT_BODY,
      "long-version-1": LONG_SECTIONS,
    },
    artifactProvenance: { "long-version-1": LONG_PROVENANCE },
    artifactsBySession: { [SESSION]: [LONG_REPORT, LONG_OUTPUT] },
    memory: MEMORY,
    sessions: [makeSession()],
  });
  await page.goto("/");
  await page.getByRole("button", { name: "工作区面板" }).click();
  const panel = page.locator(".workspace-panel");
  await panel.getByRole("tab", { name: "产物" }).click();
  await panel.getByRole("button", { name: "long-report.md" }).click();
  await expect(panel.locator(".doc-body")).toContainText("甲烷转化率提升");

  await panel.locator(".graph-chip").filter({ hasText: "artifact1" }).click();
  const dialog = page.locator(".artifact-dialog");
  await expect(dialog.locator(".artifact-dialog-head h2")).toHaveText("long.md");
  const body = dialog.locator(".artifact-dialog-body");

  // Read to the end of the preview, as a reader does before checking where a
  // figure came from.
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // 溯源 is its own page, so it opens at its own first line rather than
  // halfway down at the preview's offset.
  await dialog.getByRole("button", { name: "溯源" }).click();
  await expect(dialog.locator(".memory-artifact-provenance")).toBeVisible();
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(0);
});

test("a 派生自 link opens the dependency beside the dialog, not in place of it", async ({ page }) => {
  const mock = await installMockApi(page, {
    artifactContents: {
      "input-version-1": "样品,强度\nA,12.5\n",
      "trend-version-1": "月,值\n1,3\n",
      "version-1": REPORT_BODY,
    },
    artifactProvenance: { "input-version-1": INPUT_PROVENANCE },
    artifactsBySession: { [SESSION]: [REPORT_OUTPUT, INPUT_OUTPUT, TREND_OUTPUT] },
    artifactVersions: {
      [`${SESSION}|artifact-input`]: [INPUT_OUTPUT.version],
      [`${SESSION}|artifact-trend`]: [TREND_OUTPUT.version],
    },
    memory: MEMORY,
    sessions: [makeSession()],
  });
  await page.goto("/");
  const panel = await openReport(page);

  await panel.locator(".graph-chip").nth(1).click();
  const dialog = page.locator(".artifact-dialog");
  await expect(dialog.locator("h2")).toHaveText("previous.csv");
  await dialog.getByRole("button", { name: "溯源" }).click();
  const provenance = dialog.locator(".memory-artifact-provenance");

  // A dependency that is itself an artifact is a link: an uploaded file is
  // not, and stays plain text.
  await expect(provenance.locator(".memory-dependency.is-file")).toHaveText("raw.csv");
  await provenance.getByRole("button", { name: /trend\.csv/u }).click();

  // The dialog is still the document the link was pressed in: the question was
  // about previous.csv, and swapping it would take the context away.
  await expect(dialog.locator("h2")).toHaveText("previous.csv");
  await dialog.getByRole("button", { name: "预览" }).click();
  await expect(dialog.locator(".data-table tbody")).toContainText("A");
  // The dependency opened beside it, and the surfaces keep their own chrome:
  // no ring is drawn on either one.
  await expect(panel.locator(".doc-tab.is-active .doc-tab-name")).toHaveText("trend.csv");
  await expect(panel.locator(".data-table tbody")).toContainText("1");
  await expect(panel).not.toHaveClass(/is-linked/u);
  await expect(dialog).not.toHaveClass(/is-linked/u);
  // Nothing occludes anything: the dialog stops where the panel begins.
  const panelBox = (await panel.boundingBox())!;
  const dialogBox = (await dialog.boundingBox())!;
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(panelBox.x + 1);

  // The version the link named is the one that was read, not the newest.
  expect(lastCall(mock, `/api/sessions/${SESSION}/artifact-versions/trend-version-1/content`)).toBeDefined();

  // Closing the dialog ends the gesture; the panel keeps what it opened.
  await page.keyboard.press("Escape");
  await expect(page.locator(".artifact-dialog")).toHaveCount(0);
  await expect(panel.locator(".doc-tab.is-active .doc-tab-name")).toHaveText("trend.csv");
});

test("a disabled memory graph says so in the card instead of an empty story", async ({ page }) => {
  await installMockApi(page, {
    artifactContents: { "version-1": REPORT_BODY },
    artifactsBySession: { [SESSION]: [REPORT_OUTPUT] },
    memory: { reason: "memory_graph_disabled" },
    memorySettings: { enabled: false },
    sessions: [makeSession()],
  });
  await page.goto("/");
  const panel = await openReport(page);

  await panel.locator(".graph-chip").nth(0).click();
  const dialog = page.locator(".memory-dialog");
  await expect(dialog.getByText("科学记忆没有开启")).toBeVisible();
  await expect(dialog.locator(".evidence-source-papers")).toHaveCount(0);

  // The way out is the switch, and it is one press away.
  await dialog.getByRole("button", { name: "打开科学记忆设置" }).click();
  await expect(page.locator(".config-panel")).toBeVisible();
  await expect(page.locator(".settings-group-detail h3")).toHaveText("科学记忆");
});

test("a provenance hop that cannot reach the graph is an error, not an empty story", async ({ page }) => {
  await installMockApi(page, {
    artifactContents: { "version-1": REPORT_BODY },
    artifactsBySession: { [SESSION]: [REPORT_OUTPUT] },
    memory: {
      hits: [EVIDENCE],
      chains: {
        "evidence-1|viewSourcePaper": {
          edges: [],
          nodes: [],
          reason: "memory_graph_unreachable",
          total: 0,
          truncated: false,
        },
      },
    },
    sessions: [makeSession()],
  });
  await page.goto("/");
  const panel = await openReport(page);

  await panel.locator(".graph-chip").nth(0).click();
  const dialog = page.locator(".memory-dialog");
  await dialog.getByRole("button", { name: "溯源" }).click();

  await expect(dialog.getByText("记忆服务没有响应。稍后再试一次。")).toBeVisible();
  await expect(dialog.locator(".evidence-source-papers")).toHaveCount(0);
});

test("the memory state reads beside the switch, and only while the switch is on", async ({ page }) => {
  const mock = await installMockApi(page, {
    memorySettings: { enabled: false },
    sessions: [makeSession()],
  });
  await page.goto("/");

  // The task header says what the page is about; a question about storage is
  // answered where the reader can act on it.
  await expect(page.locator(".task-head .memory-status")).toHaveCount(0);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("button", { name: "科学记忆" }).click();
  await expect(dialog.locator(".settings-group-detail h3")).toHaveText("科学记忆");

  const enabled = dialog.getByRole("switch", { name: "启用科学记忆" });
  const status = dialog.locator(".memory-status");
  await expect(enabled).toHaveAttribute("aria-checked", "false");

  // Off is off: nothing to report, and nothing to ask. The page reads the
  // service only once the switch turns it on.
  await expect(status).toHaveCount(0);
  const probes = healthCalls(mock);
  await page.waitForTimeout(500);
  expect(healthCalls(mock)).toBe(probes);

  await enabled.click();
  await expect.poll(() => mock.state.memorySettings.enabled).toBe(true);
  await expect(status).toHaveClass(/is-healthy/u);
  await expect(status).toContainText("运行正常");
  expect(healthCalls(mock)).toBeGreaterThan(probes);

  // A second reading is the reader's press, not a timer.
  mock.state.memorySettings.memoryGraphStatus = "degraded";
  await status.getByRole("button", { name: "重新检查" }).click();
  await expect(status).toHaveClass(/is-degraded/u);
  await expect(status).toContainText("连接失败");

  // Turning it off takes the line, and the question, away again.
  await enabled.click();
  await expect.poll(() => mock.state.memorySettings.enabled).toBe(false);
  expect(JSON.parse(lastCall(mock, "/api/memory/settings")!.body!)).toEqual({ enabled: false });
  await expect(status).toHaveCount(0);

  // The switch is the page's whole surface: where the graph is stored is the
  // memory service's configuration, not something this window asks about.
  await expect(page.getByRole("button", { name: "存储后端" })).toHaveCount(0);
  await expect(page.getByLabel("密码")).toHaveCount(0);
});
