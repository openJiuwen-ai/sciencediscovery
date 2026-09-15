// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { builtinModules } from "node:module";
import { posix as path } from "node:path";
import { parse } from "@babel/parser";

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

/** Parse literal imports, re-exports, import types, require and dynamic imports. */
export function importsOf(file, source) {
  const imports = [];
  const tree = parse(source, { sourceType: "unambiguous", plugins: ["typescript", ...(/\.[jt]sx$/.test(file) ? ["jsx"] : [])], createImportExpressions: true });
  function add(node, typeOnly = false) {
    if (node?.type === "StringLiteral") imports.push({ specifier: node.value, typeOnly });
  }
  function visit(node) {
    if (node.type === "ImportDeclaration") {
      add(node.source, node.importKind === "type" || (node.specifiers.length > 0 && node.specifiers.every(item => item.importKind === "type")));
    } else if (["ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)) {
      add(node.source, node.exportKind === "type" || (node.specifiers?.length > 0 && node.specifiers.every(item => item.exportKind === "type")));
    } else if (node.type === "TSImportType") {
      add(node.argument, true);
    } else if (node.type === "TSImportEqualsDeclaration") {
      add(node.moduleReference.expression, node.importKind === "type");
    } else if (node.type === "ImportExpression") {
      add(node.source);
    } else if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require") {
      add(node.arguments[0]);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) { for (const item of value) if (item?.type) visit(item); }
      else if (value && typeof value === "object" && value.type) visit(value);
    }
  }
  visit(tree);
  return imports;
}

/** Pure graph check so forbidden dependency examples can be tested without touching the repository. */
export function checkComponentBoundaries(manifests, sources, legacyHostDependencies = []) {
  const failures = new Set();
  const byName = new Map(manifests.map(item => [item.name, item]));
  const owner = file => manifests.find(item => file.startsWith(`${item.directory}/`));
  const graph = new Map(manifests.map(item => [item.name, new Set()]));
  const parsed = new Map([...sources].map(([file, source]) => [file, importsOf(file, source)]));
  const component = item => item.directory.startsWith("packages/");
  const report = (file, message) => failures.add(`${file}: ${message}`);
  const addEdge = (from, to, file) => {
    if (from.name !== to.name) graph.get(from.name).add(to.name);
    if (component(from) && !component(to) && !legacyHostDependencies.some(item => item.from === from.name && item.to === to.name && item.files.includes(file))) {
      report(file, "packages must not depend on services/ or apps/");
    }
  };
  const packageName = specifier => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
  const exported = (item, key) => {
    const entries = item.exports;
    if (!entries) return undefined;
    if (typeof entries === "string" || !Object.keys(entries).some(k => k.startsWith("."))) return key === "." ? entries : undefined;
    if (entries[key]) return entries[key];
    for (const [pattern, value] of Object.entries(entries)) {
      const [before, after] = pattern.split("*");
      if (after !== undefined && key.startsWith(before) && key.endsWith(after)) {
        const match = key.slice(before.length, after ? -after.length : undefined);
        return JSON.parse(JSON.stringify(value).replaceAll("*", match));
      }
    }
  };
  const sourceEntry = value => typeof value === "string" ? value
    : value && (sourceEntry(value.types) ?? sourceEntry(value.import) ?? sourceEntry(value.default));
  const localFile = file => [file, file.replace(/\.js$/, ".ts"), file.replace(/\.js$/, ".tsx"), `${file}.ts`, `${file}.tsx`, `${file}/index.ts`]
    .find(candidate => sources.has(candidate));
  function resolveImport(file, specifier) {
    if (specifier.startsWith(".")) return localFile(path.normalize(path.join(path.dirname(file), specifier)));
    const target = byName.get(packageName(specifier));
    if (!target) return undefined;
    const key = specifier === target.name ? "." : `.${specifier.slice(target.name.length)}`;
    const entry = sourceEntry(exported(target, key));
    return entry ? localFile(path.join(target.directory, entry)) : undefined;
  }
  for (const item of manifests) {
    const dependencies = { ...item.dependencies, ...item.devDependencies, ...item.peerDependencies, ...item.optionalDependencies };
    for (const name of Object.keys(dependencies)) {
      const target = byName.get(name);
      if (target) addEdge(item, target, `${item.directory}/package.json`);
      if (/^@sciencediscovery\/plugin-(?:plan|mcp-sources|skill|mcp|scheduler|artifact-json)$/.test(name)) report(item.directory, `removed plugin package dependency: ${name}`);
    }
  }
  for (const [file, imports] of parsed) {
    const from = owner(file);
    if (!from) continue;
    for (const { specifier } of imports) {
      if (specifier.startsWith(".")) {
        const resolved = path.normalize(path.join(path.dirname(file), specifier));
        const target = owner(resolved);
        if (component(from) && /^(services|apps)\//.test(resolved)) report(file, "packages must not import services/ or apps/");
        if (target && target.name !== from.name) {
          addEdge(from, target, file);
          report(file, "cross-package relative import; use a public package export");
        }
      } else {
        const target = byName.get(packageName(specifier));
        if (!target) continue;
        addEdge(from, target, file);
        const key = specifier === target.name ? "." : `.${specifier.slice(target.name.length)}`;
        if (target.name !== from.name && !exported(target, key)) report(file, `non-public package import: ${specifier}`);
      }
    }
  }
  const visiting = new Set(), visited = new Set(), stack = [];
  function visit(name) {
    if (visiting.has(name)) { failures.add(`Workspace dependency cycle: ${[...stack.slice(stack.indexOf(name)), name].join(" -> ")}`); return; }
    if (visited.has(name)) return;
    visiting.add(name); stack.push(name);
    for (const next of graph.get(name)) visit(next);
    stack.pop(); visiting.delete(name); visited.add(name);
  }
  for (const name of graph.keys()) visit(name);

  // Follow runtime edges from browser exports, including local helper modules
  // and re-exports. A type-only dependency still counts for cycles above.
  for (const item of manifests.filter(component)) {
    for (const key of ["./web", "./manifest", "./views"]) {
      const entry = sourceEntry(exported(item, key));
      if (!entry) continue;
      const start = localFile(path.join(item.directory, entry));
      if (!start) { report(item.directory, `missing browser entry: ${key}`); continue; }
      const seen = new Set();
      function check(file, chain) {
        if (seen.has(file)) return;
        seen.add(file);
        for (const { specifier, typeOnly } of parsed.get(file) ?? []) {
          if (typeOnly) continue;
          if (builtins.has(specifier) || specifier.startsWith("node:")) report(start, `browser entry reaches Node builtin ${specifier} via ${chain.join(" -> ")}`);
          const next = resolveImport(file, specifier);
          if (next) check(next, [...chain, next]);
        }
      }
      check(start, [start]);
    }
  }
  return [...failures];
}
