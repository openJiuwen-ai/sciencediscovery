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

// A pick larger than the eight-image cap is reported instead of losing its tail
// silently. The module cases pin the count; the mounted-dialog cases pin what
// the user reads, in both dictionaries, so a copy change cannot quiet the
// notice again.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import { FEEDBACK_MAX_IMAGES } from "@sciencediscovery/operational-logging/feedback";
import React from "react";

import { FeedbackDialog } from "../src/feedback/FeedbackDialog.js";
import { prepareFeedbackImages } from "../src/feedback/feedback-images.js";
import { openFeedback } from "../src/feedback/open.js";
import { setLanguage, TEXT } from "../src/text.js";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "./support/dom-renderer.js";

/** One in-memory pick, named so thumbnails can be counted apart from the other
 *  `<img>` elements the dialog draws. */
function image(name: string): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
}

function picks(count: number, label = "shot"): File[] {
  return Array.from({ length: count }, (_, index) => image(`${label}-${index + 1}.png`));
}

/**
 * The browser pieces `prepareFeedbackImage` touches. Decoding becomes a bitmap,
 * the canvas re-encodes to a small blob, and the data-URL read is what a
 * `FileReader` would hand back — the same code path the app runs, without a
 * real renderer.
 */
function installBrowserSurface(): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const keys = ["FileReader", "createImageBitmap", "document", "localStorage", "navigator", "window"] as const;
  const previous = new Map<string, PropertyDescriptor | undefined>();

  /** Node 22 exposes some of these as getters, so they cannot simply be
   *  assigned; every one is installed and taken back through a descriptor. */
  const install = (key: string, value: unknown): void => {
    if (!previous.has(key)) previous.set(key, Object.getOwnPropertyDescriptor(globals, key));
    Object.defineProperty(globals, key, { configurable: true, value, writable: true });
  };

  const stored = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    removeItem: (key: string) => { stored.delete(key); },
    setItem: (key: string, value: string) => { stored.set(key, String(value)); },
  };

  class StubFileReader {
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    result: string | null = null;
    readAsDataURL(): void {
      this.result = "data:image/webp;base64,c2hvdA==";
      this.onload?.();
    }
  }

  install("localStorage", localStorage);
  install("window", { localStorage });
  install("navigator", { platform: "linux", userAgent: "desktop-test" });
  install("document", {
    addEventListener: () => {},
    body: { appendChild: () => {} },
    createElement: (tag: string) => tag === "canvas"
      ? {
        getContext: () => ({ drawImage: () => {}, fillRect: () => {}, fillStyle: "" }),
        height: 0,
        toBlob: (callback: (blob: unknown) => void) => callback({ size: 1024, type: "image/webp" }),
        width: 0,
      }
      : { remove: () => {}, select: () => {}, style: {} },
    documentElement: { lang: "" },
    execCommand: () => true,
    removeEventListener: () => {},
  });
  install("createImageBitmap", async () => ({ close: () => {}, height: 1000, width: 1600 }));
  install("FileReader", StubFileReader);

  return () => {
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globals, key, descriptor);
      else delete globals[key];
    }
  };
}

/** Make image decoding fail, for the error case. */
function failDecoding(): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => { throw new Error("not an image"); },
    writable: true,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "createImageBitmap", previous);
    else delete (globalThis as unknown as Record<string, unknown>).createImageBitmap;
  };
}

function textOf(node: ReactTestInstance): string {
  const render = (child: ReactTestInstance | string): string =>
    typeof child === "string" ? child : child.children.map(render).join("");
  return node.children.map(render).join("");
}

/** The neutral hints under the picker, which is where a partial pick is said. */
function hints(view: ReactTestRenderer): string[] {
  return view.root.findAllByProps({ className: "feedback-hint" }).map(textOf);
}

function truncationNotes(view: ReactTestRenderer): string[] {
  return hints(view).filter((text) => /screenshots were attached|张截图/.test(text));
}

function thumbnails(view: ReactTestRenderer): string[] {
  return view.root.findAllByType("img").map((node) => String(node.props.alt));
}

function errorLines(view: ReactTestRenderer): string[] {
  return view.root.findAllByProps({ className: "feedback-inline-error" }).map(textOf);
}

async function openDialog(language: "zh-CN" | "en"): Promise<{
  input: ReactTestInstance;
  view: ReactTestRenderer;
}> {
  setLanguage(language);
  let view: ReactTestRenderer;
  await act(async () => {
    view = create(<FeedbackDialog />);
  });
  await act(async () => { openFeedback(); });
  return { input: view!.root.findAllByProps({ type: "file" })[0]!, view: view! };
}

async function add(input: ReactTestInstance, files: File[]): Promise<void> {
  const onChange = input.props.onChange as (event: { target: { files: File[] } }) => Promise<void>;
  await act(async () => { await onChange({ target: { files } }); });
}

describe("the feedback image picker", () => {
  it("attaches the first eight of ten and counts the two it dropped", async () => {
    const restore = installBrowserSurface();
    try {
      const result = await prepareFeedbackImages(picks(10), []);
      assert.equal(result.images.length, FEEDBACK_MAX_IMAGES);
      assert.equal(result.skipped, 2);
      assert.equal(result.error, undefined);
      assert.equal(result.images.at(-1)?.name, "shot-8.png");
    } finally {
      restore();
    }
  });

  it("says nothing is skipped when the whole pick fits", async () => {
    const restore = installBrowserSurface();
    try {
      const result = await prepareFeedbackImages(picks(2), []);
      assert.equal(result.images.length, 2);
      assert.equal(result.skipped, 0);
      assert.equal(result.error, undefined);
    } finally {
      restore();
    }
  });

  it("starts from what is already attached, so a refill reports what did not fit", async () => {
    const restore = installBrowserSurface();
    try {
      const first = await prepareFeedbackImages(picks(7, "old"), []);
      const second = await prepareFeedbackImages(picks(2, "new"), first.images);
      assert.equal(second.images.length, FEEDBACK_MAX_IMAGES);
      assert.equal(second.skipped, 1);
      assert.equal(second.images.at(-1)?.name, "new-1.png");
    } finally {
      restore();
    }
  });

  it("reports a failing file as an error, with nothing counted as skipped", async () => {
    const restoreSurface = installBrowserSurface();
    const restoreDecoding = failDecoding();
    try {
      const result = await prepareFeedbackImages([image("broken-1.png"), ...picks(2)], []);
      assert.equal(result.error, "decode");
      assert.equal(result.skipped, 0);
      assert.equal(result.images.length, 0);
    } finally {
      restoreDecoding();
      restoreSurface();
    }
  });
});

describe("the feedback dialog's screenshot notice", () => {
  it("names the cap and the dropped count after an over-cap pick", async () => {
    const restore = installBrowserSurface();
    try {
      const { input, view } = await openDialog("en");
      await add(input, picks(10));
      assert.equal(thumbnails(view).length, FEEDBACK_MAX_IMAGES);
      assert.deepEqual(truncationNotes(view), [
        "Only the first 8 screenshots were attached; 2 skipped.",
      ], "the two files the cap turned away have to be named, not silently dropped");
      await act(async () => { view.unmount(); });
    } finally {
      restore();
    }
  });

  it("says nothing extra while every pick fits", async () => {
    const restore = installBrowserSurface();
    try {
      const { input, view } = await openDialog("en");
      await add(input, picks(2));
      assert.equal(thumbnails(view).length, 2);
      assert.deepEqual(truncationNotes(view), []);
      // Number-neutral wording: `1 skipped`, not `1 were skipped`.
      assert.equal(
        TEXT.feedback.images.truncated(FEEDBACK_MAX_IMAGES, 1),
        "Only the first 8 screenshots were attached; 1 skipped.",
      );
      await act(async () => { view.unmount(); });
    } finally {
      restore();
    }
  });

  it("carries its own wording and numbers in Chinese", async () => {
    const restore = installBrowserSurface();
    try {
      const { input, view } = await openDialog("zh-CN");
      await add(input, picks(10));
      assert.equal(thumbnails(view).length, FEEDBACK_MAX_IMAGES);
      assert.deepEqual(truncationNotes(view), ["只附加了前 8 张截图，另有 2 张被跳过。"]);
      await act(async () => { view.unmount(); });
    } finally {
      restore();
      setLanguage("zh-CN");
    }
  });

  it("clears the count when a thumbnail is removed", async () => {
    const restore = installBrowserSurface();
    try {
      const { input, view } = await openDialog("en");
      await add(input, picks(10));
      const remove = view.root.findAllByProps({ className: "feedback-image-remove" })[0]!;
      await act(async () => { (remove.props.onClick as () => void)(); });
      assert.equal(thumbnails(view).length, 7);
      assert.deepEqual(truncationNotes(view), []);
      await act(async () => { view.unmount(); });
    } finally {
      restore();
    }
  });

  it("shows the failing image, not a truncation notice, when a pick fails before the cap", async () => {
    const restoreSurface = installBrowserSurface();
    const restoreDecoding = failDecoding();
    try {
      const { input, view } = await openDialog("en");
      await add(input, picks(10));
      assert.equal(thumbnails(view).length, 0);
      assert.deepEqual(truncationNotes(view), []);
      assert.deepEqual(errorLines(view), ["This image could not be read."]);
      await act(async () => { view.unmount(); });
    } finally {
      restoreDecoding();
      restoreSurface();
    }
  });
});
