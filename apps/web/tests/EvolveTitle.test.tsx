import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import { evolveShortTitle } from "../src/evolve/model.js";

const HUAWEI_BRIEF = "任务：把工作区的 huawei_intro.md 重写成一篇更好的华为公司介绍。 目标读者：对中国科技产业有基本了解的普通读者。读完应清楚知道华为强在哪些方面、强到什么程度。 硬性约束（不要违反）： 1. 中文，连贯成文，可分 2–4 段；不要写成要点清单或语录堆叠。 2. 长度 500–800 个汉字（当前版本约 207 字，明显偏短）。";

test("a long brief becomes its first sentence, without the 任务： label", () => {
  assert.equal(evolveShortTitle(HUAWEI_BRIEF), "把工作区的 huawei_intro.md 重写成一篇更好的华为公司介绍");
});

test("a short statement is returned as written", () => {
  assert.equal(evolveShortTitle("Make the sort faster"), "Make the sort faster");
  assert.equal(evolveShortTitle("  降低验证误差  "), "降低验证误差");
});

test("a very long single sentence is cut at a fixed width with an ellipsis", () => {
  const cut = evolveShortTitle("把".repeat(200));
  assert.equal(cut, `${"把".repeat(32)}…`);
  const latin = evolveShortTitle(`Optimise ${"x".repeat(200)}`);
  assert.ok(latin.endsWith("…") && latin.length <= 65, latin);
});

test("newlines collapse, an English label is dropped, and a filename dot does not end the title", () => {
  assert.equal(evolveShortTitle("Task:\nspeed up   parse_csv.py by caching.\nMore detail follows."), "speed up parse_csv.py by caching");
  assert.equal(evolveShortTitle("任务：。"), "任务：。");
  assert.equal(evolveShortTitle(""), "");
});
