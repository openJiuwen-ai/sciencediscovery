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

import { parse } from '@babel/parser';

/** Audit identity inputs; ordinary fixture initialization cannot supply names or tags. */
export function auditNodeSource(source, file) {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const constants = new Map();
  const fail = n => { throw new Error(`DYNAMIC_REGISTRATION: ${file}:${n?.loc?.start.line ?? 1}; use static declarations and move runtime work into hooks`); };
  const unwrap = n => ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression'].includes(n?.type) ? unwrap(n.expression) : n;
  function literal(raw, locals = new Set()) {
    const n = unwrap(raw);
    if (!n) return true;
    if (['StringLiteral','NumericLiteral','BooleanLiteral','NullLiteral','RegExpLiteral'].includes(n.type)) return true;
    if (['ArrowFunctionExpression','FunctionExpression'].includes(n.type)) return true;
    if (n.type === 'Identifier') return locals.has(n.name) || constants.get(n.name) === true || n.name === 'undefined';
    if (n.type === 'ArrayExpression') return n.elements.every(x => literal(x, locals));
    if (n.type === 'ObjectExpression') return n.properties.every(p => p.type === 'ObjectProperty' && !p.computed && literal(p.value, locals));
    if (n.type === 'TemplateLiteral') return n.expressions.every(x => literal(x, locals));
    if (n.type === 'SpreadElement') return literal(n.argument,locals);
    if (n.type === 'ConditionalExpression') return literal(n.test,locals) && literal(n.consequent,locals) && literal(n.alternate,locals);
    if (n.type === 'UnaryExpression') return literal(n.argument, locals);
    if (['BinaryExpression','LogicalExpression'].includes(n.type)) return literal(n.left, locals) && literal(n.right, locals);
    if (n.type === 'MemberExpression') return literal(n.object, locals) && (!n.computed || literal(n.property, locals));
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && ['entries','keys','values','freeze'].includes(n.callee.property.name) && n.callee.object.name === 'Object') return n.arguments.every(x => literal(x, locals));
    return false;
  }
  const name = n => n?.type === 'Identifier' ? n.name : n?.type === 'MemberExpression' ? `${name(n.object)}.${name(n.property)}` : '';
  function bindings(n) { return n.type === 'Identifier' ? [n.name] : (n.elements ?? n.properties?.map(p=>p.value) ?? []).filter(Boolean).flatMap(bindings); }
  function statements(nodes, locals = new Set()) {
    for (const raw of nodes) {
      const n = raw.type === 'ExportNamedDeclaration' ? raw.declaration : raw;
      if (!n) continue;
      if (n.type === 'ImportDeclaration') {
        if (n.importKind !== 'type' && ['node:test','@playwright/test'].includes(n.source.value)) fail(n);
      } else if (n.type === 'VariableDeclaration') {
        for (const d of n.declarations) {
          if (name(d.init?.callee) === 'createTest') {
            if (source.slice(d.init.arguments[0].start,d.init.arguments[0].end) !== 'import.meta.url' || !literal(d.init.arguments[1],locals)) fail(d);
          } else for (const b of bindings(d.id)) constants.set(b,literal(d.init,locals));
        }
      } else if (n.type === 'ForOfStatement') {
        if (!literal(n.right,locals) || n.left.type !== 'VariableDeclaration') fail(n);
        statements(n.body.type === 'BlockStatement' ? n.body.body : [n.body], new Set([...locals,...bindings(n.left.declarations[0].id)]));
      } else if (['IfStatement','WhileStatement','ForStatement','TryStatement','SwitchStatement'].includes(n.type)) fail(n);
      else if (n.type === 'ClassDeclaration') {
        for (const m of n.body.body) if (m.type === 'StaticBlock' || m.computed) fail(m);
      } else if (n.type === 'ExpressionStatement') {
        const call = n.expression;
        const callee = name(call.callee);
        if (/^(test|it|describe)(\.(skip|todo|only))?$/.test(callee)) {
          if (!literal(call.arguments[0],locals) || (call.arguments.length === 3 && !literal(call.arguments[1],locals))) fail(n);
          const fn = call.arguments.at(-1);
          if (!['ArrowFunctionExpression','FunctionExpression'].includes(fn.type)) fail(n);
          if (callee.startsWith('describe')) {
            if (fn.async || fn.body.type !== 'BlockStatement') fail(fn);
            statements(fn.body.body,locals);
          }
        } else if (!/^(test\.)?(before|after|beforeEach|afterEach)$/.test(callee)) {
          // Assignments to test-related names and registration callbacks are never fixture setup.
          const text=source.slice(n.start,n.end);
          if (/\b(test|it|describe)\s*\(/.test(text)) fail(n);
        }
      }
    }
  }
  statements(ast.program.body);
}
