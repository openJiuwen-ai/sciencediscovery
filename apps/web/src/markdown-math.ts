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
 * Prepare math for remark-math, outside fenced and inline code.
 *
 * Every single `$` that cannot delimit inline math under Pandoc's rule is escaped, so only real
 * formulas are rendered. remark-math pairs any two dollars, which turns a shell line
 * (`for i in $(seq 1 9); do echo $i; done`) or prices (`$5 and $10`) into garbled math. Pandoc's
 * rule: the opening `$` is followed by a non-space character; the closing `$` is preceded by a
 * non-space character and not followed by a digit; the formula stays within its paragraph.
 * `$$…$$` and already escaped dollars are left as they are.
 *
 * LaTeX's own delimiters, which models write as often as dollars, become dollars: `\(…\)` inline,
 * `\[…\]` display. remark-math reads neither, and Markdown shows `\(` as a bare parenthesis.
 */
export function normalizeMathMarkdown(markdown: string): string {
  if (!/\$|\\[([]/.test(markdown)) return markdown;
  const out: string[] = [];
  let fence: string | undefined;
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) out.push(escapeProse(prose.join("\n")));
    prose = [];
  };
  for (const line of markdown.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
    } else if (marker) {
      flush();
      fence = marker;
      out.push(line);
    } else {
      prose.push(line);
    }
  }
  flush();
  return out.join("\n");
}

/** Normalize the math of text with no fenced code in it; inline code spans are kept whole. */
function escapeProse(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\") {
      const math = latexDelimitedMath(text, index);
      result += math?.markdown ?? text.slice(index, index + 2);
      index = math?.end ?? index + 2;
    } else if (char === "`") {
      const run = /^`+/.exec(text.slice(index))![0];
      const end = text.indexOf(run, index + run.length);
      const stop = end < 0 ? index + run.length : end + run.length;
      result += text.slice(index, stop);
      index = stop;
    } else if (char !== "$") {
      result += char;
      index += 1;
    } else if (text[index + 1] === "$") {
      // Display math: keep everything up to the closing `$$`.
      const end = text.indexOf("$$", index + 2);
      const stop = end < 0 ? index + 2 : end + 2;
      result += text.slice(index, stop);
      index = stop;
    } else {
      const close = inlineMathEnd(text, index);
      if (close < 0) {
        result += "\\$";
        index += 1;
      } else {
        result += text.slice(index, close + 1);
        index = close + 1;
      }
    }
  }
  return result;
}

/** `\(…\)` or `\[…\]` starting at `open` as dollar math, with the index after it; undefined when it is not one. */
function latexDelimitedMath(text: string, open: number): { end: number; markdown: string } | undefined {
  const kind = text[open + 1];
  if (kind !== "(" && kind !== "[") return undefined;
  const close = text.indexOf(kind === "(" ? "\\)" : "\\]", open + 2);
  if (close < 0) return undefined;
  const inner = text.slice(open + 2, close);
  if (!inner.trim() || inner.includes("\n\n")) return undefined;
  const end = close + 2;
  if (kind === "(") return { end, markdown: `$${inner.trim()}$` };
  // On a line of its own a display formula stays a block; inside a sentence it stays inline.
  const ownLine = (open === 0 || text[open - 1] === "\n") && (end === text.length || text[end] === "\n");
  return { end, markdown: ownLine ? `$$\n${inner.trim()}\n$$` : `$$${inner.trim()}$$` };
}

/** The index of the `$` that closes inline math opened at `open`, or -1 when none may. */
function inlineMathEnd(text: string, open: number): number {
  const first = text[open + 1];
  if (first === undefined || /\s/.test(first)) return -1;
  for (let index = open + 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\\") {
      index += 1;
    } else if (char === "\n" && text[index + 1] === "\n") {
      return -1;
    } else if (char === "$") {
      if (text[index + 1] === "$") return -1;
      if (!/\s/.test(text[index - 1]!) && !/\d/.test(text[index + 1] ?? "")) return index;
    }
  }
  return -1;
}
