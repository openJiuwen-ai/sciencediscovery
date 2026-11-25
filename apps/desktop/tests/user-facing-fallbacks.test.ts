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
 * The three fallbacks that used to bypass the text tables (#1398): the "save as"
 * name of an untitled export (blank title and the service's "Untitled session"
 * sentinel), the sentence a failed package save shows the user, and the display
 * name of an account HUAWEI did not name. Each is a literal in the old code, so
 * an English UI showed Chinese. They must now come from the dictionary of the
 * language that is active when the value is produced — not from one captured
 * when the module loaded.
 */

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { afterEach, test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { UNTITLED_SESSION_TITLE } from "@sciencediscovery/schema";

import { ApiRequestError, type ApiClient } from "../src/api/client.js";
import type { ExportOperation } from "../src/api/research-package.js";
import type { SessionDetail } from "../src/api/types.js";
import {
  accountSessionToUserSession,
  defaultAccountName,
  type AccountSession,
} from "../src/auth/account.js";
import { getLanguage, setLanguage, TEXT } from "../src/text.js";
import {
  openExportStreamWithRetry,
  ResearchPackage,
  saveFailureDetail,
  suggestedExportName,
} from "../src/views/ResearchPackage.js";
import { act, create } from "./support/dom-renderer.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every CJK ideograph the old literals were written in. */
const CJK = /[\u3400-\u9fff]/u;

// The language store is module state: leave it in the default for the next test
// and for the other files the runner may load after this one.
afterEach(() => setLanguage("zh-CN"));

function detail(title: string): SessionDetail {
  return { title } as unknown as SessionDetail;
}

function exportTask(): ExportOperation {
  return { id: "export-1", status: "completed", filename: "pkg.sdresearch" } as ExportOperation;
}

/** A signed-in account whose profile HUAWEI did not name. */
function unnamedAccount(): AccountSession {
  return {
    accessToken: "access",
    accessExpiresIn: 3600,
    refreshToken: "refresh",
    refreshExpiresAt: "2026-12-25T00:00:00Z",
    isNewUser: true,
    user: {
      id: 7,
      openid: "openid",
      openidTail: "tail",
      displayName: null,
      avatarUrl: null,
      email: null,
      status: 0,
      createdAt: "2026-11-25T00:00:00Z",
      lastLoginAt: null,
    },
    credit: {
      balance: 0,
      balanceCredits: 100,
      frozen: 0,
      frozenCredits: 0,
      totalEarned: 0,
      totalEarnedCredits: 100,
      totalSpent: 0,
      totalSpentCredits: 0,
      updatedAt: null,
    },
  };
}

test("an untitled export proposes the dictionary name in the active language", () => {
  setLanguage("zh-CN");
  assert.match(suggestedExportName(detail("")), /^科研会话_\d{8}_\d{4}\.sdresearch$/u);
  // A title the server left as whitespace is untitled too.
  assert.match(suggestedExportName(detail("   ")), /^科研会话_/u);
  // The reachable case: a fresh session carries the service's sentinel.
  assert.match(suggestedExportName(detail(UNTITLED_SESSION_TITLE)), /^科研会话_\d{8}_\d{4}\.sdresearch$/u, "the 'Untitled session' sentinel is an untitled session too");

  setLanguage("en");
  for (const title of ["", "   ", UNTITLED_SESSION_TITLE]) {
    const name = suggestedExportName(detail(title));
    assert.match(name, /^Research session_\d{8}_\d{4}\.sdresearch$/u, `title ${JSON.stringify(title)} takes the English label`);
    assert.ok(name.startsWith(`${TEXT.researchPackage.untitledSession}_`));
    assert.doesNotMatch(name, CJK, "an English UI must not save a Chinese filename");
  }
  // A real title is still the title, not the fallback.
  assert.match(suggestedExportName(detail("Quantum dots")), /^Quantum dots_\d{8}_\d{4}\.sdresearch$/u);
});

test("a titled export keeps the illegal-character scrub, the whitespace collapse and the 120-character cap", () => {
  setLanguage("en");
  assert.match(
    suggestedExportName(detail('a/b:c*d?e"f<g>h|i  j')),
    /^a_b_c_d_e_f_g_h_i j_\d{8}_\d{4}\.sdresearch$/u,
  );
  const long = suggestedExportName(detail("x".repeat(400)));
  assert.ok(long.startsWith(`${"x".repeat(120)}_`), "a long title is still capped at 120 characters");
  assert.doesNotMatch(long, /[\\/:*?"<>|]/u, "the filename carries no character Windows rejects");
});

test("a failed save shows the dictionary sentence and keeps the transport wording in the details", () => {
  setLanguage("en");
  const transport = new TypeError("Failed to fetch");
  const english = saveFailureDetail(transport);
  assert.equal(english.error, TEXT.researchPackage.downloadFailed);
  assert.equal(english.error, "The evidence package could not be downloaded. Try again.");
  assert.doesNotMatch(english.error, CJK, "an English UI must not show a Chinese sentence");
  assert.doesNotMatch(english.error, /Failed to fetch/u, "the visible sentence is not the transport message");
  assert.equal(english.rawError, "Failed to fetch", "the transport wording survives for the details block");

  // A plain non-Error rejection cannot be rendered as-is either.
  assert.deepEqual(saveFailureDetail("connection reset"), {
    error: TEXT.researchPackage.downloadFailed,
    rawError: "connection reset",
  });
  // A rejection with no readable text contributes no raw wording at all: the row
  // must not print "undefined" or "[object Object]" (#1398 review F5).
  assert.deepEqual(saveFailureDetail(undefined), { error: TEXT.researchPackage.downloadFailed, rawError: undefined });
  assert.deepEqual(saveFailureDetail({ code: "EIO" }), { error: TEXT.researchPackage.downloadFailed, rawError: undefined });
  assert.deepEqual(saveFailureDetail(new Error("")), { error: TEXT.researchPackage.downloadFailed, rawError: undefined });
  // A paragraph the client already phrased wins over the generic sentence.
  assert.deepEqual(saveFailureDetail(transport, "The download stalled."), { error: "The download stalled.", rawError: "Failed to fetch" });
  assert.deepEqual(saveFailureDetail(new Error("Export task not found")), {
    error: TEXT.researchPackage.taskMissing,
    rawError: "Export task not found",
  });
  // The stream's own status names the advice a generic sentence would bury:
  // the export task is gone (404) or the archive expired (410).
  assert.deepEqual(saveFailureDetail(new ApiRequestError("Not Found", 404)), {
    error: TEXT.researchPackage.taskMissing,
    rawError: "Not Found",
  });
  assert.deepEqual(saveFailureDetail(new ApiRequestError("Gone", 410)), {
    error: TEXT.researchPackage.taskExpired,
    rawError: "Gone",
  });
  // A timeout the client phrased still wins over the status mapping.
  assert.equal(saveFailureDetail(new ApiRequestError("Not Found", 404), "The download stalled.").error, "The download stalled.");

  setLanguage("zh-CN");
  const chinese = saveFailureDetail(new TypeError("Failed to fetch"));
  assert.equal(chinese.error, "证据包下载失败，请重试。");
  assert.doesNotMatch(chinese.error, /Failed to fetch/u, "a Chinese dialog does not show raw English");
  assert.equal(chinese.rawError, "Failed to fetch");
});

test("the download retry keeps a refusal the server named, and retries a transient one", async () => {
  setLanguage("en");
  const refusal = new ApiRequestError("export not found", 404);
  let refusingCalls = 0;
  const refusing = {
    fetchStream: async () => { refusingCalls += 1; throw refusal; },
  } as unknown as ApiClient;
  await assert.rejects(openExportStreamWithRetry(refusing, "proj-1", exportTask()), (reason: unknown) => {
    // A named refusal is the explanation the user needs: the generic localized
    // sentence must not replace it, and a 404 is not worth a retry.
    assert.equal(reason, refusal);
    assert.equal(refusingCalls, 1);
    return true;
  });

  let transientCalls = 0;
  const transient = {
    fetchStream: async () => {
      transientCalls += 1;
      if (transientCalls === 1) throw new ApiRequestError("service unavailable", 503);
      return new Response(new Uint8Array([1, 2, 3]));
    },
  } as unknown as ApiClient;
  const response = await openExportStreamWithRetry(transient, "proj-1", exportTask());
  assert.equal(transientCalls, 2, "a 503 is retried once before the download is given up on");
  assert.equal(response.status, 200);
});

test("an account HUAWEI did not name takes its display name from the dictionary", () => {
  setLanguage("en");
  assert.equal(defaultAccountName(), "HUAWEI ID user");
  assert.equal(getLanguage(), "en");
  // This is the call LoginPage makes at the three sign-in settlement sites.
  assert.equal(
    accountSessionToUserSession(unnamedAccount(), undefined, defaultAccountName()).displayName,
    "HUAWEI ID user",
  );

  setLanguage("zh-CN");
  assert.equal(defaultAccountName(), "华为账号用户");
  assert.equal(
    accountSessionToUserSession(unnamedAccount(), undefined, defaultAccountName()).displayName,
    "华为账号用户",
  );
});

test("the default account name is read at use time, not frozen when the module loads", () => {
  setLanguage("en");
  const english = defaultAccountName();
  assert.equal(english, "HUAWEI ID user");
  setLanguage("zh-CN");
  assert.notEqual(defaultAccountName(), english, "the name is read when it is used, not when the module loads");
  assert.equal(defaultAccountName(), "华为账号用户");
});

test("the three Chinese literals are gone from the modules that used them", () => {
  const sources = ["../src/views/ResearchPackage.tsx", "../src/auth/account.ts"].map(
    path => readFileSync(new URL(path, import.meta.url), "utf8"),
  );
  for (const literal of ["科研会话", "证据包下载失败，请重试。", "华为账号用户"]) {
    assert.ok(sources.every(source => !source.includes(literal)), `${literal} still bypasses the text table`);
  }
});

/** The dialog installs a focus trap and a document listener; there is no DOM here. */
function stubDocument(): () => void {
  const globals = globalThis as { document?: unknown };
  const previous = globals.document;
  globals.document = {
    activeElement: null,
    documentElement: { lang: "" },
    addEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
    removeEventListener: () => undefined,
  };
  return () => { globals.document = previous; };
}

/** A shell that can pick a destination, so the export runs its save path. */
function stubShell(write: () => Promise<unknown> = async () => ({ ok: true })): () => void {
  const globals = globalThis as unknown as { window?: unknown };
  const previous = globals.window;
  globals.window = {
    sdShell: {
      exportFile: {
        saveDialog: async () => ({ canceled: false, token: "token-A" }),
        write,
        showInFolder: async () => ({ ok: true }),
        downloadsDir: async () => "C:\\Users\\me\\Downloads",
      },
      exportHistory: {
        list: async () => [],
        reveal: async () => ({ missing: false, ok: true }),
        forget: async () => ({ ok: true }),
      },
    },
  };
  return () => { globals.window = previous; };
}

/** Answers the dialog's reads; the package download is supplied by the test. */
function exportClient(fetchStream: () => Promise<Response>): ApiClient {
  const task = { filename: "pkg.sdresearch", id: "task-1", status: "completed" };
  return {
    request: async (path: string) => {
      if (path.startsWith("/api/sessions/")) return { id: path.split("/")[3]!, messages: [], title: "session" };
      if (path.includes("/preview")) {
        return { estimatedBytes: 10, archiveBytes: 10, maxBytes: 1_000_000, files: [], omissions: [], revision: "r1" };
      }
      if (path.endsWith("/exports")) return task;
      if (path.includes("/exports/")) return task;
      return {};
    },
    fetchStream,
  } as unknown as ApiClient;
}

/** The dialog for one export, as a fresh element so a re-render reopens it. */
function dialogElement(client: ApiClient): React.ReactElement {
  return React.createElement(ResearchPackage, {
    onOpen: () => undefined,
    onRefresh: async () => undefined,
    projects: [],
    client,
    request: { kind: "export", projectId: "p1", sessionId: "s1" },
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => { for (let tick = 0; tick < 20; tick += 1) await Promise.resolve(); });
}

/** The sentence the dialog's failed row puts on screen. */
function visibleFailures(view: ReturnType<typeof create>): string[] {
  return view.root.findAllByProps({ className: "is-error" }).map(node => String(node.props.children));
}

/** The sentences the corner toasts put on screen. */
function toastMessages(view: ReturnType<typeof create>): string[] {
  return view.root.findAllByProps({ className: "research-toast-text" }).map(node => String(node.props.children));
}

test("the save-failed row shows the localized sentence and demotes the transport wording to the details", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const restoreDocument = stubDocument();
  const restoreShell = stubShell();
  setLanguage("en");
  const client = exportClient(async () => { throw new TypeError("Failed to fetch"); });
  let view: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { view = create(dialogElement(client)); });
    await flushMicrotasks();
    const start = view!.root.findAllByType("button").find(button => button.props.className === "primary-button");
    assert.ok(start, "the export dialog offers its action");
    assert.equal(start!.props.disabled, false, "the preview unblocked the export");
    await act(async () => { start!.props.onClick(); });
    await flushMicrotasks();
    // The download fails three times; the retry helper waits 500 ms, then 1 500 ms.
    for (const delay of [500, 1_500]) {
      await act(async () => { context.mock.timers.tick(delay); });
      await flushMicrotasks();
    }
    // The failed package is listed inside the dialog, which the start closed.
    await act(async () => { view!.update(dialogElement(client)); });
    await flushMicrotasks();

    const visible = visibleFailures(view!);
    assert.ok(
      visible.includes(TEXT.researchPackage.downloadFailed),
      `the failed row shows the dictionary sentence, saw ${JSON.stringify(visible)}`,
    );
    assert.ok(visible.every(text => !text.includes("Failed to fetch")), "the transport wording is not the visible sentence");
    const details = view!.root.findAllByType("code").map(node => String(node.props.children));
    assert.ok(details.includes("Failed to fetch"), `the details block keeps the transport wording, saw ${JSON.stringify(details)}`);
    // The row and the toast beside it are one sentence, not two explanations.
    assert.deepEqual(toastMessages(view!), [TEXT.researchPackage.downloadFailed], "the toast repeats the row's sentence");
  } finally {
    act(() => { view?.unmount(); });
    restoreShell();
    restoreDocument();
    context.mock.timers.reset();
  }
});

test("a stream refusal the client can name keeps its advice on the row and in the toast", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const restoreDocument = stubDocument();
  const restoreShell = stubShell();
  setLanguage("en");
  // A 404 is final, so no retry delay is needed; the client knows the task is gone.
  const client = exportClient(async () => { throw new ApiRequestError("Not Found", 404); });
  let view: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { view = create(dialogElement(client)); });
    await flushMicrotasks();
    const start = view!.root.findAllByType("button").find(button => button.props.className === "primary-button");
    assert.ok(start, "the export dialog offers its action");
    await act(async () => { start!.props.onClick(); });
    await flushMicrotasks();
    await act(async () => { view!.update(dialogElement(client)); });
    await flushMicrotasks();

    assert.deepEqual(visibleFailures(view!), [TEXT.researchPackage.taskMissing], "the row keeps the named refusal");
    assert.deepEqual(toastMessages(view!), [TEXT.researchPackage.taskMissing], "the toast says the same thing as the row");
  } finally {
    act(() => { view?.unmount(); });
    restoreShell();
    restoreDocument();
    context.mock.timers.reset();
  }
});

test("a save that fails after the write begins reports a save failure, not a download failure, and shows no path", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const restoreDocument = stubDocument();
  const restoreShell = stubShell(async () => {
    // What the shell says when the destination is not writable: the wording
    // names a path the renderer must never show (#1398 review F4).
    throw new Error("EACCES: permission denied, open '/home/me/Documents/pkg.sdresearch'");
  });
  setLanguage("en");
  const client = exportClient(async () => new Response(new Uint8Array([1, 2, 3])));
  let view: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { view = create(dialogElement(client)); });
    await flushMicrotasks();
    const start = view!.root.findAllByType("button").find(button => button.props.className === "primary-button");
    assert.ok(start, "the export dialog offers its action");
    assert.equal(start!.props.disabled, false, "the preview unblocked the export");
    await act(async () => { start!.props.onClick(); });
    await flushMicrotasks();
    await act(async () => { view!.update(dialogElement(client)); });
    await flushMicrotasks();

    const visible = visibleFailures(view!);
    assert.deepEqual(visible, [TEXT.researchPackage.exportSaveFailed], "a failed write is a save failure");
    assert.ok(!visible.includes(TEXT.researchPackage.downloadFailed), "the download sentence does not cover a shell write");
    assert.ok(visible.every(text => !text.includes("/home/me")), "the destination path never reaches the renderer");
    const details = view!.root.findAllByType("code").map(node => String(node.props.children));
    assert.deepEqual(details, [], "the shell's own wording, path included, is not recorded at all");
  } finally {
    act(() => { view?.unmount(); });
    restoreShell();
    restoreDocument();
    context.mock.timers.reset();
  }
});
