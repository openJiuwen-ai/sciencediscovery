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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { FEEDBACK_MAX_IMAGES } from "@sciencediscovery/operational-logging/feedback";

import { FeedbackDialog } from "../src/FeedbackDialog.js";
import { prepareFeedbackImages } from "../src/feedback-images.js";
import { openFeedback } from "../src/feedback-open.js";
import { LocaleProvider } from "../src/i18n/index.js";

/** The browser surface the image pipeline and the mounted dialog touch, in the
 *  order they touch it. Screenshots are small and square, so every pick fits in
 *  one webp attempt and the only variable left is the cap. */
function installBrowserSurface(): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = {
    createImageBitmap: globals.createImageBitmap,
    document: globals.document,
    FileReader: globals.FileReader,
    window: globals.window,
    localStorage: globals.localStorage,
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
  globals.localStorage = localStorage;
  globals.window = {
    localStorage,
    document,
    location: { pathname: "/", search: "", hash: "" },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };

  return () => {
    globals.createImageBitmap = saved.createImageBitmap;
    globals.document = saved.document;
    globals.FileReader = saved.FileReader;
    globals.window = saved.window;
    globals.localStorage = saved.localStorage;
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

async function mountDialog(locale: "en" | "zh-CN"): Promise<ReactTestRenderer> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(LocaleProvider, { initialLocale: locale }, createElement(FeedbackDialog)));
  });
  await act(async () => { openFeedback({ kind: "bug" }); });
  return view;
}

async function closeDialog(view: ReactTestRenderer): Promise<void> {
  await act(async () => { view.unmount(); });
}

async function pickFiles(view: ReactTestRenderer, count: number): Promise<void> {
  const input = view.root.findAll((node) => node.type === "input"
    && (node.props as { type?: string }).type === "file")[0];
  assert.ok(input, "the dialog renders its hidden file input");
  await act(async () => {
    input.props.onChange({ target: { files: picks(count) } });
  });
  await flush();
}

function thumbnails(view: ReactTestRenderer): number {
  return view.root.findAll((node) => node.type === "li"
    && (node.props as { className?: string }).className === "feedback-image-item").length;
}

/** Every neutral hint the dialog currently renders, in document order. */
function hints(view: ReactTestRenderer): string[] {
  return view.root
    .findAll((node) => node.type === "p"
      && (node.props as { className?: string }).className === "feedback-hint")
    .map((node) => {
      const children = (node.props as { children?: unknown }).children;
      return typeof children === "string" ? children : "";
    })
    .filter((text) => text.length > 0);
}

test("ten picks at the eight-image cap report the two that were skipped", async () => {
  const restore = installBrowserSurface();
  try {
    const result = await prepareFeedbackImages(picks(10), []);
    assert.equal(result.images.length, FEEDBACK_MAX_IMAGES);
    assert.equal(result.skipped, 2);
  } finally {
    restore();
  }
});

test("two picks under the cap report nothing skipped", async () => {
  const restore = installBrowserSurface();
  try {
    const result = await prepareFeedbackImages(picks(2), []);
    assert.equal(result.images.length, 2);
    assert.equal(result.skipped, 0);
  } finally {
    restore();
  }
});

test("the dialog names the cap and the dropped count after an over-cap pick", async () => {
  const restore = installBrowserSurface();
  try {
    const view = await mountDialog("en");
    try {
      await pickFiles(view, 10);
      assert.equal(thumbnails(view), FEEDBACK_MAX_IMAGES);
      assert.deepEqual(
        hints(view).filter((text) => text.includes("screenshots were attached")),
        ["Only the first 8 screenshots were attached; 2 skipped."],
        "the two files the cap turned away have to be named, not silently dropped",
      );
    } finally {
      await closeDialog(view);
    }
  } finally {
    restore();
  }
});

test("the dialog says nothing extra while every pick fits", async () => {
  const restore = installBrowserSurface();
  try {
    const view = await mountDialog("en");
    try {
      await pickFiles(view, 2);
      assert.equal(thumbnails(view), 2);
      assert.deepEqual(hints(view).filter((text) => text.includes("screenshots were attached")), []);
    } finally {
      await closeDialog(view);
    }
  } finally {
    restore();
  }
});

test("removing a thumbnail frees a slot for exactly one more pick", async () => {
  const restore = installBrowserSurface();
  try {
    const view = await mountDialog("en");
    try {
      await pickFiles(view, 10);
      assert.equal(thumbnails(view), FEEDBACK_MAX_IMAGES);

      const remove = view.root.findAll((node) => node.type === "button"
        && (node.props as { className?: string }).className === "feedback-image-remove")[0];
      assert.ok(remove, "each thumbnail carries a remove button");
      await act(async () => { remove.props.onClick(); });
      assert.equal(thumbnails(view), FEEDBACK_MAX_IMAGES - 1);

      await pickFiles(view, 2);
      assert.equal(thumbnails(view), FEEDBACK_MAX_IMAGES, "only one of the two fits");
      assert.deepEqual(
        hints(view).filter((text) => text.includes("screenshots were attached")),
        ["Only the first 8 screenshots were attached; 1 skipped."],
        "the count describes the newest pick, not the previous one",
      );
    } finally {
      await closeDialog(view);
    }
  } finally {
    restore();
  }
});

test("the Chinese dialog carries the same notice with its own wording and numbers", async () => {
  const restore = installBrowserSurface();
  try {
    const view = await mountDialog("zh-CN");
    try {
      await pickFiles(view, 10);
      assert.equal(thumbnails(view), FEEDBACK_MAX_IMAGES);
      assert.deepEqual(
        hints(view).filter((text) => text.includes("张截图")),
        ["只附加了前 8 张截图，另有 2 张被跳过。"],
      );
    } finally {
      await closeDialog(view);
    }
  } finally {
    restore();
  }
});
