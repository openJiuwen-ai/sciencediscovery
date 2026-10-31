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

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { detectEvolveIntent, isEvolveDesignCommand, EVOLVE_DESIGN_COMMAND } from "../src/evolve/intent.js";
import { EvolveSuggestionBar } from "../src/evolve/EvolveSuggestionBar.js";
import { LocaleProvider } from "../src/i18n/LocaleProvider.js";

test("isEvolveDesignCommand recognises only the explicit slash command", () => {
  assert.equal(isEvolveDesignCommand("/evolve-design"), true);
  assert.equal(isEvolveDesignCommand("/evolve-design make this better"), true);
  assert.equal(isEvolveDesignCommand("  /evolve-design --algorithm puct x"), true);
  assert.equal(isEvolveDesignCommand("improve the program"), false);
  assert.equal(isEvolveDesignCommand("帮我优化这个程序"), false);
  assert.equal(isEvolveDesignCommand(""), false);
});

test("the explicit /evolve-design command is always an evolve intent", () => {
  assert.equal(detectEvolveIntent(EVOLVE_DESIGN_COMMAND), true);
  assert.equal(detectEvolveIntent("/evolve-design make this better"), true);
  assert.equal(detectEvolveIntent("/evolve-design --algorithm puct optimize the model"), true);
});

test("english sentences pairing an improvement verb with a program/code target signal intent", () => {
  assert.equal(detectEvolveIntent("improve the program"), true);
  assert.equal(detectEvolveIntent("optimize this code"), true);
  assert.equal(detectEvolveIntent("make the algorithm better"), true);
  assert.equal(detectEvolveIntent("improve the scoring function"), true);
  assert.equal(detectEvolveIntent("Optimize The Script"), true);
});

test("chinese sentences pairing an improvement verb with a program/code target signal intent", () => {
  assert.equal(detectEvolveIntent("帮我优化一下这个程序"), true);
  assert.equal(detectEvolveIntent("改进这个算法"), true);
  assert.equal(detectEvolveIntent("让程序跑得更好"), true);
  assert.equal(detectEvolveIntent("提升这个模型的性能"), true);
  assert.equal(detectEvolveIntent("改进一下评分函数"), true);
  assert.equal(detectEvolveIntent("让产物 X 变得更好"), true);
  assert.equal(detectEvolveIntent("优化一个 Python 搜索算法"), true);
  assert.equal(detectEvolveIntent("改进一个实验方案"), true);
});

test("an improvement verb with no evolvable target does not signal intent", () => {
  assert.equal(detectEvolveIntent("make this better"), false);
  assert.equal(detectEvolveIntent("把这个做得更好"), false);
  assert.equal(detectEvolveIntent("this result is better than the last one"), false);
  assert.equal(detectEvolveIntent("比较一下哪个更好"), false);
  assert.equal(detectEvolveIntent("这个更好"), false);
});

test("non-evolvable targets (formatting/explanation/layout) never signal intent", () => {
  assert.equal(detectEvolveIntent("improve the description"), false);
  assert.equal(detectEvolveIntent("优化一下界面布局"), false);
  assert.equal(detectEvolveIntent("改进一下说明文字"), false);
  assert.equal(detectEvolveIntent("improve the workflow steps"), false);
  assert.equal(detectEvolveIntent("make this better explained"), false);
  assert.equal(detectEvolveIntent("改一下格式"), false);
  assert.equal(detectEvolveIntent("解释得更好"), false);
});

test("ordinary conversation never signals evolve intent", () => {
  assert.equal(detectEvolveIntent(""), false);
  assert.equal(detectEvolveIntent("what is a protein"), false);
  assert.equal(detectEvolveIntent("explain the results"), false);
  assert.equal(detectEvolveIntent("the first one is better"), false);
});

test("short negation/target words do not fire inside longer English words", () => {
  // Word-boundary negation regression: "format" inside "information" must not
  // negate a real evolvable target ("model"), so this stays true.
  assert.equal(detectEvolveIntent("improve the information model"), true);
  // The real ui-in-building regression: "ui" inside "building" must not negate,
  // and "model" is the evolvable target, so this is true.
  assert.equal(detectEvolveIntent("optimize this model for building"), true);
  // These are false because "building"/"circuit"/"build" are NOT evolvable
  // targets (they are not in EVOLVABLE_TARGETS) — not because "ui" negates.
  assert.equal(detectEvolveIntent("improve the building design"), false);
  assert.equal(detectEvolveIntent("improve this circuit"), false);
  assert.equal(detectEvolveIntent("improve the build"), false);
  // "code" inside "barcode"/"decoder" must not count as a code target.
  assert.equal(detectEvolveIntent("improve the barcode"), false);
  assert.equal(detectEvolveIntent("improve the decoder"), false);
});

test("english result matches chinese 结果 for evolve targets", () => {
  assert.equal(detectEvolveIntent("improve this result"), true);
  assert.equal(detectEvolveIntent("优化一下这个结果"), true);
});

test("deficiency complaints paired with an evolvable target signal intent", () => {
  // Users rarely type an improve verb; they complain about how something is.
  assert.equal(detectEvolveIntent("这个程序跑得太慢了"), true);
  assert.equal(detectEvolveIntent("这个结果不太准"), true);
  assert.equal(detectEvolveIntent("这个模型效果不好"), true);
  assert.equal(detectEvolveIntent("the model is too slow"), true);
});

test("deficiency or improve intent still needs an evolvable target", () => {
  // "太慢" / "faster" / "crashes" alone, without naming a program/code/model,
  // stays silent; the agent understands the omitted target from context
  // (Layer 2), the frontend keyword gate does not.
  assert.equal(detectEvolveIntent("make it faster"), false);
  assert.equal(detectEvolveIntent("this crashes sometimes"), false);
  assert.equal(detectEvolveIntent("帮我改快一点"), false);
  assert.equal(detectEvolveIntent("这段代码有 bug"), false);
  assert.equal(detectEvolveIntent("can you tune this"), false);
  assert.equal(detectEvolveIntent("解释一下这个程序"), false);
});

test("isEvolveDesignCommand requires the command name to end at a boundary", () => {
  assert.equal(isEvolveDesignCommand("/evolve-designXXX"), false);
  assert.equal(isEvolveDesignCommand("/evolve-design"), true);
  assert.equal(isEvolveDesignCommand("/evolve-design make this better"), true);
});

test("EvolveSuggestionBar renders the confirmation prompt and accept/dismiss actions", () => {
  const html = renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: "zh-CN" },
    createElement(EvolveSuggestionBar, { onAccept: () => undefined, onDismiss: () => undefined })));

  assert.match(html, /class="evolve-suggestion-bar"/);
  assert.match(html, /看起来你想改进某个结果或程序/);
  assert.match(html, /运行演进搜索/);
  assert.match(html, /关闭建议/);
});
