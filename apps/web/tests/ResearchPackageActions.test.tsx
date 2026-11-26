// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ApiClient } from "../src/api.js";
import { ApiRequestError } from "../src/api/auth.js";
import { ResearchPackageDownloadStalledError } from "../src/api/research-package-stream.js";
import { LocaleProvider } from "../src/i18n/index.js";
import { ResearchPackageDialogs } from "../src/research-package/ResearchPackageActions.js";
import { ExportPreviewCache } from "../src/research-package/export-preview-cache.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function button(renderer: ReactTestRenderer, name: string): ReactTestInstance {
  return renderer.root.find((item) => item.type === "button" && (item.children.join("") === name || item.findAllByType("strong").some((child) => child.children.join("") === name)));
}

test("evidence export choices update the estimate and custom workspace selection", async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval, clearInterval } as unknown as Window & typeof globalThis;
  globalThis.document = {
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Document;
  const previews: Array<{ level: string; paths?: string[] }> = [];
  const client = {
    getResearchPackagePreviews: async () => ({ revision: "r1",
      necessary: { revision: "r1", estimatedBytes: 1024, files: [{ path: "data/result.csv", size: 20, selected: true }, { path: "analysis.ipynb", size: 40, selected: false }], omissions: [] },
      complete: { revision: "r1", estimatedBytes: 2048, files: [{ path: "data/result.csv", size: 20, selected: true }, { path: "analysis.ipynb", size: 40, selected: true }], omissions: [] },
      completeWithTrajectory: { revision: "r1", estimatedBytes: 4096, files: [], omissions: [] },
      completeWithMemoryGraph: { revision: "r1", estimatedBytes: 8192, files: [], omissions: [] },
      completeWithTrajectoryAndMemoryGraph: { revision: "r1", estimatedBytes: 16384, files: [], omissions: [] },
    }),
    previewResearchPackage: async (_projectId: string, _sessionId: string, level: string, paths?: string[]) => {
      previews.push({ level, paths });
      return { estimatedBytes: level === "complete" ? 2048 : 1024, files: [{ path: "data/result.csv", size: 20 }, { path: "analysis.ipynb", size: 40 }].map((file) => ({ ...file, selected: paths ? paths.includes(file.path) : level === "complete" || file.path === "data/result.csv" })), omissions: ["省略历史轨迹"] };
    },
    exportResearchPackage: async () => new Response(),
  } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  try {
    await new ExportPreviewCache(client).refreshDefaults("project-a", "session-a");
    await act(async () => {
      renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ResearchPackageDialogs, {
        client,
        onClose: () => undefined,
        target: { projectId: "project-a", sessionId: "session-a", kind: "package" },
      })));
    });
    assert.ok(renderer!.root.findByProps({ role: "dialog" }));
    assert.ok(renderer!.root.findAllByType("strong").some((node) => node.children.join("").includes("预计 1.0 KiB")));
    assert.deepEqual(renderer!.root.findAllByType("input").map((node) => node.props.checked), [true, false]);
    await act(async () => { button(renderer!, "完整导出").props.onClick(); });
    await act(async () => { await Promise.resolve(); });
    assert.ok(renderer!.root.findAllByType("strong").some((node) => node.children.join("").includes("预计 2.0 KiB")));
    const checkboxes = renderer!.root.findAll((item) => item.type === "input" && item.props.type === "checkbox");
    await act(async () => { checkboxes[0]!.props.onChange({ target: { checked: false } }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    assert.ok(previews.some((item) => item.paths?.length === 1 && item.paths[0] === "analysis.ipynb"));
    await act(async () => { button(renderer!, "必要导出").props.onClick(); });
    assert.equal(previews.filter((item) => item.level === "necessary" && !item.paths).length, 0, "switching back reuses the necessary background preview");
    assert.deepEqual(renderer!.root.findAllByType("input").map((node) => node.props.checked), [true, false]);
    await act(async () => { renderer!.root.findAllByType("input")[0]!.props.onChange({ target: { checked: false } }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    assert.deepEqual(previews.at(-1)?.paths, []);
    assert.deepEqual(renderer!.root.findAllByType("input").map((node) => node.props.checked), [false, false]);
    await act(async () => { button(renderer!, "完整导出").props.onClick(); });
    assert.equal(previews.filter((item) => item.level === "complete" && !item.paths).length, 0);
    assert.deepEqual(renderer!.root.findAllByType("input").map((node) => node.props.checked), [true, true, false, false]);
    const toggles = renderer!.root.findAllByProps({ className: "research-export-toggle" });
    await act(async () => { toggles[1]!.findByType("input").props.onChange({ target: { checked: true } }); });
    assert.ok(renderer!.root.findAllByType("strong").some((node) => node.children.join("").includes("预计 8.0 KiB")));
    await act(async () => { toggles[0]!.findByType("input").props.onChange({ target: { checked: true } }); });
    assert.ok(renderer!.root.findAllByType("strong").some((node) => node.children.join("").includes("预计 16.0 KiB")));
    assert.equal(renderer!.root.findAll((item) => item.type === "button" && item.children.join("") === "刷新大小").length, 0);
    assert.equal(previews.filter((item) => item.level === "complete" && !item.paths).length, 0, "default previews are ready before the dialog opens");
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

/** Every string a user can read in the rendered tree, joined for substring checks. */
function renderedText(renderer: ReactTestRenderer): string {
  return renderer.root.findAll((item) => typeof item.type === "string")
    .map((item) => item.children.filter((child) => typeof child === "string").join("")).join("|");
}

test("the estimate is the downloaded gzip size, with the uncompressed size and limit still stated", async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval, clearInterval } as unknown as Window & typeof globalThis;
  globalThis.document = { activeElement: null, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
  // The numbers from Issue #1347: an 824,320 B tar (~805 KiB) downloads as a
  // 189,132 B gzip file. The dialog used to print the tar as `预计大小`, so the
  // headline was about four times the file the user saved.
  const preview = { revision: "r1", estimatedBytes: 824_320, archiveBytes: 824_320, estimateKind: "uncompressed" as const,
    maxBytes: 5 * 1024 * 1024 * 1024, downloadBytes: 206_080,
    files: [{ path: "data/result.csv", size: 20, selected: true }], omissions: [] };
  const client = {
    getResearchPackagePreviews: async () => ({ revision: "r1", necessary: preview, complete: preview,
      completeWithTrajectory: preview, completeWithMemoryGraph: preview, completeWithTrajectoryAndMemoryGraph: preview }),
    previewResearchPackage: async () => preview,
    exportResearchPackage: async () => new Response(),
    startResearchPackageExport: async () => ({ id: "task", status: "queued", filename: "x.sdresearch" }),
  } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  try {
    await new ExportPreviewCache(client).refreshDefaults("project-1347", "session-1347");
    await act(async () => {
      renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ResearchPackageDialogs, {
        client,
        onClose: () => undefined,
        target: { projectId: "project-1347", sessionId: "session-1347", kind: "package" },
      })));
    });
    const strongs = renderer!.root.findAllByType("strong").map((node) => node.children.join(""));
    assert.ok(strongs.includes("预计 201.3 KiB"), `the headline is the download estimate: ${JSON.stringify(strongs)}`);
    assert.equal(strongs.some((text) => text.includes("805.0 KiB")), false, "the uncompressed tar is not the headline");
    // Both numbers are visible together, and the compressed one is tied to the file.
    const rendered = renderedText(renderer!);
    assert.ok(rendered.includes("未压缩约 805.0 KiB"), `the uncompressed size stays visible: ${rendered}`);
    assert.ok(rendered.includes(".sdresearch"), "the estimate is tied to the downloaded file");
    // The cap keeps measuring the uncompressed archive.
    assert.ok(rendered.includes("未压缩上限：5.0 GiB"), rendered);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test("the uncompressed cap still refuses an over-limit selection when the download estimate is small", async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval, clearInterval } as unknown as Window & typeof globalThis;
  globalThis.document = { activeElement: null, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
  const limit = 5 * 1024 * 1024 * 1024;
  const preview = { revision: "r1", estimatedBytes: limit + 1024, archiveBytes: limit + 1024, estimateKind: "uncompressed" as const,
    maxBytes: limit, downloadBytes: 1024 * 1024 * 1024,
    files: [{ path: "data/result.csv", size: 20, selected: true }], omissions: [] };
  const client = {
    getResearchPackagePreviews: async () => ({ revision: "r1", necessary: preview, complete: preview,
      completeWithTrajectory: preview, completeWithMemoryGraph: preview, completeWithTrajectoryAndMemoryGraph: preview }),
    previewResearchPackage: async () => preview,
    exportResearchPackage: async () => new Response(),
    startResearchPackageExport: async () => ({ id: "task", status: "queued", filename: "x.sdresearch" }),
  } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  try {
    await new ExportPreviewCache(client).refreshDefaults("project-cap", "session-cap");
    await act(async () => {
      renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ResearchPackageDialogs, {
        client,
        onClose: () => undefined,
        target: { projectId: "project-cap", sessionId: "session-cap", kind: "package" },
      })));
    });
    // The headline follows the 1.0 GiB download, but the gate still uses the
    // uncompressed archive the server refuses on.
    assert.ok(renderer!.root.findAllByType("strong").some((node) => node.children.join("") === "预计 1.0 GiB"));
    assert.ok(renderer!.root.findByProps({ role: "alert" }));
    assert.equal(button(renderer!, "立即导出").props.disabled, true);
    assert.equal(button(renderer!, "仍要导出").props.disabled, undefined);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test("file selection shows inspection progress immediately and supports success, failure and retry", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { activeElement: null, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
  let resolve!: (value: unknown) => void, reject!: (reason: Error) => void, closed = 0;
  const client = { inspectResearchPackage: () => new Promise((done, fail) => { resolve = done; reject = fail; }) } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  const selected = { name: "研究证据.sdresearch", size: 1024 };
  try {
    await act(async () => { renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ResearchPackageDialogs, { client, target: { projectId: "p", sessionId: "s", kind: "import" }, onClose: () => { closed++; } }))); });
    await act(async () => { renderer!.root.findByProps({ type: "file" }).props.onChange({ target: { files: [selected] } }); });
    assert.ok(renderer!.root.findByProps({ role: "status" }));
    assert.ok(renderer!.root.findByType("h3").children.join("").includes("正在读取证据包"));
    assert.equal(renderer!.root.findByProps({ "aria-label": "关闭" }).props.disabled, true);
    await act(async () => { reject(new Error("Invalid research package")); });
    assert.equal(renderer!.root.findByProps({ role: "alert" }).children.join(""), "Invalid research package");
    assert.ok(button(renderer!, "选择证据包"));
    assert.equal(renderer!.root.findByProps({ "aria-label": "关闭" }).props.disabled, false);
    await act(async () => { renderer!.root.findByProps({ type: "file" }).props.onChange({ target: { files: [selected] } }); });
    await act(async () => { resolve({ recordsBytes: 512, objectCount: 1, manifest: { source: { title: "原研究" } } }); });
    assert.ok(button(renderer!, "导入证据包"));
    assert.equal(renderer!.root.findAllByProps({ role: "status" }).length, 0);
    assert.equal(closed, 0);
    await act(async () => { button(renderer!, "重新选择").props.onClick(); });
    assert.ok(renderer!.root.findByProps({ type: "file" }));
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.document = previousDocument;
  }
});
test("a deleted scope keeps the last estimate but disables both export buttons", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval, clearInterval } as unknown as Window & typeof globalThis;
  globalThis.document = { activeElement: null, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
  const preview = { revision: "r1", estimatedBytes: 1024, files: [{ path: "data/result.csv", size: 20, selected: true }], omissions: [] };
  const defaults = { revision: "r1", necessary: preview, complete: preview, completeWithTrajectory: preview, completeWithMemoryGraph: preview, completeWithTrajectoryAndMemoryGraph: preview };
  let fail = false;
  const client = {
    getResearchPackagePreviews: async () => {
      if (fail) throw new ApiRequestError("该项目或会话已不存在；上方为删除前的大小，已不能导出。", 410, "EXPORT_PREVIEW_RESOURCE_DELETED");
      return defaults;
    },
    previewResearchPackage: async () => preview,
    exportResearchPackage: async () => new Response(),
    startResearchPackageExport: async () => ({ id: "task", status: "queued", filename: "x.sdresearch" }),
  } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  try {
    await new ExportPreviewCache(client).refreshDefaults("project-a", "session-a");
    await act(async () => {
      renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ResearchPackageDialogs, {
        client,
        onClose: () => undefined,
        target: { projectId: "project-a", sessionId: "session-a", kind: "package" },
      })));
    });
    // Ready to export while the scope exists.
    assert.equal(button(renderer!, "立即导出").props.disabled, false);
    assert.ok(renderer!.root.findAllByType("strong").some((node) => node.children.join("").includes("预计 1.0 KiB")));
    // The Project is deleted elsewhere; the dialog's own 3 s poll answers `deleted`.
    fail = true;
    await act(async () => { context.mock.timers.tick(3_000); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(button(renderer!, "立即导出").props.disabled, true, "a gone scope cannot be exported");
    assert.equal(button(renderer!, "后台导出").props.disabled, true);
    // The last estimate stays on screen as the pre-deletion snapshot, and the
    // sentence points at it (above, never below — #1074 F6).
    assert.ok(renderer!.root.findAllByType("strong").some((node) => node.children.join("").includes("预计 1.0 KiB")));
    assert.equal(renderer!.root.findByProps({ role: "alert" }).children.join(""), "该项目或会话已不存在；上方为删除前的大小，已不能导出。");
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    context.mock.timers.reset();
  }
});

test("a scope already gone at open claims no snapshot and stops promising a size", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval, clearInterval } as unknown as Window & typeof globalThis;
  globalThis.document = { activeElement: null, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
  const client = {
    getResearchPackagePreviews: async () => { throw new ApiRequestError("该项目或会话已不存在；上方为删除前的大小，已不能导出。", 410, "EXPORT_PREVIEW_RESOURCE_DELETED"); },
    previewResearchPackage: async () => ({ revision: "r1", estimatedBytes: 1024, files: [], omissions: [] }),
    exportResearchPackage: async () => new Response(),
  } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  try {
    // No refreshDefaults() for this scope: the dialog opens with no cached
    // snapshot, which is the state the F6 finding is about.
    await act(async () => {
      renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ResearchPackageDialogs, {
        client,
        onClose: () => undefined,
        target: { projectId: "project-gone", sessionId: "session-gone", kind: "package" },
      })));
    });
    await act(async () => { await Promise.resolve(); });
    assert.equal(button(renderer!, "立即导出").props.disabled, true);
    // Without a snapshot the sentence must not claim there is one.
    assert.equal(renderer!.root.findByProps({ role: "alert" }).children.join(""), "该项目或会话已不存在，已无法再读取大小。");
    // And nothing will ever be calculated, so the dialog must not keep saying it will.
    const strongs = renderer!.root.findAllByType("strong").map((node) => node.children.join(""));
    assert.equal(strongs.some((text) => text.includes("正在计算大小")), false);
    assert.ok(strongs.includes("—"), `expected the estimate to read as unavailable, got ${JSON.stringify(strongs)}`);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    context.mock.timers.reset();
  }
});

test("a gone scope still admits the sizes its scope cards are showing", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval, clearInterval } as unknown as Window & typeof globalThis;
  globalThis.document = { activeElement: null, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
  const preview = { revision: "r1", estimatedBytes: 1024, files: [{ path: "data/result.csv", size: 20, selected: true }], omissions: [] };
  const defaults = { revision: "r1", necessary: preview, complete: { ...preview, estimatedBytes: 2048 }, completeWithTrajectory: preview, completeWithMemoryGraph: preview, completeWithTrajectoryAndMemoryGraph: preview };
  let fail = false;
  const client = {
    getResearchPackagePreviews: async () => {
      if (fail) throw new ApiRequestError("该项目或会话已不存在；上方为删除前的大小，已不能导出。", 410, "EXPORT_PREVIEW_RESOURCE_DELETED");
      return defaults;
    },
    // Changing the file selection asks for a custom preview; after the deletion
    // that request answers 404, so the estimate stays empty while the two scope
    // cards keep the sizes they read from the cached defaults.
    previewResearchPackage: async () => {
      throw new ApiRequestError("Preview file is no longer available", 404, "EXPORT_PREVIEW_RESOURCE_DELETED");
    },
    exportResearchPackage: async () => new Response(),
    startResearchPackageExport: async () => ({ id: "task", status: "queued", filename: "x.sdresearch" }),
  } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  try {
    await new ExportPreviewCache(client).refreshDefaults("project-select", "session-select");
    await act(async () => {
      renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ResearchPackageDialogs, {
        client,
        onClose: () => undefined,
        target: { projectId: "project-select", sessionId: "session-select", kind: "package" },
      })));
    });
    const checked = renderer!.root.findAll((item) => item.type === "input" && item.props.type === "checkbox" && item.props.checked === true);
    assert.ok(checked.length > 0, "the dialog must list the selectable workspace file");
    await act(async () => { checked[0]!.props.onChange({ target: { checked: false } }); });
    assert.equal(renderer!.root.findAllByType("strong").some((node) => node.children.join("") === "预计 1.0 KiB"), false, "the estimate is gone once a custom selection is pending");
    fail = true;
    // The gone answer arrives through the dialog's own poll; wait for the state
    // instead of counting microtasks, so the assertion does not depend on how
    // many awaits the microtask queue happens to need on a given host.
    const alertText = () => renderer!.root.findAll((item) => item.props?.role === "alert").map((item) => item.children.join("")).join("|");
    for (let attempt = 0; attempt < 20 && !alertText().includes("上方为删除前的大小"); attempt += 1) {
      await act(async () => { context.mock.timers.tick(3_000); });
      await act(async () => { await Promise.resolve(); });
    }
    // The estimate is empty, but both cards still carry their sizes from the
    // cached defaults — so the sentence must admit that sizes remain visible.
    const strongs = renderer!.root.findAllByType("strong").map((node) => node.children.join("")).join("|");
    assert.ok(strongs.includes("—"), `the estimate should read as unavailable, got ${strongs}`);
    const rendered = renderer!.root.findAll((item) => typeof item.type === "string")
      .map((item) => item.children.filter((child) => typeof child === "string").join("")).join("|");
    assert.ok(rendered.includes("1.0 KiB") && rendered.includes("2.0 KiB"), `the scope cards keep their sizes: ${rendered}`);
    assert.equal(alertText(), "该项目或会话已不存在；上方为删除前的大小，已不能导出。");
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    context.mock.timers.reset();
  }
});
test("canceling a foreground package export aborts its request", async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval, clearInterval } as unknown as Window & typeof globalThis;
  globalThis.document = {
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Document;
  const preview = { revision: "r1", estimatedBytes: 1024, files: [], omissions: [] };
  const defaults = {
    revision: "r1",
    necessary: preview,
    complete: preview,
    completeWithTrajectory: preview,
    completeWithMemoryGraph: preview,
    completeWithTrajectoryAndMemoryGraph: preview,
  };
  let receivedSignal: AbortSignal | undefined;
  const client = {
    getResearchPackagePreviews: async () => defaults,
    exportResearchPackage: async (...args: unknown[]) => {
      receivedSignal = args.at(-1) as AbortSignal | undefined;
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        if (receivedSignal?.aborted) abort();
        else receivedSignal?.addEventListener("abort", abort, { once: true });
      });
    },
  } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  try {
    await new ExportPreviewCache(client).refreshDefaults("project-cancel", "session-cancel");
    await act(async () => {
      renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ResearchPackageDialogs, {
        client,
        onClose: () => undefined,
        target: { projectId: "project-cancel", sessionId: "session-cancel", kind: "package" },
      })));
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { void button(renderer!, "立即导出").props.onClick(); await Promise.resolve(); });
    assert.ok(receivedSignal, "the export request should receive a caller-owned signal");
    await act(async () => { button(renderer!, "取消").props.onClick(); await Promise.resolve(); });
    assert.equal(receivedSignal.aborted, true);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

for (const { locale, exportLabel, expected } of [
  { locale: "zh-CN", exportLabel: "立即导出", expected: "证据包下载长时间没有收到数据。请检查网络连接后重试。" },
  { locale: "en", exportLabel: "Immediate export", expected: "The evidence package download stalled. Check your connection and try again." },
] as const) {
  test(`foreground export shows the localized download stall alert (${locale})`, async () => {
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.window = { setInterval, clearInterval } as unknown as Window & typeof globalThis;
    globalThis.document = {
      activeElement: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as Document;
    const preview = { revision: "r1", estimatedBytes: 1024, files: [], omissions: [] };
    const client = {
      getResearchPackagePreviews: async () => ({
        revision: "r1",
        necessary: preview,
        complete: preview,
        completeWithTrajectory: preview,
        completeWithMemoryGraph: preview,
        completeWithTrajectoryAndMemoryGraph: preview,
      }),
      exportResearchPackage: async () => { throw new ResearchPackageDownloadStalledError(); },
    } as unknown as ApiClient;
    const target = { projectId: "project-stall", sessionId: "session-stall", kind: "package" } as const;
    let renderer: ReactTestRenderer | undefined;
    try {
      await new ExportPreviewCache(client).refreshDefaults(target.projectId, target.sessionId);
      await act(async () => {
        renderer = create(createElement(LocaleProvider, { initialLocale: locale }, createElement(ResearchPackageDialogs, {
          client, onClose: () => assert.fail("a stalled export should leave the dialog open"), target,
        })));
      });
      const immediateExport = button(renderer!, exportLabel);
      assert.equal(immediateExport.props.disabled, false);
      await act(async () => { await immediateExport.props.onClick(); });
      assert.deepEqual(renderer!.root.findAllByProps({ role: "alert" }).map(alert => alert.children.join("")), [expected]);
    } finally {
      if (renderer) await act(async () => renderer!.unmount());
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
    }
  });
}

test("a failed estimate shows a localized lead and keeps the service sentence in the technical details", async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval, clearInterval } as unknown as Window & typeof globalThis;
  globalThis.document = { activeElement: null, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
  const closed = () => new ApiRequestError("Export preview service is closed", 503, "EXPORT_PREVIEW_SERVICE_CLOSED");
  const client = {
    getResearchPackagePreviews: async () => { throw closed(); },
    previewResearchPackage: async () => { throw closed(); },
    exportResearchPackage: async () => new Response(),
  } as unknown as ApiClient;
  try {
    for (const [locale, lead] of [["zh-CN", "预估大小失败"], ["en", "Could not estimate the size"]] as const) {
      let renderer: ReactTestRenderer | undefined;
      try {
        await act(async () => {
          renderer = create(createElement(LocaleProvider, { initialLocale: locale }, createElement(ResearchPackageDialogs, {
            client, onClose: () => undefined,
            target: { projectId: "project-failed", sessionId: "session-failed", kind: "package" },
          })));
        });
        const alerts = () => renderer!.root.findAll((item) => item.props?.role === "alert");
        for (let attempt = 0; attempt < 20 && !alerts().length; attempt += 1) await act(async () => { await Promise.resolve(); });
        assert.equal(alerts().length, 1, `${locale}: one alert`);
        const alert = alerts()[0]!;
        // The visible lead is the dialog's own localized sentence, not the service's.
        assert.deepEqual(alert.findAllByType("p").map((node) => node.children.join("")), [lead]);
        // The service sentence is reachable only through the technical-details disclosure.
        const details = alert.findAllByType("details");
        assert.equal(details.length, 1, `${locale}: the raw text is under a disclosure`);
        assert.equal(details[0]!.findAllByType("summary")[0]!.children.join(""),
          locale === "zh-CN" ? "技术详情" : "Technical details");
        assert.ok(alert.findAllByType("code").some((node) => node.children.join("") === "Export preview service is closed"));
      } finally {
        if (renderer) await act(async () => renderer!.unmount());
      }
    }
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test("a pending selection preview keeps retrying instead of reporting a failure", async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval, clearInterval } as unknown as Window & typeof globalThis;
  globalThis.document = { activeElement: null, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
  const preview = { revision: "r1", estimatedBytes: 1024, archiveBytes: 1024, downloadBytes: 256, estimateKind: "uncompressed" as const,
    files: [{ path: "a.csv", size: 10, selected: true }], omissions: [] };
  let calls = 0;
  const client = {
    getResearchPackagePreviews: async () => ({ revision: "r1", necessary: preview, complete: preview,
      completeWithTrajectory: preview, completeWithMemoryGraph: preview, completeWithTrajectoryAndMemoryGraph: preview }),
    previewResearchPackage: async () => { calls += 1; throw new ApiRequestError("Export preview is pending", 409, "EXPORT_PREVIEW_PENDING"); },
    exportResearchPackage: async () => new Response(),
  } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  try {
    await new ExportPreviewCache(client).refreshDefaults("project-pending", "session-pending");
    await act(async () => {
      renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ResearchPackageDialogs, {
        client, onClose: () => undefined,
        target: { projectId: "project-pending", sessionId: "session-pending", kind: "package" },
      })));
    });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(renderer!.root.findAllByType("input").map((node) => node.props.checked), [true]);
    // A custom selection asks for its own preview, which answers "still computing".
    await act(async () => { renderer!.root.findAllByType("input")[0]!.props.onChange({ target: { checked: false } }); });
    await act(async () => { await new Promise((done) => setTimeout(done, 260)); });
    await act(async () => { await new Promise((done) => setTimeout(done, 1_800)); });
    assert.ok(calls >= 2, `the pending answer is retried, not failed: ${calls}`);
    // No red estimate failure: the dialog keeps its localized calculating state.
    assert.equal(renderer!.root.findAll((item) => item.props?.role === "alert").length, 0);
    assert.ok(renderedText(renderer!).includes("正在计算大小…"));
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test("a selection preview deleted elsewhere ends as the gone state, not an estimate failure", async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval, clearInterval } as unknown as Window & typeof globalThis;
  globalThis.document = { activeElement: null, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
  const preview = { revision: "r1", estimatedBytes: 1024, archiveBytes: 1024, downloadBytes: 256, estimateKind: "uncompressed" as const,
    files: [{ path: "a.csv", size: 10, selected: true }], omissions: [] };
  const deleted = "该项目或会话已不存在；上方为删除前的大小，已不能导出。";
  const client = {
    getResearchPackagePreviews: async () => ({ revision: "r1", necessary: preview, complete: preview,
      completeWithTrajectory: preview, completeWithMemoryGraph: preview, completeWithTrajectoryAndMemoryGraph: preview }),
    previewResearchPackage: async () => { throw new ApiRequestError(deleted, 410, "EXPORT_PREVIEW_RESOURCE_DELETED"); },
    exportResearchPackage: async () => new Response(),
    startResearchPackageExport: async () => ({ id: "task", status: "queued", filename: "x.sdresearch" }),
  } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  try {
    await new ExportPreviewCache(client).refreshDefaults("project-gone-select", "session-gone-select");
    await act(async () => {
      renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ResearchPackageDialogs, {
        client, onClose: () => undefined,
        target: { projectId: "project-gone-select", sessionId: "session-gone-select", kind: "package" },
      })));
    });
    await act(async () => { renderer!.root.findAllByType("input")[0]!.props.onChange({ target: { checked: false } }); });
    await act(async () => { await new Promise((done) => setTimeout(done, 260)); });
    const alert = renderer!.root.findByProps({ role: "alert" });
    assert.equal(alert.children.join(""), deleted);
    // The gone state, not the generic estimate failure: no technical-details disclosure.
    assert.equal(alert.findAllByType("details").length, 0);
    assert.equal(button(renderer!, "立即导出").props.disabled, true);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test("a defaults refresh does not clear a selection failure while the estimate is missing", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval, clearInterval } as unknown as Window & typeof globalThis;
  globalThis.document = { activeElement: null, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
  const preview = { revision: "r1", estimatedBytes: 1024, archiveBytes: 1024, downloadBytes: 256, estimateKind: "uncompressed" as const,
    files: [{ path: "a.csv", size: 10, selected: true }], omissions: [] };
  const client = {
    getResearchPackagePreviews: async () => ({ revision: "r1", necessary: preview, complete: preview,
      completeWithTrajectory: preview, completeWithMemoryGraph: preview, completeWithTrajectoryAndMemoryGraph: preview }),
    previewResearchPackage: async () => { throw new ApiRequestError("Export preview service is closed", 503, "EXPORT_PREVIEW_SERVICE_CLOSED"); },
    exportResearchPackage: async () => new Response(),
  } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  try {
    await new ExportPreviewCache(client).refreshDefaults("project-keep", "session-keep");
    await act(async () => {
      renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ResearchPackageDialogs, {
        client, onClose: () => undefined,
        target: { projectId: "project-keep", sessionId: "session-keep", kind: "package" },
      })));
    });
    await act(async () => { renderer!.root.findAllByType("input")[0]!.props.onChange({ target: { checked: false } }); });
    await act(async () => { await new Promise((done) => setTimeout(done, 260)); });
    assert.deepEqual(renderer!.root.findByProps({ role: "alert" }).findAllByType("p").map((node) => node.children.join("")), ["预估大小失败"]);
    // The 3 s defaults poll succeeds; it must not erase the selection's failure while
    // the selection preview is still missing (the user would see "calculating" forever).
    await act(async () => { context.mock.timers.tick(3_000); });
    await act(async () => { await Promise.resolve(); });
    const alerts = renderer!.root.findAll((item) => item.props?.role === "alert");
    assert.equal(alerts.length, 1);
    assert.deepEqual(alerts[0]!.findAllByType("p").map((node) => node.children.join("")), ["预估大小失败"]);
    assert.ok(renderedText(renderer!).includes("正在计算大小…"));
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    context.mock.timers.reset();
  }
});

test("a defaults poll failure cannot hand a selection failure to a later defaults success", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval, clearInterval } as unknown as Window & typeof globalThis;
  globalThis.document = { activeElement: null, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
  const preview = { revision: "r1", estimatedBytes: 1024, archiveBytes: 1024, downloadBytes: 256, estimateKind: "uncompressed" as const,
    files: [{ path: "a.csv", size: 10, selected: true }], omissions: [] };
  const defaults = { revision: "r1", necessary: preview, complete: preview,
    completeWithTrajectory: preview, completeWithMemoryGraph: preview, completeWithTrajectoryAndMemoryGraph: preview };
  let defaultsCalls = 0;
  const client = {
    getResearchPackagePreviews: async () => {
      defaultsCalls += 1;
      // 1 = preload, 2 = mount refresh, 3 = the poll that fails while the selection
      // failure is unresolved, 4+ = the poll that recovers.
      if (defaultsCalls === 3) throw new ApiRequestError("Export preview service is closed", 503, "EXPORT_PREVIEW_SERVICE_CLOSED");
      return defaults;
    },
    previewResearchPackage: async () => { throw new ApiRequestError("Export preview service is closed", 503, "EXPORT_PREVIEW_SERVICE_CLOSED"); },
    exportResearchPackage: async () => new Response(),
  } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  try {
    await new ExportPreviewCache(client).refreshDefaults("project-seq", "session-seq");
    await act(async () => {
      renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ResearchPackageDialogs, {
        client, onClose: () => undefined,
        target: { projectId: "project-seq", sessionId: "session-seq", kind: "package" },
      })));
    });
    await act(async () => { renderer!.root.findAllByType("input")[0]!.props.onChange({ target: { checked: false } }); });
    await act(async () => { await new Promise((done) => setTimeout(done, 260)); });
    const alertLead = () => renderer!.root.findAll((item) => item.props?.role === "alert")
      .flatMap((alert) => alert.findAllByType("p").map((node) => node.children.join("")));
    assert.deepEqual(alertLead(), ["预估大小失败"]);
    // The defaults poll fails while the selection is unresolved: it must not take
    // over the message...
    await act(async () => { context.mock.timers.tick(3_000); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(alertLead(), ["预估大小失败"]);
    // ...because the next successful defaults poll would then erase the failure.
    await act(async () => { context.mock.timers.tick(3_000); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(alertLead(), ["预估大小失败"]);
    assert.ok(renderedText(renderer!).includes("正在计算大小…"));
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    context.mock.timers.reset();
  }
});

test("a selection preview that stays pending ends in the localized stalled notice", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = { setInterval, clearInterval } as unknown as Window & typeof globalThis;
  globalThis.document = { activeElement: null, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
  const preview = { revision: "r1", estimatedBytes: 1024, archiveBytes: 1024, downloadBytes: 256, estimateKind: "uncompressed" as const,
    files: [{ path: "a.csv", size: 10, selected: true }], omissions: [] };
  let calls = 0;
  const client = {
    getResearchPackagePreviews: async () => ({ revision: "r1", necessary: preview, complete: preview,
      completeWithTrajectory: preview, completeWithMemoryGraph: preview, completeWithTrajectoryAndMemoryGraph: preview }),
    previewResearchPackage: async () => { calls += 1; throw new ApiRequestError("Export preview is pending", 409, "EXPORT_PREVIEW_PENDING"); },
    exportResearchPackage: async () => new Response(),
  } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  try {
    await new ExportPreviewCache(client).refreshDefaults("project-stalled", "session-stalled");
    await act(async () => {
      renderer = create(createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ResearchPackageDialogs, {
        client, onClose: () => undefined,
        target: { projectId: "project-stalled", sessionId: "session-stalled", kind: "package" },
      })));
    });
    await act(async () => { renderer!.root.findAllByType("input")[0]!.props.onChange({ target: { checked: false } }); });
    for (let step = 0; step < 7; step += 1) {
      await act(async () => { context.mock.timers.tick(1_600); });
      await act(async () => { await Promise.resolve(); });
    }
    assert.ok(calls >= 6, `the pending answer is retried before giving up: ${calls}`);
    const text = renderedText(renderer!);
    assert.ok(text.includes("大小预估仍在计算中；可以切换范围重新计算，或稍后再试。"), text);
    assert.equal(text.includes("预估大小失败"), false);
    assert.equal(renderer!.root.findAll((item) => item.props?.role === "alert").length, 0);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    context.mock.timers.reset();
  }
});
