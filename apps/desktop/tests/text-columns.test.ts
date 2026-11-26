// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";

import { TITLE_COLUMNS, columnsOf, truncateColumns } from "../src/text/columns.js";

test("one title budget is shared, and a CJK character is two columns wide", () => {
  assert.equal(TITLE_COLUMNS, 64);
  assert.equal(columnsOf("膜"), 2);
  assert.equal(columnsOf("a"), 1);
  assert.equal(columnsOf(" "), 1);
});

test("text that fits the column budget is returned unchanged, with no cut mark", () => {
  assert.equal(truncateColumns("short title", TITLE_COLUMNS), "short title");
  const latin = "a".repeat(TITLE_COLUMNS);
  assert.equal(truncateColumns(latin, TITLE_COLUMNS), latin, "exactly at the budget is not a cut");
  const wide = "这".repeat(TITLE_COLUMNS / 2);
  assert.equal(truncateColumns(wide, TITLE_COLUMNS), wide, "exactly at the budget in CJK columns too");
});

test("one column over the budget is cut and the cut is marked", () => {
  const wide = "这".repeat(TITLE_COLUMNS / 2 + 1);
  const cut = truncateColumns(wide, TITLE_COLUMNS);
  assert.equal(cut.endsWith("…"), true);
  assert.equal(cut.slice(0, -1), "这".repeat(TITLE_COLUMNS / 2), "the whole characters that fit are kept");
  assert.equal(truncateColumns("a".repeat(TITLE_COLUMNS + 1), TITLE_COLUMNS), `${"a".repeat(TITLE_COLUMNS)}…`);
});

test("the marker sits against the last glyph, not after the space it replaced", () => {
  const text = `${"a".repeat(TITLE_COLUMNS - 1)} b`;
  assert.equal(truncateColumns(text, TITLE_COLUMNS), `${"a".repeat(TITLE_COLUMNS - 1)}…`);
});
