// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ApiClient } from "../src/api.js";
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
    exportResearchPackage: async () => new Blob(),
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

test("file selection shows inspection progress immediately and supports success, failure and retry", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { activeElement: null, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
  let resolve!: (value: unknown) => void, reject!: (reason: Error) => void, closed = 0;
  const client = { inspectResearchPackage: () => new Promise((done, fail) => { resolve = done; reject = fail; }) } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  const selected = { name: "研究证据.sdresearch", size: 1024 };
  try {
    await act(async () => { renderer = create(createElement(ResearchPackageDialogs, { client, target: { projectId: "p", sessionId: "s", kind: "import" }, onClose: () => { closed++; } })); });
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
    assert.ok(button(renderer!, "导入"));
    assert.equal(renderer!.root.findAllByProps({ role: "status" }).length, 0);
    assert.equal(closed, 0);
    await act(async () => { button(renderer!, "重新选择").props.onClick(); });
    assert.ok(renderer!.root.findByProps({ type: "file" }));
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.document = previousDocument;
  }
});
