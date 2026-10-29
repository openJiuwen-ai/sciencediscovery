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
import { strToU8, zipSync } from "fflate";

import { TABLE_MAX_ROWS } from "../src/app/table-data.js";
import { MAX_WORKSHEETS, readWorkbook } from "../src/app/xlsx.js";

/** A workbook is a zip of parts; the reader only looks at the ones a fixture
 *  names, so a spec builds exactly those. */
function workbook(parts: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, xml] of Object.entries(parts)) entries[path] = strToU8(xml);
  return zipSync(entries);
}

const WORKBOOK = (sheets: string): string =>
  `<workbook><sheets>${sheets}</sheets></workbook>`;

const RELS = (targets: Array<[string, string]>): string =>
  `<Relationships>${targets
    .map(([id, target]) => `<Relationship Id="${id}" Target="${target}"/>`)
    .join("")}</Relationships>`;

const SHEET = (rows: string): string => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;

test("sheets come in the workbook's order, with its names", () => {
  const sheets = readWorkbook(workbook({
    "xl/_rels/workbook.xml.rels": RELS([["rId1", "worksheets/first.xml"], ["rId2", "worksheets/second.xml"]]),
    "xl/workbook.xml": WORKBOOK(
      "<sheet name=\"测量\" r:id=\"rId1\"/><sheet name=\"汇总\" r:id=\"rId2\"/>",
    ),
    "xl/worksheets/first.xml": SHEET(
      "<row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>样品</t></is></c></row>"
      + "<row r=\"2\"><c r=\"A2\" t=\"inlineStr\"><is><t>A</t></is></c></row>",
    ),
    "xl/worksheets/second.xml": SHEET(
      "<row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>合计</t></is></c></row>",
    ),
  }));
  assert.deepEqual(sheets?.map((sheet) => sheet.name), ["测量", "汇总"]);
  assert.deepEqual(sheets?.[0]?.table.columns, ["样品"]);
  assert.deepEqual(sheets?.[0]?.table.rows, [["A"]]);
});

test("a shared string, an inline string, a boolean and a number all read", () => {
  const [sheet] = readWorkbook(workbook({
    "xl/sharedStrings.xml": "<sst><si><t>样品</t></si><si><t>强度</t></si></sst>",
    "xl/workbook.xml": WORKBOOK("<sheet name=\"表1\" r:id=\"rId1\"/>"),
    "xl/_rels/workbook.xml.rels": RELS([["rId1", "worksheets/sheet1.xml"]]),
    "xl/worksheets/sheet1.xml": SHEET(
      "<row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>1</v></c><c r=\"C1\" t=\"b\"><v>1</v></c></row>"
      + "<row r=\"2\"><c r=\"A2\" t=\"inlineStr\"><is><t>A</t></is></c><c r=\"C2\"><v>12.5</v></c></row>",
    ),
  })) ?? [];
  assert.deepEqual(sheet?.table.columns, ["样品", "强度", "TRUE"]);
  assert.deepEqual(sheet?.table.rows, [["A", "", "12.5"]]);
});

test("a cell with no reference still lands in the column it was written in", () => {
  const [sheet] = readWorkbook(workbook({
    "xl/workbook.xml": WORKBOOK("<sheet name=\"表1\" r:id=\"rId1\"/>"),
    "xl/_rels/workbook.xml.rels": RELS([["rId1", "worksheets/sheet1.xml"]]),
    "xl/worksheets/sheet1.xml": SHEET(
      "<row><c t=\"inlineStr\"><is><t>a</t></is></c><c t=\"inlineStr\"><is><t>b</t></is></c></row>"
      + "<row><c t=\"inlineStr\"><is><t>1</t></is></c><c t=\"inlineStr\"><is><t>2</t></is></c></row>",
    ),
  })) ?? [];
  assert.deepEqual(sheet?.table.columns, ["a", "b"]);
  assert.deepEqual(sheet?.table.rows, [["1", "2"]]);
});

test("a date format turns its serial back into a date, built-in or custom", () => {
  const [sheet] = readWorkbook(workbook({
    "xl/styles.xml": "<styleSheet><numFmts>"
      + "<numFmt numFmtId=\"164\" formatCode=\"yyyy-mm-dd\"/></numFmts>"
      + "<cellXfs><xf numFmtId=\"0\"/><xf numFmtId=\"14\"/><xf numFmtId=\"164\"/></cellXfs></styleSheet>",
    "xl/workbook.xml": WORKBOOK("<sheet name=\"表1\" r:id=\"rId1\"/>"),
    "xl/_rels/workbook.xml.rels": RELS([["rId1", "worksheets/sheet1.xml"]]),
    "xl/worksheets/sheet1.xml": SHEET(
      "<row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>日期</t></is></c>"
      + "<c r=\"B1\" t=\"inlineStr\"><is><t>自定义</t></is></c><c r=\"C1\" t=\"inlineStr\"><is><t>数值</t></is></c></row>"
      + "<row r=\"2\"><c r=\"A2\" s=\"1\"><v>45292</v></c><c r=\"B2\" s=\"2\"><v>45292</v></c><c r=\"C2\" s=\"0\"><v>45292</v></c></row>",
    ),
  })) ?? [];
  assert.deepEqual(sheet?.table.rows, [["2024-01-01", "2024-01-01", "45292"]]);
});

test("without a relationship the sheet falls back to its position in the file", () => {
  const [sheet] = readWorkbook(workbook({
    "xl/workbook.xml": WORKBOOK("<sheet name=\"表1\" r:id=\"rId9\"/>"),
    "xl/worksheets/sheet1.xml": SHEET(
      "<row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>a</t></is></c></row>",
    ),
  })) ?? [];
  assert.deepEqual(sheet?.table.columns, ["a"]);
});

test("a worksheet with no rows is not a sheet the panel can draw", () => {
  assert.equal(readWorkbook(workbook({
    "xl/workbook.xml": WORKBOOK("<sheet name=\"空\" r:id=\"rId1\"/>"),
    "xl/_rels/workbook.xml.rels": RELS([["rId1", "worksheets/sheet1.xml"]]),
    "xl/worksheets/sheet1.xml": SHEET(""),
  })), undefined);
});

test("a workbook holds the header and the row cap, and the caption still counts them all", () => {
  const rows = ["<row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>n</t></is></c></row>"];
  for (let index = 1; index <= TABLE_MAX_ROWS + 5; index += 1) {
    rows.push(`<row r="${index + 1}"><c r="A${index + 1}"><v>${index}</v></c></row>`);
  }
  const [sheet] = readWorkbook(workbook({
    "xl/workbook.xml": WORKBOOK("<sheet name=\"表1\" r:id=\"rId1\"/>"),
    "xl/_rels/workbook.xml.rels": RELS([["rId1", "worksheets/sheet1.xml"]]),
    "xl/worksheets/sheet1.xml": SHEET(rows.join("")),
  })) ?? [];
  assert.equal(sheet?.table.rows.length, TABLE_MAX_ROWS);
  assert.equal(sheet?.table.totalRows, TABLE_MAX_ROWS + 5);
  assert.equal(sheet?.table.truncated, true);
});

test("only the first sheets of a large workbook are read", () => {
  const refs: string[] = [];
  const targets: Array<[string, string]> = [];
  const parts: Record<string, string> = {};
  for (let index = 0; index < MAX_WORKSHEETS + 2; index += 1) {
    refs.push(`<sheet name="表${index}" r:id="rId${index}"/>`);
    targets.push([`rId${index}`, `worksheets/sheet${index}.xml`]);
    parts[`xl/worksheets/sheet${index}.xml`] = SHEET(
      `<row r="1"><c r="A1" t="inlineStr"><is><t>${index}</t></is></c></row>`,
    );
  }
  const sheets = readWorkbook(workbook({
    ...parts,
    "xl/_rels/workbook.xml.rels": RELS(targets),
    "xl/workbook.xml": WORKBOOK(refs.join("")),
  }));
  assert.equal(sheets?.length, MAX_WORKSHEETS);
});

test("bytes that are not a workbook are reported, not guessed at", () => {
  assert.equal(readWorkbook(strToU8("not a zip")), undefined);
  assert.equal(readWorkbook(new Uint8Array()), undefined);
  assert.equal(readWorkbook(workbook({ "xl/other.xml": "<x/>" })), undefined, "a zip without a workbook part");
});

test("a 1900 date serial before March reads as the day Excel shows", () => {
  const [sheet] = readWorkbook(workbook({
    "xl/styles.xml": "<styleSheet><numFmts></numFmts><cellXfs><xf numFmtId=\"14\"/></cellXfs></styleSheet>",
    "xl/workbook.xml": WORKBOOK("<sheet name=\"Sheet1\" r:id=\"rId1\"/>"),
    "xl/_rels/workbook.xml.rels": RELS([["rId1", "worksheets/sheet1.xml"]]),
    "xl/worksheets/sheet1.xml": SHEET(
      "<row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>一月</t></is></c>"
      + "<c r=\"B1\" t=\"inlineStr\"><is><t>二月</t></is></c><c r=\"C1\" t=\"inlineStr\"><is><t>三月</t></is></c></row>"
      + "<row r=\"2\"><c r=\"A2\" s=\"0\"><v>1</v></c><c r=\"B2\" s=\"0\"><v>59</v></c><c r=\"C2\" s=\"0\"><v>61</v></c></row>",
    ),
  })) ?? [];
  // Excel dates serial 1 at 1900-01-01; its phantom 1900-02-29 is serial 60, so
  // the 1899-12-30 epoch is only right from serial 61 on.
  assert.deepEqual(sheet?.table.rows, [["1900-01-01", "1900-02-28", "1900-03-01"]]);
});
