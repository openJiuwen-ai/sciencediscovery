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

// #945: one multi-select past the eight-image cap attaches eight screenshots
// and the rest disappear without a word. The dialog could only report an
// unsuccessful pick (`imageError`), never a partially successful one, so the
// fix reports how many were dropped and says so in both dictionaries. The
// module assertions are the red shape the issue records; the mounted ones keep
// the notice tied to the dialog that has to show it, and pin the negative
// direction so a blanket banner cannot pass.

import React from "react";
import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";

import { FEEDBACK_MAX_IMAGES } from "@sciencediscovery/operational-logging/feedback";

import { FeedbackDialog } from "../src/feedback/FeedbackDialog.js";
import { prepareFeedbackImages } from "../src/feedback/feedback-images.js";
import { openFeedback } from "../src/feedback/open.js";
import { setLanguage } from "../src/text.js";
import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

/** The browser surface the image pipeline and the mounted dialog touch, in the
 *  order they touch it. Every screenshot is small and square, so each pick fits
 *  in one webp attempt and the cap is the only variable left. */
function installBrowserSurface(): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = {
    createImageBitmap: globals.createImageBitmap,
    document: globals.document,
    FileReader: globals.FileReader,
    window: globals.window,
    IS_REACT_ACT_ENVIRONMENT: globals.IS_REACT_ACT_ENVIRONMENT,
  };

  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  };
  const document = {
    documentElement: { lang: "en" },
    body: { appendChild: () => undefined, removeChild: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: (tag: string) => (tag === "canvas"
      ? {
        width: 0,
        height: 0,
        getContext: () => ({ fillStyle: "", fillRect: () => undefined, drawImage: () => undefined }),
        toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob(["webp"], { type: "image/webp" })),
      }
      : { style: {}, select: () => undefined, remove: () => undefined }),
  };

  globals.createImageBitmap = async () => ({ width: 16, height: 16, close: () => undefined });
  globals.document = document;
  globals.FileReader = class {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(): void {
      this.result = "data:image/webp;base64,d2VicA==";
      void Promise.resolve().then(() => this.onload?.());
    }
  };
  globals.window = { localStorage, document, location: { pathname: "/", search: "", hash: "" } };
  globals.IS_REACT_ACT_ENVIRONMENT = true;

  return () => {
    globals.createImageBitmap = saved.createImageBitmap;
    globals.document = saved.document;
    globals.FileReader = saved.FileReader;
    globals.window = saved.window;
    globals.IS_REACT_ACT_ENVIRONMENT = saved.IS_REACT_ACT_ENVIRONMENT;
    setLanguage("en");
  };
}

function picks(count: number): File[] {
  return Array.from({ length: count }, (_, index) => new File(
    [new Uint8Array([1, 2, 3])],
    `shot-${index + 1}.png`,
    { type: "image/png" },
  ));
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mountDialog(language: "en" | "zh-CN"): Promise<ReactTestRenderer> {
  setLanguage(language);
  let view!: ReactTestRenderer;
  await act(async () => { view = create(React.createElement(FeedbackDialog)); });
  await act(async () => { openFeedback({ kind: "bug" }); });
  return view;
}

function fileInput(view: ReactTestRenderer) {
  const [input] = view.root.findAll((node) => node.type === "input"
    && (node.props as { type?: string }).type === "file");
  assert.ok(input, "the dialog renders its hidden file input");
  return input;
}

async function pickFiles(view: ReactTestRenderer, count: number): Promise<void> {
  await act(async () => { fileInput(view).props.onChange({ target: { files: picks(count) } }); });
  await flush();
}

function thumbnails(view: ReactTestRenderer): number {
  return view.root.findAll((node) => node.type === "li"
    && (node.props as { className?: string }).className === "feedback-image-item").length;
}

/** Every neutral hint the dialog currently renders, in document order. */
function hints(view: ReactTestRenderer): string[] {
  return view.root.findAll((node) => node.type === "p"
    && (node.props as { className?: string }).className === "feedback-hint")
    .map((node) => (node.children as Array<string | { toString(): string }>)
      .map((child) => (typeof child === "string" ? child : child.toString())).join(""));
}

test("the desktop dialog counts the screenshots the eight-image cap drops", async (context) => {
  const restore = installBrowserSurface();
  context.after(restore);

  const ten = await prepareFeedbackImages(picks(10), []);
  assert.equal(ten.images.length, FEEDBACK_MAX_IMAGES);
  assert.equal(ten.skipped, 2, "a ten-file pick at the cap reports the two it could not attach");

  const two = await prepareFeedbackImages(picks(2), []);
  assert.equal(two.images.length, 2);
  assert.equal(two.skipped, 0, "a pick under the cap reports nothing skipped");

  const { images: eight } = await prepareFeedbackImages(picks(8), []);
  const afterRemoval = [...eight].filter((_, index) => index !== 0);
  const refill = await prepareFeedbackImages(picks(2), afterRemoval);
  assert.equal(refill.images.length, FEEDBACK_MAX_IMAGES);
  assert.equal(refill.skipped, 1, "after one is removed, two picks attach one and skip one");
});

test("an over-cap pick says how many screenshots were skipped, in English and Chinese", async (context) => {
  const restore = installBrowserSurface();
  const english = await mountDialog("en");
  await pickFiles(english, 10);
  assert.equal(thumbnails(english), FEEDBACK_MAX_IMAGES, "eight thumbnails stay attached");
  const englishHints = hints(english).filter((text) => text.includes("screenshots were attached"));
  assert.deepEqual(englishHints, [`Only the first ${FEEDBACK_MAX_IMAGES} screenshots were attached; 2 skipped.`]);
  // One dialog is subscribed at a time, so the language switch below cannot
  // re-render the English tree while the Chinese one mounts.
  await act(async () => { english.unmount(); });

  const chinese = await mountDialog("zh-CN");
  context.after(async () => { await act(async () => { chinese.unmount(); }); restore(); });
  await pickFiles(chinese, 10);
  const chineseHints = hints(chinese).filter((text) => text.includes("张截图"));
  assert.deepEqual(chineseHints, [`只附加了前 ${FEEDBACK_MAX_IMAGES} 张截图，另有 2 张被跳过。`]);
});

test("a pick under the cap says nothing about skipped screenshots", async (context) => {
  const restore = installBrowserSurface();
  const view = await mountDialog("en");
  context.after(async () => { await act(async () => { view.unmount(); }); restore(); });

  await pickFiles(view, 2);
  assert.equal(thumbnails(view), 2);
  assert.deepEqual(hints(view).filter((text) => text.includes("screenshots were attached")), [],
    "the notice must describe a dropped file, not appear on every pick");
});
