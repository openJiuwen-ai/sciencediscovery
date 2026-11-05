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

// One interpreter version, stated once. The image pins it with
// `ARG PYTHON_VERSION`; the Windows payload picks it up from the root
// `.python-version`, because start-stack.mjs:309 syncs the whole workspace
// from the repository root and uv reads that file there — a workspace root
// sync does NOT consult the members' own `.python-version`. Both feed the
// same pyvenv.cfg minor-version gate in
// win_desktop/scripts/assemble-backend.mjs:124-139, which hard-fails when a
// bundled venv drifts a minor from its siblings. That gate fires at package
// time, so a one-sided edit here only surfaces on a machine whose default
// interpreter differs from the pinned one — expensive to discover by hand.
const workspaceMembers = () => {
  const block = /\[tool\.uv\.workspace\]\s*members\s*=\s*\[([^\]]*)\]/s.exec(read("pyproject.toml"));
  assert.ok(block, "root pyproject.toml should declare [tool.uv.workspace] members");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

test("the image and the workspace agree on one Python minor", () => {
  const pinned = read(".python-version").trim();
  const image = /\bARG PYTHON_VERSION=([0-9.]+)/.exec(read("Dockerfile"))?.[1];
  assert.match(pinned, /^[0-9]+\.[0-9]+$/, "root .python-version should pin a minor");
  assert.equal(image, pinned, "Dockerfile ARG PYTHON_VERSION drifted from .python-version");

  const members = workspaceMembers();
  assert.equal(members.length, 5, `expected the five sidecar services, got ${members.length}`);
  for (const member of members) {
    assert.ok(onDisk(`${member}/.python-version`), `${member}/.python-version went missing`);
    assert.equal(read(`${member}/.python-version`).trim(), pinned,
      `${member}/.python-version drifted from the root pin`);
  }
});

test("the Python lockfile admits exactly the pinned minor", () => {
  const required = /requires-python = ">=(\d+\.\d+)"/.exec(read("uv.lock"))?.[1];
  assert.equal(required, read(".python-version").trim(),
    "uv.lock requires-python drifted from the interpreter the image installs");
});
