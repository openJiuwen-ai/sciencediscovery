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

import { readFileSync } from 'node:fs';

export const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8'));

/** Closed vocabulary shared with the pytest plugin; no testcase registry. */
export function parseTag(tag) {
  if (typeof tag !== 'string' || !/^[a-z]+:[a-z0-9]+$/.test(tag)) {
    throw new Error(`Invalid tag ${JSON.stringify(tag)}; expected group:value`);
  }
  const [group, value] = tag.split(':');
  if (!schema.groups[group]?.values.includes(value)) throw new Error(`Unknown tag: ${tag}`);
  return [group, value];
}

export function normalizeTags(tags, { partial = false } = {}) {
  if (!Array.isArray(tags)) throw new Error('Tags must be an array of group:value strings');
  const groups = new Map();
  for (const tag of tags) {
    const [group, value] = parseTag(tag);
    const values = groups.get(group) ?? new Set();
    if (values.has(value)) throw new Error(`Duplicate tag: ${tag}`);
    values.add(value);
    groups.set(group, values);
  }
  for (const [group, rule] of Object.entries(schema.groups)) {
    const count = groups.get(group)?.size ?? 0;
    // A group with a default is declared only where a test deviates from it.
    // The default is materialised here, on the complete identity, so the frozen
    // plan still carries a concrete value for every group on every entry and a
    // selector can ask for it positively. `partial` is the inheritance pass,
    // where filling a default would silently outrank a suite's own declaration.
    if (!partial && !count && rule.default !== undefined) {
      groups.set(group, new Set([rule.default]));
      continue;
    }
    if (!partial && rule.default === undefined && !count) throw new Error(`Missing tag group: ${group}`);
    if (!rule.multiple && count > 1) throw new Error(`Conflicting values for ${group}`);
  }
  return Object.freeze([...groups].flatMap(([g, vs]) => [...vs].map(v => `${g}:${v}`)).sort());
}

/** An explicit child group replaces, rather than unions with, its inherited group. */
export function inheritTags(parent, child = []) {
  normalizeTags(parent, { partial: true });
  normalizeTags(child, { partial: true });
  const overridden = new Set(child.map(t => parseTag(t)[0]));
  return normalizeTags([...parent.filter(t => !overridden.has(parseTag(t)[0])), ...child], { partial: true });
}

/** Boolean grammar: tag, parentheses, not, and, or. No regex or eval. */
export function compileSelector(expression = '') {
  if (typeof expression !== 'string') throw new Error('Selector must be a string');
  if (!expression.trim()) return () => true;
  const tokens = [];
  const re = /\s*(\(|\)|\band\b|\bor\b|\bnot\b|[a-z]+:[a-z0-9]+)/gy;
  let offset = 0;
  while (offset < expression.length && expression.slice(offset).trim()) {
    re.lastIndex = offset;
    const match = re.exec(expression);
    if (!match) throw new Error(`Invalid selector near: ${expression.slice(offset)}`);
    tokens.push(match[1]);
    offset = re.lastIndex;
  }
  let pos = 0;
  function unary() {
    if (tokens[pos] === 'not') { pos++; return { op: 'not', child: unary() }; }
    if (tokens[pos] === '(') {
      pos++;
      const node = or();
      if (tokens[pos++] !== ')') throw new Error('Missing closing parenthesis');
      return node;
    }
    const tag = tokens[pos++];
    parseTag(tag);
    return { op: 'tag', tag };
  }
  function and() {
    let node = unary();
    while (tokens[pos] === 'and') { pos++; node = { op: 'and', left: node, right: unary() }; }
    return node;
  }
  function or() {
    let node = and();
    while (tokens[pos] === 'or') { pos++; node = { op: 'or', left: node, right: and() }; }
    return node;
  }
  const ast = or();
  if (pos !== tokens.length) throw new Error(`Unexpected selector token: ${tokens[pos]}`);
  const evaluate = (node, tags) => node.op === 'tag' ? tags.has(node.tag)
    : node.op === 'not' ? !evaluate(node.child, tags)
    : node.op === 'and' ? evaluate(node.left, tags) && evaluate(node.right, tags)
    : evaluate(node.left, tags) || evaluate(node.right, tags);
  return tags => evaluate(ast, new Set(tags));
}
