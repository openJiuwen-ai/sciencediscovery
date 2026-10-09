// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Only supplier-generated reference fields in these two wheel SBOMs qualify.
// The caller separately scans exact repository/staging/output paths WITHOUT
// this filter. Never change the shipped SBOM or skip a whole dependency tree.
const references = [
  [/^memory-graph\/site-packages\/pydantic_core-[^/]+\.dist-info\/sboms\/pydantic-core\.cyclonedx\.json$/,
    "path+file:///home/runner/work/pydantic/pydantic/pydantic-core#"],
  [/^memory-graph\/site-packages\/watchfiles-[^/]+\.dist-info\/sboms\/watchfiles_rust_notify\.cyclonedx\.json$/,
    "path+file:///home/runner/work/watchfiles/watchfiles#"],
];

export function hasUnapprovedHomePath(path, content, home) {
  const prefix = references.find(([pattern]) => pattern.test(path))?.[1];
  let scanned = content;
  if (prefix) {
    try {
      const parsed = JSON.parse(content, (key, value) => {
        if ((key === "bom-ref" || key === "ref") && typeof value === "string" && value.startsWith(prefix)) {
          // Strip only the known prefix; any additional private path remains visible.
          return `upstream-reference#${value.slice(prefix.length)}`;
        }
        return value;
      });
      scanned = JSON.stringify(parsed);
    } catch {
      // Malformed or unexpected metadata must pass the normal check.
    }
  }
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-zA-Z0-9])${escaped}([^a-zA-Z0-9]|$)`).test(scanned);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, home] = process.argv.slice(2);
  if (!root || !home) throw new Error("Expected payload root and HOME needle");
  for (const file of readFileSync(0, "utf8").split("\n").filter(Boolean)) {
    if (hasUnapprovedHomePath(relative(root, file), readFileSync(file, "utf8"), home)) {
      process.stdout.write(`${file}\n`);
    }
  }
}
