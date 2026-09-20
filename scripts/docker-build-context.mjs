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
 * Static checks over the product Dockerfile's use of the build context.
 *
 * A `COPY` whose source no longer exists only fails when somebody actually
 * builds the image, and no repository layer builds it: a renamed workspace
 * package left `docker compose build` broken for hundreds of commits. These
 * checks are pure string work over the committed files, so the same drift now
 * fails an ordinary unit-test run.
 */

const collapse = (instruction) => instruction.trim().replace(/\s+/gu, " ");

/** Physical lines joined on trailing backslashes, comments and blanks dropped. */
export function instructionsOf(dockerfile) {
  const instructions = [];
  let pending = "";
  for (const raw of dockerfile.split("\n")) {
    const line = raw.trimEnd();
    if (!pending && (line.trim() === "" || line.trim().startsWith("#"))) continue;
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1)} `;
      continue;
    }
    instructions.push(collapse(`${pending}${line}`));
    pending = "";
  }
  if (pending.trim()) instructions.push(collapse(pending));
  return instructions;
}

/**
 * Build-context paths the Dockerfile reads: `COPY` sources, plus the
 * `--mount=type=bind` sources of `RUN`. Copies from another build stage
 * (`--from=<stage>`) and mounts with `from=` read that stage, not the context.
 */
export function buildContextSources(dockerfile) {
  const sources = [];
  for (const instruction of instructionsOf(dockerfile)) {
    const [keyword, ...rest] = instruction.split(/\s+/u);
    const verb = keyword.toUpperCase();
    if (verb === "COPY") {
      const flags = rest.filter((token) => token.startsWith("--"));
      if (flags.some((flag) => flag.startsWith("--from="))) continue;
      const operands = rest.filter((token) => !token.startsWith("--"));
      // The final operand is the destination inside the image.
      for (const source of operands.slice(0, -1)) sources.push({ instruction, source });
      continue;
    }
    if (verb !== "RUN") continue;
    for (const mount of instruction.match(/--mount=[^\s]+/gu) ?? []) {
      const fields = new Map(mount.slice("--mount=".length).split(",")
        .map((field) => field.split("=")).filter((pair) => pair.length === 2));
      if (fields.get("type") !== "bind" || fields.has("from")) continue;
      const source = fields.get("source") ?? fields.get("src");
      if (source) sources.push({ instruction, source });
    }
  }
  return sources;
}

/** The longest leading path segments that carry no glob character. */
export function literalPrefix(source) {
  const segments = source.split("/");
  const globAt = segments.findIndex((segment) => /[*?[]/u.test(segment));
  return (globAt === -1 ? segments : segments.slice(0, globAt)).join("/") || ".";
}

/**
 * Sources the build context cannot satisfy. A glob is checked down to its
 * literal prefix only: whether it matches anything is the builder's business,
 * but a prefix that does not exist is always a stale path.
 */
export function missingBuildContextSources(dockerfile, exists) {
  return buildContextSources(dockerfile)
    .filter(({ source }) => !exists(literalPrefix(source)))
    .map(({ instruction, source }) => `${source} (${instruction})`);
}

/**
 * Per-package manifest copies. Naming workspace manifests one by one is what
 * drifted: the list is only correct until the next package is added, renamed or
 * removed, and nothing fails until somebody builds the image.
 */
export function handwrittenManifestCopies(dockerfile) {
  return buildContextSources(dockerfile)
    .filter(({ source }) => source.endsWith("/package.json"))
    .map(({ source }) => source);
}

/** Workspace project directories recorded in a pnpm v9 lockfile. */
export function lockfileImporters(lockfile) {
  const importers = [];
  let inside = false;
  for (const line of lockfile.split("\n")) {
    if (/^importers:\s*$/u.test(line)) { inside = true; continue; }
    if (!inside) continue;
    if (/^\S/u.test(line)) break;
    const match = /^ {2}(\S[^:]*):\s*$/u.exec(line);
    if (match) importers.push(match[1].replace(/^['"]|['"]$/gu, ""));
  }
  return importers;
}

/** Lockfile importers whose manifest is absent from the working tree. */
export function importersMissingManifests(lockfile, exists) {
  return lockfileImporters(lockfile)
    .map((importer) => (importer === "." ? "package.json" : `${importer}/package.json`))
    .filter((manifest) => !exists(manifest));
}
