// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { invalidToolArguments, missingRequiredArguments, requiredArgumentsOf } from "./arguments.js";

test("a required argument counts as missing when it was left out or sent empty", () => {
  assert.deepEqual(missingRequiredArguments({ description: "Check the CSV" }, ["description", "prompt"]), ["prompt"]);
  assert.deepEqual(missingRequiredArguments({ description: "Check the CSV", prompt: "" }, ["description", "prompt"]), ["prompt"]);
  assert.deepEqual(missingRequiredArguments({ description: "Check the CSV", prompt: "   " }, ["description", "prompt"]), ["prompt"]);
  assert.deepEqual(missingRequiredArguments({ description: "", prompt: "do it" }, ["description", "prompt"]), ["description"]);
  assert.deepEqual(missingRequiredArguments({}, ["description", "prompt"]), ["description", "prompt"]);
  assert.deepEqual(missingRequiredArguments({ description: "Check the CSV", prompt: "do it" }, ["description", "prompt"]), []);
});

test("the tools that declare required arguments are listed by name", () => {
  const required = requiredArgumentsOf([
    { name: "task", requiredArguments: ["description", "prompt"] },
    { name: "read_file" },
    { name: "empty", requiredArguments: [] },
  ]);
  assert.deepEqual(required, { task: ["description", "prompt"] });
  assert.deepEqual(requiredArgumentsOf([]), {});
});

test("an invalid-arguments result tells the model the call can be re-issued", () => {
  const result = invalidToolArguments("Invalid task arguments: \"prompt\" is required.");
  assert.equal(result.isError, true);
  const details = result.details as { ok: boolean; error: { attempts: number; code: string; message: string; retryable: boolean } };
  assert.equal(details.ok, false);
  assert.equal(details.error.code, "INVALID_TOOL_ARGUMENTS");
  assert.equal(details.error.retryable, true);
  assert.equal(details.error.attempts, 1);
  assert.match(details.error.message, /"prompt" is required/);
  assert.deepEqual(JSON.parse(result.content[0]!.text), details);
});
