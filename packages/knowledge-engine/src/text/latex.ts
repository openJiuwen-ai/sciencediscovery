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
 * W10/Z5 LaTeX-first arXiv pathway — the pure layer, ported verbatim in
 * behavior from the DeepAnalyze services (scholarly/eprint.ts tar/combine
 * logic + document-processors/latex-processor.ts TeX→Markdown). The network
 * download (mirrors, rate limiting, fixture replay) lives in the composition
 * layer on the ScholarlyTransport seam; everything here is deterministic
 * buffer/string work.
 *
 * Design (DA, kept): lossy-but-faithful — math is preserved verbatim and
 * normalized to KaTeX-compatible $$…$$/$…$; \cite{key} becomes [@key] anchors
 * (the W10 citation chain's input); sectioning becomes headings; figures/
 * tables keep captions; everything else degrades to plain text.
 */

import { gunzipSync } from "node:zlib";
import { posix } from "node:path";

// ------------------------------------------------------------ e-print unpack

export interface TarEntry {
  readonly name: string;
  readonly data: Buffer;
}

/** Unpack a gzipped e-print payload (tarball or single .tex.gz) and combine
 *  sources; null when the payload carries no usable LaTeX (PDF-only or
 *  non-TeX submissions answer 404 upstream and never get here). */
export function extractCombinedTex(gzipped: Buffer): string | null {
  let payload: Buffer;
  try {
    payload = gunzipSync(gzipped);
  } catch {
    // Some e-prints are served uncompressed.
    payload = gzipped;
  }

  // Tar archive? ("ustar" magic at offset 257)
  if (payload.length > 262 && payload.subarray(257, 262).toString("latin1") === "ustar") {
    const entries = untar(payload);
    const texFiles = entries.filter((entry) => /\.tex$/i.test(entry.name) && !entry.name.includes("/.") && !entry.name.startsWith("."));
    if (texFiles.length === 0) return null;
    return combineTexFiles(texFiles);
  }

  // Single-file source (plain .tex, possibly gzipped).
  const text = payload.toString("utf8");
  return text.includes("\\documentclass") || text.includes("\\begin{document}") ? text : null;
}

/** Minimal tar reader (ustar + GNU longname 'L' entries + prefix field). */
function untar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingLongName: string | null = null;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break; // end-of-archive zero blocks
    let name = header.subarray(0, 100).toString("latin1").replace(/\0.*$/, "");
    // ustar prefix field (offset 345, 155 bytes): prefix/name
    const prefix = header.subarray(345, 500).toString("latin1").replace(/\0.*$/, "");
    if (prefix) name = `${prefix}/${name}`;
    const sizeOctal = header.subarray(124, 136).toString("latin1").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeOctal, 8);
    const typeflag = String.fromCharCode(header[156]!);
    offset += 512;
    if (Number.isNaN(size) || size < 0 || offset + size > buf.length) break;
    const data = buf.subarray(offset, offset + size);
    if (typeflag === "L") {
      // GNU longname: this entry's data names the NEXT entry.
      pendingLongName = data.toString("latin1").replace(/\0.*$/, "");
    } else if (typeflag === "0" || typeflag === "\0") {
      entries.push({ name: pendingLongName ?? name, data });
      pendingLongName = null;
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** Pick the main file (contains \documentclass) and inline \input/\include.
 *
 *  arXiv e-prints are tarballs of .tex sources; the main file references
 *  others via \input{path}/\include{path}. LaTeX resolves these relative to
 *  the compilation root (tarball root), not the main file's directory — so
 *  a main in a subdir may \input root-relative paths. We inline recursively
 *  (depth-limited) so nested \input chains flatten into one combined source.
 *
 *  Known-hard cases handled: main mis-selected when \documentclass lives in
 *  a preamble .sty (fall back to \begin{document}, then shallowest file);
 *  \input paths with `..` (normalized); root-relative vs main-relative
 *  paths (both tried); basename fallback (subdir file referenced without
 *  path); case-insensitive match (Windows-built tarballs); nested \input. */
export function combineTexFiles(files: readonly TarEntry[]): string | null {
  const byName = new Map<string, string>();
  const byNameLower = new Map<string, string>();
  for (const file of files) {
    const name = file.name.replace(/^\.\//, "");
    const content = file.data.toString("utf8");
    byName.set(name, content);
    byNameLower.set(name.toLowerCase(), content);
  }

  // --- Main file selection: \documentclass > \begin{document} > shallowest.
  const hasDocClass = (name: string) => byName.get(name.replace(/^\.\//, ""))?.includes("\\documentclass") ?? false;
  const hasBeginDoc = (name: string) => byName.get(name.replace(/^\.\//, ""))?.includes("\\begin{document}") ?? false;
  const depth = (name: string) => (name.match(/\//g) ?? []).length;

  let mainEntry: TarEntry | undefined =
    files.find((file) => hasDocClass(file.name)) ??
    files.find((file) => hasBeginDoc(file.name));
  if (!mainEntry) {
    const sorted = [...files].sort((a, b) => depth(a.name) - depth(b.name) || a.name.localeCompare(b.name));
    mainEntry = sorted[0];
  }
  if (!mainEntry) return null;
  const mainName = mainEntry.name.replace(/^\.\//, "");
  const mainDir = mainName.includes("/") ? mainName.slice(0, mainName.lastIndexOf("/") + 1) : "";

  /** Resolve an \input/\include target: root-relative (LaTeX default) first,
   *  then main-relative (subdir-compiled tarballs), normalized (..), and
   *  basename; case-insensitive fallback last (Windows-built tarballs). */
  const resolveInclude = (rawName: string): string | undefined => {
    const clean = rawName.replace(/^\.\//, "").trim();
    const withExt = clean.endsWith(".tex") ? clean : `${clean}.tex`;
    const basename = withExt.split("/").pop() ?? withExt;
    const candidates = [
      withExt,
      mainDir + withExt,
      posix.normalize(withExt),
      posix.normalize(mainDir + withExt),
      basename,
    ];
    for (const candidate of candidates) {
      const hit = byName.get(candidate);
      if (hit !== undefined) return hit;
    }
    for (const candidate of candidates) {
      const hit = byNameLower.get(candidate.toLowerCase());
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  // Repeatedly replace \input/\include until no change or pass cap (guards
  // pathological cycles; unresolved targets stay as-is, harmless as text).
  const INPUT_RE = /\\(input|include)\{([^}]+)\}/g;
  let combined = byName.get(mainName) ?? "";
  for (let pass = 0; pass < 5; pass += 1) {
    let next = combined.replace(INPUT_RE, (match, _command, name: string) => {
      const content = resolveInclude(name);
      return content === undefined ? match : content;
    });
    if (next === combined) break;
    combined = next;
  }

  return combined.includes("\\documentclass") || combined.includes("\\begin{document}")
    ? combined
    : null;
}

// ------------------------------------------------------------- TeX → Markdown

/** Math environments whose full block is preserved verbatim. */
const MATH_ENV_RE =
  /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?|displaymath|math)\}[\s\S]*?\\end\{\1\}/g;

interface MacroDef {
  nargs: number;
  body: string;
}

/** Match a balanced {...} group at `pos` (skipping leading whitespace). */
function matchBrace(text: string, pos: number): { content: string; end: number } | null {
  let p = pos;
  while (p < text.length && /\s/.test(text[p]!)) p += 1;
  if (text[p] !== "{") return null;
  let depth = 1;
  const start = p + 1;
  let i = p + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") depth -= 1;
    if (depth === 0) break;
    i += 1;
  }
  if (depth !== 0) return null;
  return { content: text.slice(start, i), end: i + 1 };
}

/** Read a macro name token: {\name} or \name. */
function readMacroName(text: string, pos: number): { name: string; end: number } | null {
  if (text[pos] === "{") {
    const inner = matchBrace(text, pos);
    if (!inner) return null;
    const match = /^\\([a-zA-Z@]+)\s*$/.exec(inner.content);
    if (!match) return null;
    return { name: `\\${match[1]}`, end: inner.end };
  }
  const match = /^\\([a-zA-Z@]+)/.exec(text.slice(pos));
  if (!match) return null;
  return { name: `\\${match[1]}`, end: pos + match[0].length };
}

/** Extract \newcommand / \renewcommand / \providecommand / \def /
 *  \DeclareMathOperator definitions (balanced-brace aware — regexes cannot
 *  match nested bodies); returns the text minus definitions plus the map. */
function extractMacros(text: string): { text: string; macros: Map<string, MacroDef> } {
  const macros = new Map<string, MacroDef>();
  const removals: Array<[number, number]> = [];
  const cmdRe = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator|def)\b/g;
  let match: RegExpExecArray | null;
  while ((match = cmdRe.exec(text)) !== null) {
    const start = match.index;
    const command = match[1]!;
    let pos = match.index + match[0].length;
    if (text[pos] === "*") pos += 1;
    while (pos < text.length && /\s/.test(text[pos]!)) pos += 1;

    if (command === "def") {
      // \def\name#1#2{body}
      const nameMatch = /^\\([a-zA-Z@]+)/.exec(text.slice(pos));
      if (!nameMatch) continue;
      const name = `\\${nameMatch[1]}`;
      pos += nameMatch[0].length;
      let nargs = 0;
      const paramMatch = /^((?:#\d\s*)*)/.exec(text.slice(pos));
      if (paramMatch) {
        nargs = (paramMatch[1]!.match(/#/g) ?? []).length;
        pos += paramMatch[1]!.length;
      }
      const body = matchBrace(text, pos);
      if (!body) continue;
      macros.set(name, { nargs, body: body.content });
      removals.push([start, body.end]);
      continue;
    }

    if (command === "DeclareMathOperator") {
      // \DeclareMathOperator{\name}{def} → body = \operatorname{def}
      const name = readMacroName(text, pos);
      if (!name) continue;
      pos = name.end;
      const def = matchBrace(text, pos);
      if (!def) continue;
      macros.set(name.name, { nargs: 0, body: `\\operatorname{${def.content}}` });
      removals.push([start, def.end]);
      continue;
    }

    // newcommand / renewcommand / providecommand: {\name}[n][default]{body}
    const name = readMacroName(text, pos);
    if (!name) continue;
    pos = name.end;
    let nargs = 0;
    const optMatch = /^\[(\d+)\]/.exec(text.slice(pos));
    if (optMatch) {
      nargs = parseInt(optMatch[1]!, 10);
      pos += optMatch[0].length;
    }
    const defOptMatch = /^\[[^\]]*\]/.exec(text.slice(pos));
    if (defOptMatch) pos += defOptMatch[0].length;
    const body = matchBrace(text, pos);
    if (!body) continue;
    macros.set(name.name, { nargs, body: body.content });
    removals.push([start, body.end]);
  }

  removals.sort((a, b) => b[0] - a[0]);
  let result = text;
  for (const [st, en] of removals) result = result.slice(0, st) + result.slice(en);
  return { text: result, macros };
}

/** Strip non-callable preamble declarations (\newtheorem, \newenvironment,
 *  \theoremstyle, ...) wholesale — their args leak as junk text otherwise. */
function stripEnvironmentDefinitions(text: string): string {
  const cmdRe =
    /\\(newtheorem|renewtheorem|newenvironment|renewenvironment|theoremstyle|theoremheaderfont|theorembodyfont|newcounter|numberwithin|crefname|Crefname|@ifundefined)\b/g;
  const removals: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  while ((match = cmdRe.exec(text)) !== null) {
    let pos = match.index + match[0].length;
    if (text[pos] === "*") pos += 1;
    while (pos < text.length) {
      while (pos < text.length && /\s/.test(text[pos]!)) pos += 1;
      if (text[pos] === "[") {
        const end = text.indexOf("]", pos);
        if (end === -1) break;
        pos = end + 1;
      } else if (text[pos] === "{") {
        const br = matchBrace(text, pos);
        if (!br) break;
        pos = br.end;
      } else {
        break;
      }
    }
    removals.push([match.index, pos]);
    cmdRe.lastIndex = pos;
  }
  removals.sort((a, b) => b[0] - a[0]);
  let result = text;
  for (const [st, en] of removals) result = result.slice(0, st) + result.slice(en);
  return result;
}

/** Expand macro calls (iterative, depth-limited — arXiv sources nest 1-2
 *  levels; the cap guards pathological recursion). */
function expandMacros(text: string, macros: Map<string, MacroDef>, depth = 0): string {
  if (macros.size === 0 || depth > 5) return text;
  let result = "";
  let i = 0;
  let changed = false;
  while (i < text.length) {
    if (text[i] === "\\" && i + 1 < text.length) {
      let j = i + 1;
      if (/[a-zA-Z@]/.test(text[j]!)) {
        while (j < text.length && /[a-zA-Z@]/.test(text[j]!)) j += 1;
      } else {
        j += 1;
      }
      const name = text.slice(i, j);
      const def = macros.get(name);
      if (def) {
        let p = j;
        const args: string[] = [];
        for (let a = 0; a < def.nargs; a += 1) {
          while (p < text.length && /\s/.test(text[p]!)) p += 1;
          if (text[p] === "{") {
            const br = matchBrace(text, p);
            if (!br) {
              args.push("");
              break;
            }
            args.push(br.content);
            p = br.end;
          } else if (text[p] === "\\" && p + 1 < text.length) {
            let q = p + 1;
            if (/[a-zA-Z@]/.test(text[q]!)) {
              while (q < text.length && /[a-zA-Z@]/.test(text[q]!)) q += 1;
            } else {
              q += 1;
            }
            args.push(text.slice(p, q));
            p = q;
          } else {
            args.push(p < text.length ? text[p]! : "");
            if (p < text.length) p += 1;
          }
        }
        let body = def.body;
        for (let a = 0; a < args.length; a += 1) {
          body = body.split(`#${a + 1}`).join(args[a]!);
        }
        result += body;
        i = p;
        changed = true;
        continue;
      }
      result += name;
      i = j;
      continue;
    }
    result += text[i]!;
    i += 1;
  }
  return changed ? expandMacros(result, macros, depth + 1) : result;
}

/** Map an AMS math environment to a KaTeX-compatible $$…$$ form (top-level
 *  display wrappers reduce to aligned/gathered; \label stripped — KaTeX has
 *  no equation counter). */
function normalizeRestoredBlock(block: string): string {
  const envMatch = block.match(/^\\begin\{(\w+\*?)\}([\s\S]*)\\end\{\1\}$/);
  if (envMatch) {
    const env = envMatch[1]!.replace(/\*$/, "");
    const content = envMatch[2]!.replace(/\\label\{[^}]*\}/g, "").trim();
    if (env === "equation" || env === "displaymath" || env === "math") {
      return `$$\n${content}\n$$`;
    }
    if (env === "align" || env === "eqnarray") {
      return `$$\n\\begin{aligned}${content}\\end{aligned}\n$$`;
    }
    if (env === "gather" || env === "multline") {
      return `$$\n\\begin{gathered}${content}\\end{gathered}\n$$`;
    }
    return `$$\n${content}\n$$`;
  }
  const bracketMatch = block.match(/^\\\[([\s\S]*)\\\]$/);
  if (bracketMatch) return `$$\n${bracketMatch[1]!.trim()}\n$$`;
  const parenMatch = block.match(/^\\\(([\s\S]*)\\\)$/);
  if (parenMatch) return `$${parenMatch[1]!.trim()}$`;
  return block;
}

/** Strip simple inline commands from short texts (titles, captions). */
function stripInline(text: string): string {
  return text
    .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?\{([^{}]*)\}/g, "$2")
    .replace(/\\[a-zA-Z]+\*?/g, "")
    .replace(/[{}]/g, "")
    .trim();
}

export function texToMarkdown(tex: string): string {
  let s = tex;

  // 1. Strip comments (unescaped %).
  s = s.replace(/(^|[^\\])%.*/gm, "$1");

  // 1b. Extract + expand custom macros BEFORE protecting math, so calls
  // inside math blocks expand to clean standard LaTeX KaTeX can render.
  const { text: withoutDefs, macros } = extractMacros(s);
  s = expandMacros(withoutDefs, macros);

  // 1c. Strip environment/counter/style declarations.
  s = stripEnvironmentDefinitions(s);

  // 2. Protect math blocks with placeholders (nested math flattens).
  const mathBlocks: string[] = [];
  const protect = (text: string): string => {
    mathBlocks.push(text);
    return `@@SD_MATH_${mathBlocks.length - 1}@@`;
  };
  const PLACEHOLDER_RE = /^@@SD_MATH_\d+@@$/;
  const protectFlatten = (match: string, open: number, close: number): string => {
    const inner = match.slice(open, match.length - close).trim();
    return PLACEHOLDER_RE.test(inner) ? inner : protect(match);
  };
  s = s.replace(MATH_ENV_RE, (match) => protect(match));
  s = s.replace(/\$\$[\s\S]*?\$\$/g, (match) => protectFlatten(match, 2, 2));
  s = s.replace(/\$[^$\n]+\$/g, (match) => protectFlatten(match, 1, 1));
  s = s.replace(/\\\[[\s\S]*?\\\]/g, (match) => protectFlatten(match, 2, 2));
  s = s.replace(/\\\([\s\S]*?\\\)/g, (match) => protectFlatten(match, 2, 2));

  // 3. Preamble → drop (keep title).
  const title = s.match(/\\title\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/)?.[1];
  s = s.replace(/\\documentclass(\[[^\]]*\])?\{[^}]*\}/, "");
  s = s.replace(/\\usepackage(\[[^\]]*\])?\{[^}]*\}/g, "");
  s = s.replace(/\\(bibliographystyle|bibliography|addbibresource)(\[[^\]]*\])?\{[^}]*\}/g, "");

  // 4. Sectioning → headings (args tolerate one level of nested braces).
  const ARG = "([^{}]*(?:\\{[^{}]*\\}[^{}]*)*)";
  const heading = (level: number) => (_match: string, _star: string, arg: string): string =>
    `\n\n${"#".repeat(level)} ${stripInline(arg)}\n\n`;
  s = s.replace(new RegExp(`\\\\part(\\*)?\\{${ARG}\\}`, "g"), heading(1));
  s = s.replace(new RegExp(`\\\\chapter(\\*)?\\{${ARG}\\}`, "g"), heading(1));
  s = s.replace(new RegExp(`\\\\section(\\*)?\\{${ARG}\\}`, "g"), heading(2));
  s = s.replace(new RegExp(`\\\\subsection(\\*)?\\{${ARG}\\}`, "g"), heading(3));
  s = s.replace(new RegExp(`\\\\subsubsection(\\*)?\\{${ARG}\\}`, "g"), heading(4));
  s = s.replace(new RegExp(`\\\\paragraph(\\*)?\\{${ARG}\\}`, "g"), heading(5));

  // 5. Citations & references → anchors (the W10 chain input).
  s = s.replace(/\\cite\w*\*?(\[[^\]]*\])?\{([^}]*)\}/g, (_match, _opt, keys: string) =>
    keys.split(",").map((key) => `[@${key.trim()}]`).join(" "));
  s = s.replace(/\\ref\{([^}]*)\}/g, "[ref:$1]");
  s = s.replace(/\\label\{[^}]*\}/g, "");

  // 6. Abstract → blockquote-ish.
  s = s.replace(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/g, "\n\n> **Abstract** $1\n\n");

  // 7. Figures & tables → keep captions.
  s = s.replace(
    /\\begin\{(figure\*?|table\*?)\}[\s\S]*?\\caption\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}[\s\S]*?\\end\{\1\}/g,
    (_match, kind: string, caption: string) => `\n\n**[${kind}]** ${stripInline(caption)}\n\n`,
  );
  s = s.replace(/\\begin\{(figure\*?|table\*?)\}[\s\S]*?\\end\{\1\}/g, "");

  // 8. Lists.
  s = s.replace(/\\begin\{itemize\}/g, "\n");
  s = s.replace(/\\end\{itemize\}/g, "\n");
  s = s.replace(/\\begin\{enumerate\}/g, "\n");
  s = s.replace(/\\end\{enumerate\}/g, "\n");
  s = s.replace(/\\item(\[[^\]]*\])?\s*/g, "\n- ");

  // 9. Inline formatting.
  s = s.replace(/\\(textbf|bf|bfseries)\{([^{}]*)\}/g, "**$2**");
  s = s.replace(/\\(textit|emph|it)\{([^{}]*)\}/g, "*$2*");
  s = s.replace(/\\(texttt|tt)\{([^{}]*)\}/g, "`$2`");
  s = s.replace(/\\(underline|mathrm|text|mbox)\{([^{}]*)\}/g, "$2");

  // 10. Drop remaining environments and commands (keep text content).
  s = s.replace(/\\begin\{[^}]*\}(\[[^\]]*\])?(\{[^}]*\})?/g, "");
  s = s.replace(/\\end\{[^}]*\}/g, "");
  s = s.replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?\{([^{}]*)\}/g, "$2");
  s = s.replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, "");
  s = s.replace(/[{}]/g, "");
  s = s.replace(/~|\\,/g, " ");

  // 11. Restore math, normalized to KaTeX-compatible delimiters.
  const restoreRe = /@@SD_MATH_(\d+)@@/g;
  for (let guard = 0; guard < 10 && restoreRe.test(s); guard += 1) {
    s = s.replace(restoreRe, (_match, index: string) => normalizeRestoredBlock(mathBlocks[Number(index)]!));
  }

  // 12. Whitespace hygiene.
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  if (title) s = `# ${stripInline(title)}\n\n${s}`;
  return s.trim();
}
