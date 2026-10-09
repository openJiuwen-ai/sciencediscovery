// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { fileURLToPath } from "node:url";
import {
  buildContextSources, handwrittenManifestCopies, importersMissingManifests,
  instructionsOf, literalPrefix, lockfileImporters, missingBuildContextSources,
} from "./docker-build-context.mjs";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (name) => readFileSync(join(repository, name), "utf8");
const onDisk = (path) => existsSync(join(repository, path));

test("continuations join and comments drop before an instruction is read", () => {
  assert.deepEqual(instructionsOf("# note\n\nRUN apt-get update \\\n && apt-get install curl\nCOPY a b"),
    ["RUN apt-get update && apt-get install curl", "COPY a b"]);
});
test("COPY sources exclude the destination, flags, and other build stages", () => {
  assert.deepEqual(buildContextSources("COPY --chown=1:1 one two dest\nCOPY --from=builder /opt /opt")
    .map(({ source }) => source), ["one", "two"]);
});
test("RUN bind mounts are context reads unless they name a stage", () => {
  assert.deepEqual(buildContextSources(
    "RUN --mount=type=bind,source=a/uv.lock,target=/t --mount=type=cache,target=/c uv sync\n"
    + "RUN --mount=type=bind,from=builder,source=b,target=/t true",
  ).map(({ source }) => source), ["a/uv.lock"]);
});
test("a glob is checked down to the segments before the first wildcard", () => {
  assert.equal(literalPrefix("packages/*/package.json"), "packages");
  assert.equal(literalPrefix("pnpm-lock.yaml"), "pnpm-lock.yaml");
  assert.equal(literalPrefix("*.json"), ".");
});
test("a source that left the tree is reported with the instruction that reads it", () => {
  const missing = missingBuildContextSources("COPY packages/gone/package.json packages/gone/", () => false);
  assert.deepEqual(missing, ["packages/gone/package.json (COPY packages/gone/package.json packages/gone/)"]);
  assert.deepEqual(missingBuildContextSources("COPY here there", () => true), []);
});
test("lockfile importers are read as workspace directories", () => {
  const lockfile = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      x:\n"
    + "        specifier: ^1\n  packages/schema:\n    dependencies: {}\n\npackages:\n\n  x@1: {}\n";
  assert.deepEqual(lockfileImporters(lockfile), [".", "packages/schema"]);
  assert.deepEqual(importersMissingManifests(lockfile, (path) => path === "package.json"),
    ["packages/schema/package.json"]);
});

// The repository's own files. These are the checks that would have caught the
// stale `packages/agent-runtime/package.json` copy without building the image.
test("every build-context path the product Dockerfile reads exists", () => {
  assert.deepEqual(missingBuildContextSources(read("Dockerfile"), onDisk), []);
});
test("the product Dockerfile names no workspace manifest by hand", () => {
  assert.deepEqual(handwrittenManifestCopies(read("Dockerfile")), []);
});
test("every workspace project in the lockfile still has its manifest", () => {
  const importers = lockfileImporters(read("pnpm-lock.yaml"));
  assert.ok(importers.length > 1, "the lockfile should record the workspace projects");
  assert.deepEqual(importersMissingManifests(read("pnpm-lock.yaml"), onDisk), []);
});
test("local runtime and browser-test data never enter the image context", () => {
  const ignored = new Set(read(".dockerignore").split(/\r?\n/u).map((line) => line.trim()));
  assert.ok(ignored.has(".sciencediscovery-data/"));
  assert.ok(ignored.has(".e2e-data/"));
  assert.ok(ignored.has("data/"));
});
