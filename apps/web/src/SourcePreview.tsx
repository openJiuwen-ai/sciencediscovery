// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { useMemo } from "react";
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import julia from "highlight.js/lib/languages/julia";
import latex from "highlight.js/lib/languages/latex";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

import { useLocale } from "./i18n/index.js";
import { SOURCE_PREVIEW_LIMIT, sourceLanguage } from "./source-preview.js";

const highlighter = createLowlight({ bash, c, cpp, css, go, ini, java, javascript, json, julia, latex, markdown, python, r, rust, sql, typescript, xml, yaml });
interface Token { text: string; className: string }
interface HighlightNode { type: string; value?: string; properties?: Record<string, unknown>; children?: HighlightNode[] }

function highlightLines(source: string, language: string): Token[][] {
  const lines: Token[][] = [[]];
  function visit(node: HighlightNode, classes: string[] = []): void {
    if (node.type === "text") {
      (node.value ?? "").split("\n").forEach((text, index) => {
        if (index) lines.push([]);
        if (text) lines.at(-1)!.push({ text, className: classes.join(" ") });
      });
    } else {
      const ownClasses = node.properties?.className;
      const nested = Array.isArray(ownClasses) ? [...classes, ...ownClasses.map(String)] : classes;
      node.children?.forEach((child) => visit(child, nested));
    }
  }
  // Split the syntax tree, not HTML: multiline strings keep their colour and
  // uploaded markup stays inert React text. Each logical line owns its gutter.
  try { visit(language === "plaintext" ? { type: "text", value: source } : highlighter.highlight(language, source)); }
  catch { return source.split("\n").map((text) => [{ text, className: "" }]); }
  return lines;
}

export function SourcePreview({ source, name, mediaType, language, truncated = false }: {
  source: string; name?: string; mediaType?: string; language?: string; truncated?: boolean;
}) {
  const { t } = useLocale();
  const selectedLanguage = language?.toLowerCase() ?? sourceLanguage(name, mediaType);
  const clipped = source.slice(0, SOURCE_PREVIEW_LIMIT).replace(/[\uD800-\uDBFF]$/, "");
  const visible = clipped.replace(/\r\n?/g, "\n");
  const lines = useMemo(() => highlightLines(visible, selectedLanguage), [visible, selectedLanguage]);
  return <div className="source-preview">
    {truncated || source.length > SOURCE_PREVIEW_LIMIT ? <p className="dataset-table-meta">{t("artifact.sourceTruncated")}</p> : null}
    {source.length === 0 ? <p className="artifact-empty compact">{t("artifact.textEmpty")}</p> : null}
    <pre aria-label={t("artifact.sourceAria")} className="artifact-source-preview numbered-source" data-language={selectedLanguage} tabIndex={0}>
      <code>{lines.map((tokens, index) => <span className="source-line" key={index}>
        <span aria-hidden="true" className="source-line-number">{index + 1}</span>
        <span className="source-line-text">{tokens.map((token, i) => token.className ? <span className={token.className} key={i}>{token.text}</span> : token.text)}{index < lines.length - 1 ? "\n" : ""}</span>
      </span>)}</code>
    </pre>
  </div>;
}
