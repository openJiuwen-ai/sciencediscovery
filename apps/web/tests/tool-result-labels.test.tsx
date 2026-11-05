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

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ToolTrace } from "@sciencediscovery/schema";

import { LocaleProvider, type Locale } from "../src/i18n/index.js";
import { ToolIoSections } from "../src/timeline/ToolIoSections.js";

const trace: ToolTrace = { args: { code: "print(1)" }, id: "t1", name: "run_python", status: "completed" };

/** The headings the card actually prints, in card order. */
function labels(html: string): string[] {
  return [...html.matchAll(/class="tool-io-label">([^<]*)</g)].map((match) => match[1] ?? "");
}

/** The accessible label of each section's copy button, which is built from the
 *  same heading — `复制Result` was the mixed-language half of the same defect. */
function copyLabels(html: string): string[] {
  return [...html.matchAll(/aria-label="([^"]*)"[^>]*class="[^"]*tool-io-copy/g)].map((match) => match[1] ?? "");
}

function render(outputText: string, locale: Locale = "zh-CN", over: Partial<ToolTrace> = {}): string {
  const page: ReactElement = createElement(
    LocaleProvider,
    { initialLocale: locale },
    createElement(ToolIoSections, { outputText, trace: { ...trace, ...over } }),
  );
  return renderToStaticMarkup(page);
}

test("USG-021 tool result headings follow the reader's locale", () => {
  // Headings minted by the parser rather than taken from the text.
  assert.deepEqual(labels(render("some raw output")), ["输入", "结果"]);
  // A labelled summary: stdout stays verbatim, the heading the runner does not
  // own is the reader's language.
  assert.deepEqual(labels(render("stdout:\nok\ncreated files: out.csv")), ["输入", "stdout", "创建的文件"]);
  assert.deepEqual(labels(render("produced artifacts: chart.png")), ["输入", "生成的文件"]);
  // A failed run says so in the same language as everything around it.
  assert.deepEqual(labels(render("boom", "zh-CN", { status: "failed" })), ["输入", "错误"]);

  // The copy button reads the heading it copies, so it cannot stay half English.
  assert.deepEqual(copyLabels(render("some raw output")), ["复制输入", "复制结果"]);
  assert.deepEqual(copyLabels(render("boom", "zh-CN", { status: "failed" })), ["复制输入", "复制错误"]);
  assert.doesNotMatch(render("some raw output"), /复制Result|复制Error/);

  // English is unchanged: the same four headings, and stderr still verbatim.
  assert.deepEqual(labels(render("some raw output", "en")), ["Input", "Result"]);
  assert.deepEqual(labels(render("created files: out.csv", "en")), ["Input", "Created files"]);
  assert.deepEqual(labels(render("produced artifacts: chart.png", "en")), ["Input", "Produced artifacts"]);
  assert.deepEqual(labels(render("stderr:\nboom", "en", { status: "failed" })), ["Input", "stderr"]);
  assert.deepEqual(copyLabels(render("some raw output", "en")), ["Copy Input", "Copy Result"]);
});
