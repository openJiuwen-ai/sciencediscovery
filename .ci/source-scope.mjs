// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

import { parse } from "@babel/parser";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const sourceRoots = ["apps/web/src", "apps/desktop/src", "services/api/src", "services/runner/src", "packages"];
const excluded = /(?:^|\/)(?:dist|node_modules|coverage|\.tmp|__snapshots__)(?:\/|$)|(?:\.test|\.spec)\.[cm]?[jt]sx?$/u;

export function isInventorySource(path) {
  return /\.[cm]?[jt]sx?$/u.test(path)
    && sourceRoots.some(root => path.startsWith(`${root}/`))
    && !excluded.test(path);
}

function isStructural(node) {
  if (node.declare || node.type === "TSInterfaceDeclaration" || node.type === "TSTypeAliasDeclaration") return true;
  switch (node.type) {
    case "ImportDeclaration":
      return node.importKind === "type";
    case "ExportNamedDeclaration":
      if (node.declaration) return isStructural(node.declaration);
      return !node.source || node.specifiers.length > 0;
    case "ExportAllDeclaration":
    case "EmptyStatement":
      return true;
    default:
      return false;
  }
}

export function classifySource(root, path) {
  const declarationFile = /\.d\.[cm]?ts$/u.test(path);
  const plugins = [];
  if (/\.[cm]?tsx?$/u.test(path)) plugins.push(["typescript", { dts: declarationFile }]);
  if (/\.[jt]sx$/u.test(path)) plugins.push("jsx");
  try {
    const { program } = parse(readFileSync(join(root, path), "utf8"), { sourceType: "unambiguous", plugins });
    if (declarationFile || (!program.directives.length && program.body.every(isStructural))) {
      return "structural-or-type-only";
    }
  } catch (error) {
    // A missing or unparseable file cannot establish an exemption.
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return "behavioral";
}
