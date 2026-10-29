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
 * A Python file, split into the lines and coloured spans the panel shows.
 *
 * The app has no highlighter and does not need one for a single language: the
 * handoff asks for a code page with a line gutter, and Python's own shape —
 * comments to the end of the line, strings that may run across lines, a
 * `def` followed by the name it defines — is a scanner's work, not a parser's.
 * Nothing here knows about the DOM, so the tokens can be checked directly.
 */

export type SourceTokenKind =
  | "builtin"
  | "comment"
  | "constant"
  | "decorator"
  | "definition"
  | "keyword"
  | "number"
  | "string";

export interface SourceToken {
  kind?: SourceTokenKind;
  text: string;
}

/** Past this many characters a file is shown, not coloured: the scan would cost
 *  more than the page is worth, and a file that size is read for a few lines. */
export const MAX_SOURCE_CHARS = 400_000;

const CONSTANTS = new Set(["False", "None", "True", "NotImplemented", "Ellipsis", "cls", "self"]);

const KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "case", "class", "continue",
  "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "match", "nonlocal", "not", "or",
  "pass", "raise", "return", "try", "while", "with", "yield",
]);

const BUILTINS = new Set([
  "abs", "all", "any", "bool", "bytearray", "bytes", "callable", "chr", "complex",
  "dict", "dir", "divmod", "enumerate", "filter", "float", "format", "frozenset",
  "getattr", "globals", "hasattr", "hash", "id", "input", "int", "isinstance",
  "issubclass", "iter", "len", "list", "locals", "map", "max", "min", "next",
  "object", "open", "ord", "pow", "print", "range", "repr", "reversed", "round",
  "set", "setattr", "slice", "sorted", "str", "sum", "super", "tuple", "type",
  "zip",
  // The exceptions a reader sees named in a traceback more than anywhere else.
  "Exception", "IndexError", "KeyError", "RuntimeError", "StopIteration",
  "TypeError", "ValueError",
]);

const IDENTIFIER = /[\p{L}_][\p{L}\p{N}_]*/uy;
const NUMBER = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][-+]?\d+)?[jJ]?)/y;
const DECORATOR = /@[\p{L}_][\p{L}\p{N}_.]*/uy;

/** A string prefix is one or two letters glued to the opening quote; it is part
 *  of the string, not the word it looks like. */
function stringPrefix(plain: string): { prefix: string; rest: string } | undefined {
  const match = /([A-Za-z]{1,2})$/u.exec(plain);
  const candidate = match?.[1];
  if (candidate === undefined) return undefined;
  if (!/^(?:[rR][bBfF]?|[bB][rRfF]?|[fF][rR]?|[uU])$/u.test(candidate)) return undefined;
  const rest = plain.slice(0, plain.length - candidate.length);
  const before = rest.at(-1) ?? "";
  // `farr"x"` is a name followed by a string, not a prefix on it.
  if (/[\p{L}\p{N}_]/u.test(before)) return undefined;
  return { prefix: candidate, rest };
}

function atLineStart(source: string, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const character = source[cursor];
    if (character === " " || character === "\t" || character === "\f") continue;
    return character === "\n";
  }
  return true;
}

function scan(source: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  let plain = "";
  let index = 0;

  const flush = () => {
    if (plain !== "") {
      tokens.push({ text: plain });
      plain = "";
    }
  };
  const emit = (kind: SourceTokenKind, text: string) => {
    flush();
    tokens.push({ kind, text });
  };
  /** The token before `plain`, which is the one a `def` names. */
  const lastToken = (): SourceToken | undefined => tokens.at(-1);

  while (index < source.length) {
    const character = source[index]!;

    if (character === "#") {
      const end = source.indexOf("\n", index);
      const stop = end < 0 ? source.length : end;
      emit("comment", source.slice(index, stop));
      index = stop;
      continue;
    }

    if (character === "\"" || character === "'") {
      const prefix = stringPrefix(plain);
      if (prefix !== undefined) plain = prefix.rest;
      flush();
      const opening = prefix?.prefix ?? "";
      const triple = source.startsWith(character.repeat(3), index);
      if (triple) {
        const delimiter = character.repeat(3);
        // A delimiter is escaped only by an odd run of backslashes: the first
        // one of a pair escapes the second, so `"""a\\"""` still closes here.
        const escaped = (position: number): boolean => {
          let run = 0;
          while (position - run > 0 && source[position - run - 1] === "\\") run += 1;
          return run % 2 === 1;
        };
        let end = source.indexOf(delimiter, index + 3);
        while (end > 0 && escaped(end)) end = source.indexOf(delimiter, end + 1);
        const stop = end < 0 ? source.length : end + 3;
        tokens.push({ kind: "string", text: opening + source.slice(index, stop) });
        index = stop;
      } else {
        let cursor = index + 1;
        while (cursor < source.length && source[cursor] !== character && source[cursor] !== "\n") {
          if (source[cursor] === "\\") cursor += 1;
          cursor += 1;
        }
        const stop = source[cursor] === character ? cursor + 1 : cursor;
        tokens.push({ kind: "string", text: opening + source.slice(index, stop) });
        index = stop;
      }
      continue;
    }

    if (character === "@" && atLineStart(source, index)) {
      DECORATOR.lastIndex = index;
      const match = DECORATOR.exec(source);
      if (match !== null) {
        emit("decorator", match[0]);
        index = DECORATOR.lastIndex;
        continue;
      }
    }

    if (/[0-9]/u.test(character) && !/[\p{L}\p{N}_]/u.test(source[index - 1] ?? "")) {
      NUMBER.lastIndex = index;
      const match = NUMBER.exec(source);
      if (match !== null) {
        emit("number", match[0]);
        index = NUMBER.lastIndex;
        continue;
      }
    }

    if (/[\p{L}_]/u.test(character)) {
      IDENTIFIER.lastIndex = index;
      const match = IDENTIFIER.exec(source);
      if (match !== null) {
        const word = match[0];
        const previous = lastToken();
        if (CONSTANTS.has(word)) emit("constant", word);
        else if (KEYWORDS.has(word)) emit("keyword", word);
        else if (previous?.kind === "keyword" && (previous.text === "def" || previous.text === "class")) {
          emit("definition", word);
        } else if (BUILTINS.has(word)) emit("builtin", word);
        else plain += word;
        index = IDENTIFIER.lastIndex;
        continue;
      }
    }

    plain += character;
    index += 1;
  }

  flush();
  return tokens;
}

/** One entry per line, which is also one gutter number per line. A token that
 *  spans lines — a triple-quoted string — is split across them, so every line
 *  is a list it can draw on its own. */
export function splitLines(tokens: readonly SourceToken[]): SourceToken[][] {
  const lines: SourceToken[][] = [[]];
  for (const token of tokens) {
    token.text.split("\n").forEach((part, offset) => {
      if (offset > 0) lines.push([]);
      if (part === "") return;
      lines.at(-1)!.push(token.kind === undefined ? { text: part } : { kind: token.kind, text: part });
    });
  }
  // A file that ends in a newline does not have one more empty line in it; an
  // editor's gutter stops at the last line that has something on it.
  if (lines.length > 1 && lines.at(-1)!.length === 0) lines.pop();
  return lines;
}

/** The source as the panel draws it: one list of coloured spans per line. */
export function highlightPython(source: string): SourceToken[][] {
  return splitLines(scan(source.replace(/\r\n?/gu, "\n")));
}
