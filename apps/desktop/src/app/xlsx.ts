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

/**
 * A workbook read far enough to draw its first sheets as tables.
 *
 * An .xlsx is a zip of XML, and the panel needs three of its parts: the sheet
 * list, the shared string table, and each sheet's rows. Parsing that is what
 * `fflate` and a few regular expressions are for — the files are machine-written
 * and their shape is fixed — and a workbook that does not answer to them is
 * reported as unreadable rather than half-drawn. Nothing here touches the DOM,
 * so the reader is tested against a workbook built in memory.
 */

import { unzipSync } from "fflate";

import { CELL_MAX_CHARS, TABLE_MAX_COLUMNS, TABLE_MAX_ROWS, type Table } from "./table-data.js";

export interface Worksheet {
  name: string;
  table: Table;
}

/** The sheets the panel will read. A workbook's later sheets are still one
 *  download away, and each one read is a whole XML part decoded. */
export const MAX_WORKSHEETS = 8;

const ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: "\"",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/gu, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    if (name.startsWith("#")) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return ENTITIES[name] ?? whole;
  });
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "u").exec(attributes);
  return match?.[1] === undefined ? undefined : decodeEntities(match[1]);
}

/** The text inside an `<si>` or `<is>`: rich text holds one `<t>` per run. */
function textRuns(xml: string): string {
  let text = "";
  for (const match of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)) text += decodeEntities(match[1]!);
  return text;
}

function readSharedStrings(part: Uint8Array | undefined): string[] {
  if (part === undefined) return [];
  const xml = new TextDecoder().decode(part);
  const strings: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gu)) strings.push(textRuns(match[1]!));
  return strings;
}

interface SheetRef {
  name: string;
  relationship: string;
}

function readSheetRefs(part: Uint8Array | undefined): SheetRef[] {
  if (part === undefined) return [];
  const xml = new TextDecoder().decode(part);
  const refs: SheetRef[] = [];
  for (const match of xml.matchAll(/<sheet\b([^>]*?)\/?>/gu)) {
    const attributes = match[1]!;
    const name = attribute(attributes, "name");
    const relationship = attribute(attributes, "r:id") ?? attribute(attributes, "id");
    if (name !== undefined && relationship !== undefined) refs.push({ name, relationship });
  }
  return refs;
}

/** The part each relationship points at, resolved against the `xl/` folder the
 *  workbook lives in. */
function readRelationships(part: Uint8Array | undefined): Map<string, string> {
  const targets = new Map<string, string>();
  if (part === undefined) return targets;
  const xml = new TextDecoder().decode(part);
  for (const match of xml.matchAll(/<Relationship\b([^>]*?)\/?>/gu)) {
    const attributes = match[1]!;
    const id = attribute(attributes, "Id");
    const target = attribute(attributes, "Target");
    if (id === undefined || target === undefined) continue;
    targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  return targets;
}

function columnIndex(reference: string): number {
  let index = 0;
  for (const character of reference) {
    const code = character.toUpperCase().charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return Math.max(index - 1, 0);
}

/** The built-in number formats Excel reserves for dates and times. */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

interface DateStyles {
  /** Whether cell style `index` is a date, by the format it names. */
  isDate: (index: number) => boolean;
}

/**
 * Which cell styles print a number as a date. A date in an .xlsx is a serial
 * number plus a format, and without this a sheet of measurements written on
 * dates would show `45292` where the sheet showed `2024-01-01`.
 */
function readDateStyles(part: Uint8Array | undefined): DateStyles {
  if (part === undefined) return { isDate: () => false };
  const xml = new TextDecoder().decode(part);
  const custom = new Map<number, string>();
  for (const match of xml.matchAll(/<numFmt\b([^>]*?)\/?>/gu)) {
    const attributes = match[1]!;
    const id = Number(attribute(attributes, "numFmtId"));
    const code = attribute(attributes, "formatCode") ?? "";
    if (Number.isFinite(id)) custom.set(id, code);
  }
  const formats: number[] = [];
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/u.exec(xml)?.[1];
  if (cellXfs !== undefined) {
    for (const match of cellXfs.matchAll(/<xf\b([^>]*?)\/?>/gu)) {
      formats.push(Number(attribute(match[1]!, "numFmtId") ?? "0"));
    }
  }
  const isDateFormat = (formatId: number): boolean => {
    if (DATE_FORMAT_IDS.has(formatId)) return true;
    const code = custom.get(formatId);
    // A date format shows at least one of y/m/d/h/s outside its quoted text and
    // its colour/index escapes; `0.00` and `#,##0` show none of them.
    return code !== undefined && /[ymdhs]/iu.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./gu, ""));
  };
  return {
    isDate: (index: number) => {
      const formatId = formats[index];
      return formatId !== undefined && isDateFormat(formatId);
    },
  };
}

const SERIAL_EPOCH_1900 = Date.UTC(1899, 11, 30);
// Excel's 1900 system counts from 1899-12-30 only past its phantom leap day
// (serial 60). Serials 1-59 are one day later than that epoch would suggest.
const SERIAL_EPOCH_1900_BEFORE_MARCH = Date.UTC(1899, 11, 31);
const SERIAL_EPOCH_1904 = Date.UTC(1904, 0, 1);

function serialToText(serial: number, epoch: number): string {
  const milliseconds = Math.round(serial * 86_400_000);
  const countedFrom = epoch === SERIAL_EPOCH_1900 && serial < 61 ? SERIAL_EPOCH_1900_BEFORE_MARCH : epoch;
  const date = new Date(countedFrom + milliseconds);
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const seconds = date.getUTCSeconds();
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}${seconds === 0 ? "" : `:${pad(seconds)}`}`;
  // A serial below one is a time of day with no date: Excel writes 0.5 for noon.
  if (serial < 1) return time;
  if (serial === Math.floor(serial)) return day;
  return `${day} ${time}`;
}

interface SheetOptions {
  date1904: boolean;
  dates: DateStyles;
  shared: string[];
}

function cellText(attributes: string, inner: string | undefined, options: SheetOptions): string {
  if (inner === undefined) return "";
  const type = attribute(attributes, "t") ?? "n";
  if (type === "inlineStr") {
    const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/u.exec(inner)?.[1];
    return inline === undefined ? "" : textRuns(inline);
  }
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/u.exec(inner)?.[1];
  if (raw === undefined) return "";
  const value = decodeEntities(raw);
  if (type === "s") {
    const shared = options.shared[Number(value)];
    return shared ?? "";
  }
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  if (type === "str" || type === "e") return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const style = Number(attribute(attributes, "s") ?? "-1");
  if (style >= 0 && options.dates.isDate(style)) {
    return serialToText(number, options.date1904 ? SERIAL_EPOCH_1904 : SERIAL_EPOCH_1900);
  }
  return value;
}

function readSheet(part: Uint8Array, options: SheetOptions): { rows: string[][]; total: number } {
  const xml = new TextDecoder().decode(part);
  const rows: string[][] = [];
  let total = 0;
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gu)) {
    total += 1;
    // The header plus `TABLE_MAX_ROWS` rows are what the panel holds; the rest
    // are still counted, so the caption can say how many exist.
    if (rows.length > TABLE_MAX_ROWS) continue;
    const inner = rowMatch[2];
    if (inner === undefined) continue;
    const cells: string[] = [];
    for (const cellMatch of inner.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const attributes = cellMatch[1]!;
      const reference = attribute(attributes, "r");
      const column = reference === undefined ? cells.length : columnIndex(reference);
      if (column >= TABLE_MAX_COLUMNS) continue;
      while (cells.length < column) cells.push("");
      cells[column] = cellText(attributes, cellMatch[2], options).slice(0, CELL_MAX_CHARS);
    }
    rows.push(cells);
  }
  return { rows, total };
}

/** Rows as the table model: the first row is the header, the rest are data. */
function toTable(rows: readonly string[][], total: number): Table | undefined {
  const header = rows[0];
  if (header === undefined) return undefined;
  let width = header.length;
  for (const row of rows) width = Math.max(width, row.length);
  const pad = (row: readonly string[]) => Array.from({ length: width }, (_, column) => row[column] ?? "");
  return {
    columns: pad(header),
    rows: rows.slice(1).map(pad),
    totalRows: Math.max(total - 1, 0),
    truncated: total > rows.length,
  };
}

/**
 * Read a workbook's sheets, in the order the workbook names them.
 *
 * `undefined` means the bytes are not a workbook this reader understands —
 * encrypted, or a format that only looks like one — and the panel then says so
 * rather than showing an empty sheet.
 */
export function readWorkbook(bytes: Uint8Array): Worksheet[] | undefined {
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch {
    return undefined;
  }
  const workbookXml = archive["xl/workbook.xml"];
  if (workbookXml === undefined) return undefined;

  const shared = readSharedStrings(archive["xl/sharedStrings.xml"]);
  const relationships = readRelationships(archive["xl/_rels/workbook.xml.rels"]);
  const dates = readDateStyles(archive["xl/styles.xml"]);
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/u.test(new TextDecoder().decode(workbookXml));
  const options: SheetOptions = { date1904, dates, shared };

  const sheets: Worksheet[] = [];
  for (const [order, ref] of readSheetRefs(workbookXml).entries()) {
    if (sheets.length >= MAX_WORKSHEETS) break;
    const path = relationships.get(ref.relationship) ?? `xl/worksheets/sheet${order + 1}.xml`;
    const part = archive[path];
    if (part === undefined) continue;
    const { rows, total } = readSheet(part, options);
    const table = toTable(rows, total);
    if (table !== undefined) sheets.push({ name: ref.name, table });
  }
  return sheets.length === 0 ? undefined : sheets;
}
