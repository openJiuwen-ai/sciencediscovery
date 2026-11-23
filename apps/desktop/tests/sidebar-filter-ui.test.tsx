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

// #1251: the filter row narrows the real sidebar rows. The facts it needs are
// mocked at the ApiClient seam, so the test also pins *when* the per-Session
// reads happen: only while their filter is on.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";

import type { ApiClient } from "../src/api/client.js";
import type { Session } from "../src/api/types.js";
import type { WorkspaceActions } from "../src/app/use-workspace.js";
import { SIDEBAR_FILTERS_STORAGE_KEY, type ReadableStorage } from "../src/state/storage.js";
import { TEXT } from "../src/text.js";
import { Sidebar } from "../src/views/Sidebar.js";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "./support/dom-renderer.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actions = {
  createProject: async () => {},
  newSession: () => {},
  openArtifactResult: async () => {},
  openSession: async () => {},
  selectProject: () => {},
} as unknown as WorkspaceActions;

function memoryStorage(): ReadableStorage & { values: Record<string, string> } {
  const values: Record<string, string> = {};
  return {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => { values[key] = value; },
    values,
  };
}

let storage = memoryStorage();

function installStorage(): void {
  storage = memoryStorage();
  // `Sidebar` also mounts the GitHub star counter, which reads the public API
  // when its day-long cache is empty. These cases are about rows and filters,
  // so seed the cache rather than making a network call from a unit test.
  storage.values["sciencediscovery-desktop:github-stars"] = JSON.stringify({ at: Date.now(), count: 12 });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}

function session(id: string, title: string, over: Partial<Session> = {}): Session {
  return {
    createdAt: "2026-10-01T08:00:00.000Z",
    id,
    projectId: "inbox",
    title,
    updatedAt: new Date().toISOString(),
    ...over,
  } as Session;
}

function project(id: string, name: string) {
  return { createdAt: "2026-10-01T08:00:00.000Z", id, name } as never;
}

interface FactsState {
  failArtifacts: boolean;
  failRuns: boolean;
  /** A gate the runs reads wait on, for the mid-read pending state. */
  gate?: Promise<void>;
  running: Set<string>;
  withArtifacts: Set<string>;
}

interface FactsClient extends ApiClient {
  calls: string[];
  state: FactsState;
}

/** The two per-Session reads, answered by id. Any other path fails loudly. */
function factsClient(over: Partial<FactsState> = {}): FactsClient {
  const calls: string[] = [];
  const state: FactsState = {
    failArtifacts: false,
    failRuns: false,
    running: new Set(),
    withArtifacts: new Set(),
    ...over,
  };
  const idOf = (path: string) => decodeURIComponent(path.split("/api/sessions/")[1]?.split("/")[0] ?? "");
  const request = async <T,>(path: string): Promise<T> => {
    calls.push(path);
    if (path.endsWith("/runs")) {
      if (state.gate !== undefined) await state.gate;
      if (state.failRuns) throw new Error("runs failed");
      return (state.running.has(idOf(path)) ? [{ status: "running" }] : [{ status: "completed" }]) as T;
    }
    if (path.endsWith("/artifact-outputs")) {
      if (state.failArtifacts) throw new Error("outputs failed");
      return (state.withArtifacts.has(idOf(path)) ? [{ artifact: { id: "a1" } }] : []) as T;
    }
    throw new Error(`unexpected request: ${path}`);
  };
  return { calls, request, state } as unknown as FactsClient;
}

function sidebarElement(client: ApiClient, over: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return (
    <Sidebar
      actions={actions}
      client={client}
      projects={[]}
      recent={[]}
      sessionsByProject={{}}
      {...over}
    />
  );
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountSidebar(client: ApiClient, over: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(sidebarElement(client, over));
  });
  await flush();
  return view;
}

function button(view: ReactTestRenderer, label: string): ReactTestInstance {
  const found = view.root.findAllByType("button").find((candidate) => candidate.props.children === label);
  assert.ok(found !== undefined, `no button labelled ${label}`);
  return found!;
}

async function click(view: ReactTestRenderer, label: string) {
  await act(async () => {
    button(view, label).props.onClick();
  });
  await flush();
}

function textOf(view: ReactTestRenderer): string {
  return JSON.stringify(view.toJSON());
}

function storedFilters(): Record<string, unknown> {
  return JSON.parse(storage.values[SIDEBAR_FILTERS_STORAGE_KEY] ?? "{}") as Record<string, unknown>;
}

test("仅运行中 reads each listed Session's runs and keeps the unfinished one", async () => {
  installStorage();
  const client = factsClient({ running: new Set(["s1"]) });
  const view = await mountSidebar(client, {
    recent: [session("s1", "运行中的会话"), session("s2", "已完成的会话")],
  });
  assert.ok(textOf(view).includes("运行中的会话") && textOf(view).includes("已完成的会话"));
  assert.equal(client.calls.length, 0, "the normal list must not spend the per-Session reads");

  await click(view, TEXT.search.filters.onlyRunning);

  assert.ok(textOf(view).includes("运行中的会话"));
  assert.ok(!textOf(view).includes("已完成的会话"));
  assert.ok(client.calls.some((path) => path.endsWith("/api/sessions/s1/runs")));
  assert.ok(client.calls.some((path) => path.endsWith("/api/sessions/s2/runs")));
  assert.equal(storedFilters().onlyRunning, true);
});

test("有产物 reads artifact outputs and keeps the Session that wrote one", async () => {
  installStorage();
  const client = factsClient({ withArtifacts: new Set(["s1"]) });
  const view = await mountSidebar(client, {
    recent: [session("s1", "有产物的会话"), session("s2", "空会话")],
  });

  await click(view, TEXT.search.filters.hasArtifacts);

  assert.ok(textOf(view).includes("有产物的会话"));
  assert.ok(!textOf(view).includes("空会话"));
  assert.ok(client.calls.some((path) => path.endsWith("/api/sessions/s1/artifact-outputs")));
  assert.equal(storedFilters().hasArtifacts, true);
});

test("仅当前项目 scopes the rows but keeps every Project fold reachable", async () => {
  installStorage();
  const client = factsClient();
  const view = await mountSidebar(client, {
    activeProjectId: "p1",
    projects: [project("p1", "项目一"), project("p2", "项目二")],
    sessionsByProject: {
      p1: [session("s1", "本项目的会话", { projectId: "p1" })],
      p2: [session("s2", "别的项目的会话", { projectId: "p2" })],
    },
  });

  await click(view, TEXT.search.filters.onlyCurrentProject);

  const text = textOf(view);
  assert.ok(text.includes("本项目的会话"));
  assert.ok(!text.includes("别的项目的会话"));
  assert.ok(text.includes("项目二"), "the other fold must stay, only its rows are scoped");
  assert.ok(text.includes(TEXT.search.filters.empty));
});

test("the time window hides rows older than the chosen range", async () => {
  installStorage();
  const client = factsClient();
  const older = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const view = await mountSidebar(client, {
    recent: [session("s1", "今天的会话"), session("s2", "十天前的会话", { updatedAt: older })],
  });

  const select = view.root.findByType("select");
  await act(async () => {
    select.props.onChange({ target: { value: "today" } });
  });
  await flush();

  assert.ok(textOf(view).includes("今天的会话"));
  assert.ok(!textOf(view).includes("十天前的会话"));
  assert.equal(storedFilters().window, "today");
});

test("the filter choice survives a remount, and 清除筛选 resets it", async () => {
  installStorage();
  const client = factsClient({ running: new Set(["s1"]) });
  const props = { recent: [session("s1", "运行中的会话"), session("s2", "已完成的会话")] } as const;
  const view = await mountSidebar(client, { recent: [...props.recent] });
  await click(view, TEXT.search.filters.onlyRunning);
  assert.equal(button(view, TEXT.search.filters.onlyRunning).props["aria-pressed"], true);

  // A restart reads the stored choice back: the same filter is on and the
  // rows are narrowed without clicking anything.
  const remounted = await mountSidebar(factsClient({ running: new Set(["s1"]) }), { recent: [...props.recent] });
  assert.equal(button(remounted, TEXT.search.filters.onlyRunning).props["aria-pressed"], true);
  assert.ok(textOf(remounted).includes("运行中的会话"));
  assert.ok(!textOf(remounted).includes("已完成的会话"));

  await click(remounted, TEXT.search.filters.reset);
  assert.ok(textOf(remounted).includes("已完成的会话"));
  assert.deepEqual(storedFilters(), {
    hasArtifacts: false,
    onlyCurrentProject: false,
    onlyRunning: false,
    window: "all",
  });
});

test("while the facts are loading the rows say so instead of claiming an empty filter", async () => {
  installStorage();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const client = factsClient({ gate, running: new Set(["s1"]) });
  const view = await mountSidebar(client, {
    recent: [session("s1", "运行中的会话"), session("s2", "已完成的会话")],
  });

  await click(view, TEXT.search.filters.onlyRunning);
  const pendingText = textOf(view);
  assert.ok(pendingText.includes(TEXT.search.filters.pendingRows));
  assert.ok(!pendingText.includes(TEXT.search.filters.empty), "loading is not an empty result");

  release();
  await flush();
  assert.ok(textOf(view).includes("运行中的会话"));
  assert.ok(!textOf(view).includes("已完成的会话"));
  assert.ok(!textOf(view).includes(TEXT.search.filters.pendingRows));
});

test("a failed fact read is reported and can be retried", async () => {
  installStorage();
  const client = factsClient({ failRuns: true, running: new Set(["s1"]) });
  const view = await mountSidebar(client, {
    recent: [session("s1", "运行中的会话"), session("s2", "已完成的会话")],
  });

  await click(view, TEXT.search.filters.onlyRunning);
  const failedText = textOf(view);
  assert.ok(failedText.includes(TEXT.search.filters.failed));
  assert.ok(failedText.includes(TEXT.search.filters.unavailable), "unknown is not an empty filter");
  assert.ok(!failedText.includes(TEXT.search.filters.empty), "a failed read must not claim an empty result");

  client.state.failRuns = false;
  const retry = view.root.findAllByType("button").find((candidate) => candidate.props.className === "side-filter-retry");
  assert.ok(retry !== undefined, "a failed read must offer a retry");
  await act(async () => {
    retry!.props.onClick();
  });
  await flush();
  assert.ok(textOf(view).includes("运行中的会话"));
  assert.ok(!textOf(view).includes("已完成的会话"));
  assert.ok(!textOf(view).includes(TEXT.search.filters.failed));
});

test("a changed updatedAt re-reads the facts, so a finished run leaves 仅运行中", async () => {
  installStorage();
  const client = factsClient({ running: new Set(["s1"]) });
  const first = session("s1", "运行中的会话", { updatedAt: "2026-10-01T09:00:00.000Z" });
  const view = await mountSidebar(client, { recent: [first] });
  await click(view, TEXT.search.filters.onlyRunning);
  assert.ok(textOf(view).includes("运行中的会话"));

  client.state.running.clear();
  const finished = session("s1", "运行中的会话", { updatedAt: "2026-10-02T09:00:00.000Z" });
  await act(async () => {
    view.update(sidebarElement(client, { recent: [finished] }));
  });
  await flush();
  assert.ok(!textOf(view).includes("运行中的会话"));
  assert.ok(textOf(view).includes(TEXT.search.filters.empty));
});

test("a rejected artifact read is reported and does not claim an empty filter", async () => {
  installStorage();
  const client = factsClient({ failArtifacts: true, withArtifacts: new Set(["s1"]) });
  const view = await mountSidebar(client, {
    recent: [session("s1", "有产物的会话"), session("s2", "空会话")],
  });

  await click(view, TEXT.search.filters.hasArtifacts);
  const text = textOf(view);
  assert.ok(text.includes(TEXT.search.filters.failed));
  assert.ok(text.includes(TEXT.search.filters.unavailable));
  assert.ok(!text.includes(TEXT.search.filters.empty));
});
