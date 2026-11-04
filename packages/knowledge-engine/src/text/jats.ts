// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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
 * JATS (Journal Article Tag Suite) XML → markdown converter.
 *
 * EuropePMC serves structured full text for its OA subset — strictly better
 * than any PDF parser (real sections, formulas, citation anchors, zero
 * OCR/layout noise). This is the no-docling decision's key text path for
 * biomedical documents.
 *
 * Scope (W1): title/abstract/recursive sections/paragraphs, display+inline
 * formulas (LaTeX preserved), bibliography xref anchors ([@rid] form, the
 * same anchor convention the DeepAnalyze latex-processor produced), figure
 * captions, table-wraps as flattened text. Dependencies: none (a small
 * purpose-built XML tokenizer — JATS from EuropePMC is well-formed).
 */

interface XmlNode {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly children: Array<XmlNode | string>;
}

/** Minimal XML tokenizer/parser for well-formed JATS. Tolerates comments,
 *  CDATA, processing instructions and the DOCTYPE prolog. Not a general XML
 *  parser — sufficient for EuropePMC fullTextXML responses. */
export function parseXml(xml: string): XmlNode | null {
  let index = 0;
  const length = xml.length;

  function skipMisc(): void {
    for (;;) {
      while (index < length && /\s/.test(xml[index]!)) index += 1;
      if (xml.startsWith("<!--", index)) {
        const end = xml.indexOf("-->", index);
        index = end === -1 ? length : end + 3;
      } else if (xml.startsWith("<!", index) || xml.startsWith("<?", index)) {
        const end = xml.indexOf(">", index);
        index = end === -1 ? length : end + 1;
      } else {
        return;
      }
    }
  }

  function parseAttrs(): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (;;) {
      while (index < length && /\s/.test(xml[index]!)) index += 1;
      const nameMatch = /^[a-zA-Z_][\w:.-]*/.exec(xml.slice(index));
      if (!nameMatch) return attrs;
      index += nameMatch[0].length;
      while (index < length && /\s/.test(xml[index]!)) index += 1;
      if (xml[index] !== "=") {
        attrs[nameMatch[0]] = "";
        continue;
      }
      index += 1;
      while (index < length && /\s/.test(xml[index]!)) index += 1;
      const quote = xml[index];
      if (quote === '"' || quote === "'") {
        const end = xml.indexOf(quote, index + 1);
        attrs[nameMatch[0]] = decodeXmlEntities(xml.slice(index + 1, end === -1 ? length : end));
        index = end === -1 ? length : end + 1;
      }
    }
  }

  function parseElement(): XmlNode | null {
    if (xml[index] !== "<") return null;
    index += 1;
    const nameMatch = /^[a-zA-Z_][\w:.-]*/.exec(xml.slice(index));
    if (!nameMatch) return null;
    const tag = nameMatch[0];
    index += tag.length;
    const attrs = parseAttrs();
    while (index < length && /\s/.test(xml[index]!)) index += 1;
    if (xml.startsWith("/>", index)) {
      index += 2;
      return { tag, attrs, children: [] };
    }
    if (xml[index] !== ">") return null;
    index += 1;
    const children: Array<XmlNode | string> = [];
    for (;;) {
      if (index >= length) break;
      if (xml.startsWith(`</${tag}`, index)) {
        const end = xml.indexOf(">", index);
        index = end === -1 ? length : end + 1;
        break;
      }
      if (xml.startsWith("<![CDATA[", index)) {
        const end = xml.indexOf("]]>", index);
        children.push(xml.slice(index + 9, end === -1 ? length : end));
        index = end === -1 ? length : end + 3;
        continue;
      }
      if (xml.startsWith("<!--", index)) {
        const end = xml.indexOf("-->", index);
        index = end === -1 ? length : end + 3;
        continue;
      }
      if (xml[index] === "<") {
        const child = parseElement();
        if (!child) break;
        children.push(child);
        continue;
      }
      const next = xml.indexOf("<", index);
      const text = xml.slice(index, next === -1 ? length : next);
      children.push(decodeXmlEntities(text));
      index = next === -1 ? length : next;
    }
    return { tag, attrs, children };
  }

  skipMisc();
  return parseElement();
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

/** fromCodePoint throws RangeError on out-of-range input — a malformed JATS
 *  numeric entity must degrade, never crash the conversion. */
function safeCodePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) {
    return "�";
  }
  try {
    return String.fromCodePoint(value);
  } catch {
    return "�";
  }
}

// ---------------------------------------------------------------------------

function textContent(node: XmlNode | string): string {
  if (typeof node === "string") return node;
  return node.children.map(textContent).join("");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function childElements(node: XmlNode, tag: string): XmlNode[] {
  return node.children.filter((child): child is XmlNode => typeof child !== "string" && child.tag === tag);
}

function firstChild(node: XmlNode, tag: string): XmlNode | undefined {
  return childElements(node, tag)[0];
}

/** Extract LaTeX from a formula element (<disp-formula>/<inline-formula>). */
function formulaLatex(node: XmlNode): string | null {
  const texMath = firstChild(node, "tex-math");
  if (texMath) {
    const latex = textContent(texMath).trim();
    return latex.length > 0 ? latex : null;
  }
  const raw = textContent(node).trim();
  return raw.length > 0 ? raw : null;
}

/**
 * Render inline content of a paragraph-ish element to markdown, converting
 * inline formulas and bibliography xrefs along the way.
 */
function renderInline(node: XmlNode | string): string {
  if (typeof node === "string") return node;
  if (node.tag === "inline-formula") {
    const latex = formulaLatex(node);
    return latex ? `$${latex}$` : "";
  }
  if (node.tag === "xref") {
    const refType = node.attrs["ref-type"] ?? "";
    const rid = node.attrs["rid"] ?? "";
    if (refType === "bibr" && rid) {
      // The DeepAnalyze citation anchor convention: [@key] in text.
      return `[@${rid}]`;
    }
    const label = normalizeWhitespace(textContent(node));
    return label.length > 0 ? label : "";
  }
  if (node.tag === "italic" || node.tag === "em" || node.tag === "i") {
    return `*${node.children.map(renderInline).join("")}*`;
  }
  if (node.tag === "bold" || node.tag === "b") {
    return `**${node.children.map(renderInline).join("")}**`;
  }
  if (node.tag === "sub" || node.tag === "sup" || node.tag === "span") {
    return node.children.map(renderInline).join("");
  }
  return node.children.map(renderInline).join("");
}

function renderSection(sec: XmlNode, depth: number, out: string[]): void {
  const titleNode = firstChild(sec, "title");
  if (titleNode) {
    const title = normalizeWhitespace(titleNode.children.map(renderInline).join(""));
    if (title.length > 0) {
      out.push(`${"#".repeat(Math.min(depth + 2, 6))} ${title}`);
      out.push("");
    }
  }
  for (const child of sec.children) {
    if (typeof child === "string") continue;
    if (child.tag === "title") continue;
    renderBlock(child, depth, out);
  }
}

function renderBlock(node: XmlNode, depth: number, out: string[]): void {
  switch (node.tag) {
    case "p": {
      const text = normalizeWhitespace(node.children.map(renderInline).join(""));
      if (text.length > 0) {
        out.push(text);
        out.push("");
      }
      return;
    }
    case "sec": {
      renderSection(node, depth + 1, out);
      return;
    }
    case "disp-formula": {
      const latex = formulaLatex(node);
      if (latex) {
        out.push(`$$\n${latex}\n$$`);
        out.push("");
      }
      return;
    }
    case "fig":
    case "fig-group": {
      const caption = firstChild(node, "caption");
      const captionText = caption ? normalizeWhitespace(caption.children.map(renderInline).join("")) : "";
      if (captionText.length > 0) {
        out.push(`[Figure] ${captionText}`);
        out.push("");
      }
      return;
    }
    case "table-wrap": {
      const label = firstChild(node, "label");
      const caption = firstChild(node, "caption");
      const labelText = label ? normalizeWhitespace(textContent(label)) : "Table";
      const captionText = caption ? normalizeWhitespace(caption.children.map(renderInline).join("")) : "";
      const table = firstChild(node, "table");
      if (table) {
        out.push(`[${labelText}] ${captionText}`.trim());
        out.push(flattenTable(table));
        out.push("");
      } else if (captionText.length > 0) {
        out.push(`[${labelText}] ${captionText}`);
        out.push("");
      }
      return;
    }
    case "list": {
      for (const item of childElements(node, "list-item")) {
        const text = normalizeWhitespace(item.children.map(renderInline).join(""));
        if (text.length > 0) {
          out.push(`- ${text}`);
        }
      }
      out.push("");
      return;
    }
    default: {
      // Unknown block: recurse so nested known blocks are not lost.
      for (const child of node.children) {
        if (typeof child !== "string") {
          renderBlock(child, depth, out);
        }
      }
    }
  }
}

/** Flatten a JATS <table> to pipe-separated rows (header + body). */
function flattenTable(table: XmlNode): string {
  const rows: string[] = [];
  for (const section of table.children) {
    if (typeof section === "string") continue;
    if (section.tag !== "thead" && section.tag !== "tbody") continue;
    for (const row of childElements(section, "tr")) {
      const cells = row.children
        .filter((cell): cell is XmlNode => typeof cell !== "string" && (cell.tag === "th" || cell.tag === "td"))
        .map((cell) => normalizeWhitespace(cell.children.map(renderInline).join("")));
      if (cells.length > 0) {
        rows.push(`| ${cells.join(" | ")} |`);
      }
    }
  }
  return rows.join("\n");
}

export interface JatsConversionResult {
  readonly markdown: string;
  readonly title: string | null;
  readonly referenceCount: number;
}

/** Convert a EuropePMC fullTextXML payload to markdown. */
export function jatsToMarkdown(xml: string): JatsConversionResult {
  const root = parseXml(xml);
  if (!root || root.tag !== "article") {
    return { markdown: "", title: null, referenceCount: 0 };
  }
  const out: string[] = [];
  let title: string | null = null;
  let referenceCount = 0;

  const front = firstChild(root, "front");
  const articleMeta = front ? firstChild(front, "article-meta") : undefined;
  if (articleMeta) {
    const titleGroup = firstChild(articleMeta, "title-group");
    const titleNode = titleGroup ? firstChild(titleGroup, "article-title") : undefined;
    if (titleNode) {
      title = normalizeWhitespace(titleNode.children.map(renderInline).join(""));
      if (title.length > 0) {
        out.push(`# ${title}`);
        out.push("");
      }
    }
    const abstractNode = firstChild(articleMeta, "abstract");
    if (abstractNode) {
      out.push("## Abstract");
      out.push("");
      for (const child of abstractNode.children) {
        if (typeof child !== "string") {
          renderBlock(child, 0, out);
        }
      }
    }
  }

  const body = firstChild(root, "body");
  if (body) {
    for (const child of body.children) {
      if (typeof child !== "string") {
        renderBlock(child, 0, out);
      }
    }
  }

  const back = firstChild(root, "back");
  const refList = back ? firstChild(back, "ref-list") : undefined;
  if (refList) {
    const refs = childElements(refList, "ref");
    referenceCount = refs.length;
    out.push("## References");
    out.push("");
    for (const ref of refs) {
      const id = ref.attrs["id"] ?? "";
      const text = normalizeWhitespace(ref.children.map(renderInline).join(""));
      if (text.length > 0) {
        out.push(`- [${id}] ${text}`);
      }
    }
    out.push("");
  }

  // Collapse 3+ blank lines, trim trailing whitespace.
  const markdown = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { markdown, title, referenceCount };
}
