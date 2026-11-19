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

// #1251: the sidebar's search field, mounted with react-test-renderer so the
// debounce, the keyboard and the request/answer cycle run for real. The mocked
// Playwright journey in `e2e/sidebar-search.spec.ts` covers the same field in a
// browser; these cases pin the behaviour that would otherwise need a human.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";

import { ApiRequestError } from "../src/api/client.js";
import type { ApiClient } from "../src/api/client.js";
import type { Session, SessionArtifactOutput, WorkbenchSearchResponse, WorkbenchSearchResult } from "../src/api/types.js";
import { TEXT } from "../src/text.js";
import { searchFailureText, SidebarSearch } from "../src/views/SidebarSearch.js";
import { StubClient } from "./api-stub.js";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "./support/dom-renderer.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function session(id: string, title: string, over: Partial<Session> = {}): Session {
  return {
    createdAt: "2026-10-01T08:00:00.000Z",
    id,
    projectId: "inbox",
    title,
    updatedAt: "2026-10-01T09:00:00.000Z",
    ...over,
  } as Session;
}

function result(over: Partial<WorkbenchSearchResult> = {}): WorkbenchSearchResult {
  return { detail: "", id: "session:s1", kind: "session", label: "会话", projectId: "p1", ...over };
}

function response(results: WorkbenchSearchResult[], over: Partial<WorkbenchSearchResponse> = {}): WorkbenchSearchResponse {
  return { hasMore: false, limit: 250, offset: 0, results, total: results.length, ...over };
}

function artifactOutput(name: string, over: Record<string, unknown> = {}): SessionArtifactOutput {
  return {
    artifact: {
      createdAt: "2026-10-01T08:00:00.000Z",
      createdInSessionId: "inbox-1",
      createdInSessionTitle: "晶体结构分析",
      currentVersion: 1,
      id: "a1",
      kind: "report",
      logicalName: name,
      name,
      origin: "server_generated",
      projectId: "inbox",
      sessionId: "inbox-1",
      updatedAt: "2026-10-01T09:00:00.000Z",
      ...over,
    },
    version: { id: "v1" },
  } as unknown as SessionArtifactOutput;
}

function Harness({ client, inboxProjectId, opened, recent = [] }: {
  client: ApiClient;
  inboxProjectId?: string;
  opened: string[];
  recent?: Session[];
}) {
  const [query, setQuery] = React.useState("");
  return (
    <SidebarSearch
      client={client}
      inboxProjectId={inboxProjectId}
      onOpenArtifact={(artifactId, sessionId) => opened.push(`artifact:${artifactId}:${sessionId}`)}
      onOpenProject={(projectId) => opened.push(`project:${projectId}`)}
      onOpenSession={(sessionId, projectId) => opened.push(`session:${sessionId}:${projectId}`)}
      onQueryChange={setQuery}
      query={query}
      recent={recent}
    />
  );
}

interface Mounted {
  opened: string[];
  view: ReactTestRenderer;
}

async function mount(
  client: ApiClient,
  options: { createNodeMock?: (element: { props: Record<string, unknown> }) => unknown; inboxProjectId?: string; recent?: Session[] } = {},
): Promise<Mounted> {
  const opened: string[] = [];
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      <Harness client={client} inboxProjectId={options.inboxProjectId} opened={opened} recent={options.recent} />,
      options.createNodeMock === undefined ? undefined : { createNodeMock: options.createNodeMock },
    );
  });
  return { opened, view };
}

async function type(view: ReactTestRenderer, value: string) {
  await act(async () => {
    view.root.findByType("input").props.onChange({ target: { value } });
  });
}

interface KeyOptions {
  isComposing?: boolean;
  keyCode?: number;
}

async function press(view: ReactTestRenderer, key: string, options: KeyOptions = {}): Promise<boolean> {
  let prevented = false;
  await act(async () => {
    view.root.findByType("input").props.onKeyDown({
      isComposing: options.isComposing,
      key,
      keyCode: options.keyCode,
      nativeEvent: { isComposing: options.isComposing === true },
      preventDefault: () => { prevented = true; },
    });
  });
  return prevented;
}

/** Longer than `SEARCH_DEBOUNCE_MS`, so the timer has fired and the answer has
 *  been committed. */
async function settle(ms = 340) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function textOf(view: ReactTestRenderer): string {
  return JSON.stringify(view.toJSON());
}

function inputValue(view: ReactTestRenderer): string {
  return view.root.findByType("input").props.value;
}

function options(view: ReactTestRenderer): ReactTestInstance[] {
  return view.root.findAll((node) => node.props.role === "option");
}

function selectedOption(view: ReactTestRenderer): ReactTestInstance | undefined {
  return options(view).find((node) => node.props["aria-selected"] === true);
}

/** A client whose answer a test can resolve after another request landed. */
class DeferredClient {
  readonly calls: Array<{ init: RequestInit; path: string }> = [];
  private readonly pending: Array<{ resolve: (value: WorkbenchSearchResponse) => void; signal?: AbortSignal }> = [];

  readonly request = <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    this.calls.push({ init, path });
    return new Promise<T>((resolve) => {
      this.pending.push({ resolve: resolve as (value: WorkbenchSearchResponse) => void, signal: init.signal ?? undefined });
    });
  };

  asClient(): ApiClient {
    return this as unknown as ApiClient;
  }

  resolve(index: number, value: WorkbenchSearchResponse): void {
    this.pending[index]!.resolve(value);
  }

  signal(index: number): AbortSignal | undefined {
    return this.pending[index]!.signal;
  }
}

/** The search endpoint plus the inbox reads the panel makes on demand. */
class RoutedClient {
  readonly calls: Array<{ init: RequestInit; path: string }> = [];

  constructor(private readonly spec: {
    failOutputs?: boolean;
    outputs?: Record<string, SessionArtifactOutput[]>;
    search: WorkbenchSearchResponse;
    sessions?: Session[];
  }) {}

  readonly request = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    this.calls.push({ init, path });
    if (path.startsWith("/api/search")) return this.spec.search as T;
    if (path.includes("/sessions?state=all")) return (this.spec.sessions ?? []) as T;
    const outputs = /\/api\/sessions\/([^/]+)\/artifact-outputs/.exec(path);
    if (outputs !== null) {
      if (this.spec.failOutputs === true) throw new Error("artifact-outputs failed");
      return (this.spec.outputs?.[decodeURIComponent(outputs[1]!)] ?? []) as T;
    }
    throw new Error(`unexpected request: ${path}`);
  };

  asClient(): ApiClient {
    return this as unknown as ApiClient;
  }
}

test("a settled query costs one request, and the next settled query one more", async () => {
  const client = new StubClient().reply(response([])).reply(response([]));
  const { view } = await mount(client.asClient());

  await type(view, "c");
  await type(view, "cr");
  await type(view, "cry");
  await settle();

  assert.equal(client.calls.length, 1, "each keystroke must not spend a request");
  const call = new URL(client.calls[0]!.path, "http://test.invalid");
  assert.equal(call.pathname, "/api/search");
  assert.equal(call.searchParams.get("q"), "cry");
  assert.equal(call.searchParams.get("limit"), "250");

  // A render that leaves the query alone does not repeat the request.
  await settle(300);
  assert.equal(client.calls.length, 1);

  await type(view, "cryst");
  await settle();
  assert.equal(client.calls.length, 2);
  assert.equal(new URL(client.calls[1]!.path, "http://test.invalid").searchParams.get("q"), "cryst");
});

test("a superseded request is aborted and its late answer cannot replace the newer one", async () => {
  const client = new DeferredClient();
  const { view } = await mount(client.asClient());

  await type(view, "a");
  await settle();
  assert.equal(client.calls.length, 1);

  await type(view, "ab");
  await settle();
  assert.equal(client.calls.length, 2);
  assert.equal(client.signal(0)?.aborted, true, "the first request must be aborted");

  await act(async () => {
    client.resolve(1, response([result({ id: "session:new", label: "新结果", sessionId: "new" })]));
  });
  await settle(0);
  assert.ok(textOf(view).includes("新结果"));

  // The abandoned answer must not overwrite the newer one.
  await act(async () => {
    client.resolve(0, response([result({ id: "session:old", label: "旧结果", sessionId: "old" })]));
  });
  await settle(0);
  assert.ok(textOf(view).includes("新结果"));
  assert.ok(!textOf(view).includes("旧结果"));
});

test("results are grouped 项目 / 会话 / 产物 and an archived Session carries the marker", async () => {
  const client = new StubClient().reply(response([
    result({ id: "project:p1", kind: "project", label: "脓毒症研究", projectName: "脓毒症研究" }),
    result({ archived: true, id: "session:s1", kind: "session", label: "归档会话", projectName: "脓毒症研究", sessionId: "s1" }),
    result({ id: "artifact:a1", kind: "artifact", label: "report.pdf", path: "report.pdf", projectName: "脓毒症研究", sessionId: "s1", sessionTitle: "归档会话" }),
  ]));
  const { view } = await mount(client.asClient());

  await type(view, "研究");
  await settle();
  const text = textOf(view);
  assert.ok(text.includes("脓毒症研究"), "the project context is missing");
  assert.ok(text.includes(TEXT.sidebar.archived), "the archived marker is missing");
  assert.equal(options(view).length, 3);
  // The labels are read from the group headings, not from the whole string:
  // the field's own hint names the three kinds too.
  const headings = view.root
    .findAll((node) => node.props.className === "side-search-group-label")
    .map((node) => node.findAllByType("span").map((span) => span.children.join("")).join(" "));
  assert.equal(headings.length, 3);
  assert.ok(headings[0]!.includes(TEXT.search.groups.project), "项目 must lead");
  assert.ok(headings[1]!.includes(TEXT.search.groups.session), "会话 must follow 项目");
  assert.ok(headings[2]!.includes(TEXT.search.groups.artifact), "产物 must follow 会话");
});

test("Enter opens the selected result: a Project by default, a Session after Down", async () => {
  const projectClient = new StubClient().reply(response([
    result({ id: "project:p1", kind: "project", label: "脓毒症研究", projectId: "p1", projectName: "脓毒症研究" }),
    result({ id: "session:s1", kind: "session", label: "结构比对", sessionId: "s1" }),
  ]));
  const first = await mount(projectClient.asClient());
  await type(first.view, "研究");
  await settle();
  await press(first.view, "Enter");
  assert.deepEqual(first.opened, ["project:p1"]);
  assert.equal(inputValue(first.view), "", "opening a result closes the search");

  const sessionClient = new StubClient().reply(response([
    result({ id: "project:p1", kind: "project", label: "脓毒症研究", projectId: "p1", projectName: "脓毒症研究" }),
    result({ id: "session:s1", kind: "session", label: "结构比对", sessionId: "s1" }),
  ]));
  const second = await mount(sessionClient.asClient());
  await type(second.view, "研究");
  await settle();
  await press(second.view, "ArrowDown");
  await press(second.view, "Enter");
  assert.deepEqual(second.opened, ["session:s1:p1"]);
});

test("an artifact result maps artifact:<id> and its Session onto the artifact opener", async () => {
  const client = new StubClient().reply(response([
    result({
      id: "artifact:a1",
      kind: "artifact",
      label: "report.pdf",
      path: "report.pdf",
      projectName: "脓毒症研究",
      sessionId: "s1",
      sessionTitle: "结构比对",
    }),
  ]));
  const { opened, view } = await mount(client.asClient());
  await type(view, "report");
  await settle();
  await press(view, "ArrowDown");
  await press(view, "Enter");
  assert.deepEqual(opened, ["artifact:a1:s1"]);
});

test("an artifact whose Session is gone is shown with aria-disabled and is not opened", async () => {
  const client = new StubClient().reply(response([
    result({ id: "artifact:a1", kind: "artifact", label: "report.pdf", path: "report.pdf" }),
  ]));
  const { opened, view } = await mount(client.asClient());
  await type(view, "report");
  await settle();

  assert.ok(textOf(view).includes(TEXT.search.artifactUnavailable));
  const row = options(view)[0]!;
  assert.equal(row.props["aria-disabled"], true);
  assert.equal(row.props.disabled, undefined, "only aria-disabled is used");
  await press(view, "ArrowDown");
  await press(view, "Enter");
  assert.deepEqual(opened, [], "an unavailable result is not opened silently");
});

test("Escape clears the query, restores the list and leaves focus in the field", async () => {
  const client = new StubClient().reply(response([result({ label: "结构比对", sessionId: "s1" })]));
  const { view } = await mount(client.asClient());
  await type(view, "结构");
  await settle();
  assert.ok(textOf(view).includes("结构比对"));

  await press(view, "Escape");
  assert.equal(inputValue(view), "");
  assert.ok(!textOf(view).includes("结构比对"), "the results must be gone");
});

test("Arrow keys and Escape do nothing while an IME composition is open", async () => {
  const client = new StubClient().reply(response([
    result({ id: "session:s1", kind: "session", label: "第一个", sessionId: "s1" }),
    result({ id: "session:s2", kind: "session", label: "第二个", sessionId: "s2" }),
  ]));
  const { view } = await mount(client.asClient());
  await type(view, "第一");
  await settle();
  assert.equal(selectedOption(view)?.props.id?.toString().endsWith("-result-0"), true);

  const prevented = await press(view, "ArrowDown", { isComposing: true });
  assert.equal(prevented, false, "the IME owns the arrow");
  assert.equal(selectedOption(view)?.props.id?.toString().endsWith("-result-0"), true);

  await press(view, "Escape", { isComposing: true });
  assert.equal(inputValue(view), "第一", "Escape during composition must not clear the query");

  // The same keys act once the composition ends.
  await press(view, "ArrowDown");
  assert.equal(selectedOption(view)?.props.id?.toString().endsWith("-result-1"), true);
});

test("the selected result is scrolled into view as the arrow keys move", async () => {
  const rows = Array.from({ length: 20 }, (_, index) =>
    result({ id: `session:s${index}`, kind: "session", label: `会话 ${index}`, sessionId: `s${index}` }));
  const client = new StubClient().reply(response(rows));
  const scrolled: string[] = [];
  const { view } = await mount(client.asClient(), {
    createNodeMock: () => ({ scrollIntoView: (options?: ScrollIntoViewOptions) => scrolled.push(options?.block ?? "") }),
  });
  await type(view, "会话");
  await settle();
  assert.ok(scrolled.length > 0, "the first selected row must be brought into view");

  await press(view, "ArrowDown");
  await press(view, "ArrowDown");
  assert.ok(scrolled.length >= 3, "each move must keep the selected row visible");
  assert.deepEqual(scrolled.at(-1), "nearest");
});

test("an empty answer says so and names the scope, unlike a failure", async () => {
  const client = new StubClient().reply(response([]));
  const { view } = await mount(client.asClient());
  await type(view, "没有任何东西");
  await settle();
  const text = textOf(view);
  assert.ok(text.includes(TEXT.search.noResults), "the live status announces the empty state");
  assert.equal(
    text.split(TEXT.search.emptyTitle).length - 1,
    1,
    "the status and the empty block must not print the same title twice",
  );
  assert.equal(
    view.root.findAll((node) => node.props.className === "side-search-empty-title").length,
    1,
    "the full sentence is the block's title, not 11px status text",
  );
  assert.ok(text.includes(TEXT.search.emptyBody), "the empty state must not promise message search");
  assert.ok(!text.includes(TEXT.search.failed("")));
});

test("a failed request shows a localized reason and a retry that asks again", async () => {
  const client = new StubClient()
    .fail(new ApiRequestError("Request failed (500)", 500))
    .reply(response([result({ id: "session:s1", kind: "session", label: "结构比对", sessionId: "s1" })]));
  const { view } = await mount(client.asClient());
  await type(view, "结构");
  await settle();
  assert.ok(textOf(view).includes(TEXT.search.failed(TEXT.search.fallbackReason)));
  assert.ok(!textOf(view).includes("Request failed (500)"), "the raw transport line is not shown");
  const listbox = view.root.findAll((node) => node.props.role === "listbox");
  assert.equal(listbox.length, 0, "the error and retry live outside the listbox");

  const retry = view.root.findAllByType("button").find((button) => button.props.className === "side-search-retry");
  assert.ok(retry !== undefined, "the failure must offer the next step");
  await act(async () => {
    retry!.props.onClick();
  });
  await settle();
  assert.equal(client.calls.length, 2);
  assert.ok(textOf(view).includes("结构比对"));
});

test("a truncated page keeps hasMore/total in the always-visible status line", async () => {
  const only = result({ id: "session:s1", kind: "session", label: "结构比对", sessionId: "s1" });
  const client = new StubClient().reply(response([only], { hasMore: true, total: 300 }));
  const { view } = await mount(client.asClient());
  await type(view, "结构");
  await settle();
  // The notice lives outside the scrolling listbox, so it cannot be pushed
  // below a long answer.
  const notice = view.root.findAll((node) => node.props.className === "side-search-more");
  assert.equal(notice.length, 1);
  assert.ok(textOf(view).includes(TEXT.search.more(1, 300)));
  const listbox = view.root.findAll((node) => node.props.role === "listbox")[0];
  assert.ok(listbox !== undefined);
  assert.equal(
    listbox.findAll((node) => node.props.className === "side-search-more").length,
    0,
    "the notice must be outside the listbox",
  );
});

test("hasMore counts the locally merged inbox rows as shown rows", async () => {
  const client = new RoutedClient({
    search: response([result({ id: "session:server", kind: "session", label: "晶体服务端", sessionId: "server" })], { hasMore: true, total: 2 }),
    sessions: [session("inbox-1", "晶体结构分析"), session("inbox-2", "晶体数据")],
  });
  const { view } = await mount(client.asClient(), { inboxProjectId: "inbox" });
  await type(view, "晶体");
  await settle();
  const merged = 3;
  const total = 4;
  assert.ok(textOf(view).includes(TEXT.search.more(merged, total)), textOf(view));
});

test("the inbox snapshot merges an archived Session, because the server skips it", async () => {
  const client = new RoutedClient({
    search: response([]),
    sessions: [
      session("inbox-1", "晶体结构分析"),
      session("inbox-2", "归档晶体会话", { archivedAt: "2026-10-02T09:00:00.000Z" }),
    ],
  });
  const { opened, view } = await mount(client.asClient(), { inboxProjectId: "inbox" });
  await type(view, "归档晶体");
  await settle();

  const text = textOf(view);
  assert.ok(text.includes("归档晶体会话"), "an archived inbox conversation must be searchable");
  assert.ok(text.includes(TEXT.sidebar.archived));
  await press(view, "Enter");
  assert.deepEqual(opened, ["session:inbox-2:inbox"]);
});

test("the inbox snapshot merges an artifact the server's search never returns", async () => {
  const client = new RoutedClient({
    outputs: { "inbox-1": [artifactOutput("晶体报告.pdf", { id: "artifact-9" })] },
    search: response([]),
    sessions: [session("inbox-1", "晶体结构分析")],
  });
  const { opened, view } = await mount(client.asClient(), { inboxProjectId: "inbox" });
  await type(view, "晶体报告");
  await settle();

  assert.ok(textOf(view).includes("晶体报告.pdf"));
  const row = options(view).find((option) =>
    option.findAll((node) => node.props.className === "side-search-result-label")
      .some((label) => label.children.join("").includes("晶体报告.pdf")));
  assert.ok(row !== undefined);
  await act(async () => {
    row!.props.onClick();
  });
  assert.deepEqual(opened, ["artifact:artifact-9:inbox-1"]);
});

test("an inbox read failure keeps the loaded Sessions and says the answer may be incomplete", async () => {
  const client = new RoutedClient({ search: response([]), sessions: [] });
  // Make only the inbox Session list fail; the search still answers.
  const failing = {
    request: (path: string, init: RequestInit = {}) => {
      if (path.includes("/sessions?state=all")) return Promise.reject(new Error("inbox down"));
      return client.request(path, init);
    },
  } as unknown as ApiClient;
  const { view } = await mount(failing, { inboxProjectId: "inbox", recent: [session("inbox-1", "晶体结构分析")] });
  await type(view, "晶体");
  await settle();
  assert.ok(textOf(view).includes("晶体结构分析"), "the loaded 会话 rows must still be searched");
  assert.ok(textOf(view).includes(TEXT.search.inboxIncomplete));
});

test("an artifact-outputs failure in the inbox marks the answer incomplete", async () => {
  const client = new RoutedClient({
    failOutputs: true,
    search: response([]),
    sessions: [session("inbox-1", "晶体结构分析")],
  });
  const { view } = await mount(client.asClient(), { inboxProjectId: "inbox" });
  await type(view, "晶体");
  await settle();
  assert.ok(textOf(view).includes("晶体结构分析"));
  assert.ok(textOf(view).includes(TEXT.search.inboxIncomplete));
});

test("searchFailureText keeps a server reason and localizes transport failures", () => {
  assert.equal(searchFailureText(new ApiRequestError("backend down", 500)), "backend down");
  assert.equal(searchFailureText(new ApiRequestError("Request failed (500)", 500)), TEXT.search.fallbackReason);
  assert.equal(searchFailureText(new TypeError("Failed to fetch")), TEXT.search.fallbackReason);
  assert.equal(searchFailureText(new Error("boom")), "boom");
  assert.equal(searchFailureText(undefined), TEXT.errors.generic);
});
