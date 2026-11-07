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

import { lazy, Suspense, useMemo, useState } from "react";

import { bytesOfDataUrl } from "../app/document-payload.js";
import type { PreviewSlot } from "../app/use-workspace.js";
import { detectStructureFormat } from "../molecular.js";
import { documentKind, delimitedSeparator } from "../app/preview-kind.js";
import { highlightPython, MAX_SOURCE_CHARS } from "../app/python-source.js";
import { numericColumns, parseDelimited, type Table } from "../app/table-data.js";
import { readWorkbook } from "../app/xlsx.js";
import { Markdown } from "../Markdown.js";
import { TEXT } from "../text.js";

/** Loaded on the first structure that is opened. Mol* is an order of magnitude
 *  larger than the rest of the app together, and most sessions never show one. */
const StructureViewer = lazy(() => import("./StructureViewer.js"));

interface Props {
  expanded: boolean;
  onExpand: (next: boolean) => void;
  slot: PreviewSlot;
}

function previewName(label: string, path: string): string {
  return path === "" ? label : path;
}

/* ── source ─────────────────────────────────────────────────────────────── */

/** A Python file as the handoff draws it: a gutter of line numbers and the
 *  code beside it, coloured by what each word is. */
function PythonSource({ name, source }: { name: string; source: string }) {
  const clipped = source.length > MAX_SOURCE_CHARS;
  const text = clipped ? source.slice(0, MAX_SOURCE_CHARS) : source;
  const lines = useMemo(() => highlightPython(text), [text]);
  return (
    <div className="code-view">
      {clipped ? <p className="doc-note">{TEXT.workspace.sourceTruncated}</p> : null}
      <pre aria-label={name} className="code-block" tabIndex={0}>
        <code>
          {lines.map((tokens, index) => (
            <span className="code-line" key={index}>
              <span aria-hidden="true" className="code-line-number">{index + 1}</span>
              <span className="code-line-text">
                {tokens.map((token, at) => (token.kind === undefined
                  ? token.text
                  : <span className={`tok tok-${token.kind}`} key={at}>{token.text}</span>))}
                {"\n"}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

/* ── tables ─────────────────────────────────────────────────────────────── */

/**
 * A table read from a CSV or a worksheet.
 *
 * The row numbers are the gutter the code pages use, so the two kinds of
 * document line up when the reader switches between them, and a numeric column
 * is set flush right — a column of measurements is read by its digits.
 */
function DataTable({ table }: { table: Table }) {
  const numeric = useMemo(() => numericColumns(table.rows, table.columns.length), [table]);
  if (table.columns.length === 0) return <div className="doc-placeholder">{TEXT.workspace.tableEmpty}</div>;
  return (
    <div className="data-view">
      <div className="data-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th aria-hidden="true" className="data-gutter" />
              {table.columns.map((column, index) => (
                <th key={index}>{column.trim() === "" ? TEXT.workspace.tableColumn(index + 1) : column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <td aria-hidden="true" className="data-gutter">{rowIndex + 1}</td>
                {row.map((cell, column) => (
                  <td className={numeric[column] === true ? "is-number" : undefined} key={column} title={cell}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="data-caption">
        {table.rows.length < table.totalRows
          ? TEXT.workspace.tableRowsShown(table.rows.length, table.totalRows)
          : TEXT.workspace.tableRows(table.totalRows)}
      </p>
    </div>
  );
}

/** A workbook's first sheets, with the sheet tabs the workbook itself shows. */
function WorkbookView({ dataUrl, name }: { dataUrl: string; name: string }) {
  const sheets = useMemo(() => readWorkbook(bytesOfDataUrl(dataUrl)), [dataUrl]);
  const [active, setActive] = useState(0);
  if (sheets === undefined) return <div className="doc-placeholder">{TEXT.workspace.workbookUnreadable}</div>;
  const shown = Math.min(active, sheets.length - 1);
  const sheet = sheets[shown];
  if (sheet === undefined) return <div className="doc-placeholder">{TEXT.workspace.tableEmpty}</div>;
  return (
    <div className="data-view">
      {sheets.length > 1 ? (
        <div aria-label={`${name} ${TEXT.workspace.worksheets}`} className="sheet-tabs" role="tablist">
          {sheets.map((item, index) => (
            <button
              aria-selected={index === shown}
              className={`sheet-tab${index === shown ? " is-active" : ""}`}
              key={item.name}
              onClick={() => setActive(index)}
              role="tab"
              type="button"
            >
              {item.name}
            </button>
          ))}
        </div>
      ) : null}
      <DataTable table={sheet.table} />
    </div>
  );
}

/* ── pictures and pages ─────────────────────────────────────────────────── */

/** A picture on a neutral canvas. Clicking it swaps between the panel's width
 *  and the file's own pixels, which is how a chart is read for its labels and
 *  then for its shape. */
function ImageView({ name, src }: { name: string; src: string }) {
  const [actual, setActual] = useState(false);
  return (
    <figure className={`image-view${actual ? " is-actual" : ""}`}>
      <button
        aria-pressed={actual}
        className="image-frame"
        onClick={() => setActual((value) => !value)}
        title={actual ? TEXT.workspace.imageFit : TEXT.workspace.imageActual}
        type="button"
      >
        <img alt={TEXT.workspace.imageAlt(name)} src={src} />
      </button>
    </figure>
  );
}

/** A PDF in the browser's own viewer: a paper is read page by page, and this
 *  build has no reason to replace a viewer that prints, searches and selects. */
function PdfView({ name, src }: { name: string; src: string }) {
  return (
    <div className="pdf-view">
      <iframe src={src} title={name} />
      <p className="data-caption">
        {TEXT.workspace.pdfFallback}
        {" "}
        <a href={src} download={name}>{TEXT.workspace.download}</a>
      </p>
    </div>
  );
}

/* ── the dispatcher ─────────────────────────────────────────────────────── */

/**
 * One document, drawn as its kind is drawn.
 *
 * The kind comes from the name and the document's own media type; the content
 * arrives as text for everything that is read and as a data URL for everything
 * that is drawn. A document this build cannot draw says so rather than showing
 * the bytes it was given as if they were text.
 */
export function DocumentPreview({ expanded, onExpand, slot }: Props) {
  if (slot.loading) return <div className="doc-placeholder"><span className="spinner" /></div>;
  if (slot.error !== undefined) return <div className="panel-empty">{slot.error}</div>;

  const name = previewName(slot.label, slot.path);
  if (slot.tooLarge === true) return <div className="doc-placeholder">{TEXT.workspace.tooLarge}</div>;
  const kind = documentKind(name, slot.mediaType);
  // A container or a legacy office file this build cannot draw is not shown as
  // its bytes: the tab says there is no renderer and leaves the download.
  if (kind === "unrenderable") return <div className="doc-placeholder">{TEXT.workspace.unrenderable}</div>;
  const dataUrl = slot.dataUrl;
  if (dataUrl !== undefined) {
    if (kind === "pdf") return <PdfView name={name} src={dataUrl} />;
    if (kind === "sheet") return <WorkbookView dataUrl={dataUrl} name={name} />;
    return <ImageView name={name} src={dataUrl} />;
  }

  const content = slot.content ?? "";
  const format = detectStructureFormat({ content, name });
  if (format !== undefined) {
    return (
      <Suspense fallback={<div className="doc-placeholder"><span className="spinner" /></div>}>
        <StructureViewer content={content} expanded={expanded} format={format} name={name} onExpand={onExpand} />
      </Suspense>
    );
  }
  if (kind === "html") return <iframe className="artifact-html-frame" sandbox="allow-scripts" srcDoc={content} title={name} />;
  if (kind === "markdown") return <div className="text"><Markdown>{content}</Markdown></div>;
  if (kind === "json") {
    let pretty = content;
    try {
      pretty = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // Not JSON after all; the raw text is what the user should see.
    }
    return <pre className="tab-content-source">{pretty}</pre>;
  }
  if (content === "") return <div className="doc-placeholder">{TEXT.workspace.unsupported}</div>;
  if (kind === "csv") {
    const table = parseDelimited(content, { separator: delimitedSeparator(name) });
    if (table !== undefined) return <DataTable table={table} />;
  }
  if (kind === "python") return <PythonSource name={name} source={content} />;
  // Logs, tables and other source stay monospaced, where columns line up.
  return <pre className={`tab-content-source${kind === "prose" ? " is-prose" : ""}`}>{content}</pre>;
}
