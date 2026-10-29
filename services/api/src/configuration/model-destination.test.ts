// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { modelDestination } from "./model-destination.js";
import { ConfigurationError } from "./validation.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
test("CFG-R02: preset trust is exact protocol, variant, normalized origin and wire path", () => {
  const profile = { model: "custom", apiProtocol: "openai-chat-completions" as const, apiVariant: "openai" as const };
  assert.equal(modelDestination({ ...profile, baseUrl: "https://api.openai.com:443/v1/chat/completions/" }).classification, "trusted_preset");
  for (const changed of [
    { baseUrl: "https://api.openai.com.example.test/v1" }, { baseUrl: "https://api.openai.com:8443/v1" },
    { baseUrl: "https://api.openai.com/other/v1" }, { baseUrl: "https://api.openai.com/v1", apiVariant: "deepseek" as const },
  ]) assert.notEqual(modelDestination({ ...profile, ...changed }).classification, "trusted_preset");
  assert.equal(modelDestination({ ...profile, baseUrl: "http://api.openai.com/v1" }).classification, "public_http");
  for (const address of ["127.1", "localhost", "[::1]", "[::ffff:127.0.0.1]"])
    assert.equal(modelDestination({ ...profile, baseUrl: `http://${address}/v1` }).classification, "loopback");
  for (const address of ["10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.0.1", "[fc00::1]", "[fe80::1]"])
    assert.equal(modelDestination({ ...profile, baseUrl: `http://${address}/v1` }).classification, "private_network");
  for (const url of ["https://user:key@api.openai.com/v1", "https://api.openai.com/v1?key=x", "https://api.openai.com/v1#key"])
    assert.throws(() => modelDestination({ ...profile, baseUrl: url }));
});


test("CFG-R02 invalid endpoint errors identify baseUrl without exposing rejected credentials", () => {
  for (const baseUrl of ["not a URL", "file:///private", "https://user:secret@example.test/v1", "https://example.test/v1?key=secret", "https://example.test/v1#secret"]) {
    assert.throws(() => modelDestination({ baseUrl, model: "test" }), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "INVALID_CONFIGURATION_URL");
      assert.equal(error.field, "baseUrl");
      assert.doesNotMatch(error.message, /secret|private|user:/);
      return true;
    });
  }
});
